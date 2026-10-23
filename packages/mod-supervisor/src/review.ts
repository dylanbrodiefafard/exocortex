import { type JsonValue, loadPrompt, type ModuleContext, SIDECAR_MAX_TOKENS, startAndEnd } from "@exocortex/core";
import { type Static, Type } from "typebox";
import { fitDiff } from "./evidence.ts";
import { changedSignatures, usesOf } from "./review-context.ts";
import type { SupervisorSettings } from "./settings.ts";
import { diffHeaderPath, parseDiff } from "./signals.ts";

const FIND_PROMPT = loadPrompt(new URL("../prompts/review-find.v3.md", import.meta.url));
const VERIFY_PROMPT = loadPrompt(new URL("../prompts/review-verify.v2.md", import.meta.url));

const SEVERITIES = ["high", "medium", "low"] as const;
type Severity = (typeof SEVERITIES)[number];

const FindingsSchema = Type.Object({
	findings: Type.Array(
		Type.Object({
			file: Type.String(),
			quote: Type.String(),
			title: Type.String(),
			scenario: Type.String(),
			severity: Type.Union(SEVERITIES.map((s) => Type.Literal(s))),
		}),
	),
});

const CheckSchema = Type.Object({
	verdict: Type.Union([Type.Literal("real"), Type.Literal("not_a_bug"), Type.Literal("unsure")]),
	reason: Type.String(),
	scenario: Type.String(),
});

type Proposed = Static<typeof FindingsSchema>["findings"][number];

/** A bug the review kept: what it is, where, and how many passes found it. */
export interface Finding {
	readonly file: string;
	readonly quote: string;
	readonly title: string;
	readonly scenario: string;
	readonly severity: Severity;
	/** Passes that reported it, of {@link ReviewResult.passes}. */
	readonly votes: number;
	/** Why the check found it real. */
	readonly reason: string;
}

/** What a review found, and what it threw away on the way, for the trace (D-097). */
export interface ReviewResult {
	readonly findings: readonly Finding[];
	/** Passes asked, and those that answered. */
	readonly passes: number;
	readonly answered: number;
	/** Findings the passes proposed, those that quoted a line the change added or a caller it left behind, and the distinct bugs among them. */
	readonly proposed: number;
	readonly anchored: number;
	readonly distinct: number;
	/** Bugs dropped because an earlier review of this task already reported them. */
	readonly repeated: number;
	/** Each bug that was checked, and how. */
	readonly checked: readonly {
		readonly title: string;
		readonly votes: number;
		readonly verdict: string;
		readonly reason: string;
	}[];
}

/** What a review reads: the request (none for a review asked for without one), and the change. */
export interface ReviewInput {
	readonly requests: readonly string[];
	/** `git diff` of the change with function context, new files included. */
	readonly diff: string;
	/** Keys ({@link findingKey}) of bugs already reported in this task: not reported again. */
	readonly reported: ReadonlySet<string>;
	/** How much of the change a pass reads, in characters: sized from the context window. */
	readonly maxChars: number;
}

/**
 * A review is not timed (D-097): it runs in the background, and the user stops it with Escape or a
 * new message. The pool's default deadline would cut a slow pass short.
 */
const NO_TIME_LIMIT = Number.MAX_SAFE_INTEGER;
const PASS_TEMPERATURE = 0.7;
const FIRST_PASS_TEMPERATURE = 0.2;
/** Fewest characters, spaces aside, of a quoted line: shorter ones are in every diff. */
const MIN_QUOTE_CHARS = 12;
/** Titles this alike, in the same file, are one bug told twice. */
const SAME_BUG_SIMILARITY = 0.5;
/**
 * Passes that must report a bug before it is checked (Cursor's Bugbot: majority voting drops bugs
 * one pass found). When fewer passes answered, all of them.
 */
const MIN_VOTES = 2;
const NO_REQUEST = "(No request was given: review the change for bugs on its own terms.)";
const NO_USES = "(none looked up)";
/** Shares of a review prompt's budget for the request and for the uses; the change gets the rest. */
const REQUEST_SHARE = 0.15;
const USES_SHARE = 0.1;

/**
 * Reviews a change for bugs (D-097). Several passes read it, each with its files in another order,
 * and propose findings. Code keeps those that quote a line the change added, or a line of a caller
 * it left behind that the passes were shown (D-107), groups the ones that
 * describe the same bug, and drops those fewer than two passes found or that an earlier review of
 * the task reported. A check call then tries to disprove each one left; only those it finds real
 * are kept, most severe first. Undefined when no pass
 * answered.
 */
export async function reviewChange(
	ctx: ModuleContext,
	settings: Pick<SupervisorSettings, "reviewPasses" | "reviewMaxFindings">,
	input: ReviewInput,
	signal: AbortSignal,
): Promise<ReviewResult | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	const sections = fileSections(input.diff);
	if (sections.length === 0) return emptyResult(settings.reviewPasses);
	// The request, the uses and the change share one budget (D-107): the change gets what the others leave.
	const request = startAndEnd(
		input.requests.length > 0 ? input.requests.join("\n\n") : NO_REQUEST,
		Math.floor(input.maxChars * REQUEST_SHARE),
		{ mark: "… (middle of a long request left out) …", startShare: 0.75 },
	);
	const uses = await usesOf(ctx, changedSignatures(input.diff), input.diff, signal);
	const usesView = {
		uses_label: "Other places that use a function whose declaration the change rewrote or removed",
		uses: startAndEnd(uses?.text ?? NO_USES, Math.floor(input.maxChars * USES_SHARE)),
	};
	const diffRoom = Math.max(1_000, input.maxChars - request.length - usesView.uses.length);
	const run = (content: string, temperature: number) => ({
		module: "supervisor",
		kind: "judge" as const,
		priority: "critical" as const,
		timeoutMs: NO_TIME_LIMIT,
		signal,
		request: {
			messages: [{ role: "user" as const, content }],
			maxTokens: SIDECAR_MAX_TOKENS,
			temperature,
		},
	});

	const passes = await Promise.all(
		Array.from({ length: settings.reviewPasses }, async (_, pass) => {
			const order = rotate(sections, Math.floor((pass * sections.length) / settings.reviewPasses));
			const result = await pool.run({
				...run(
					FIND_PROMPT.render({
						request,
						diff: fitDiff(order.map((s) => s.text).join("\n"), diffRoom),
						max_findings: String(Math.max(settings.reviewMaxFindings, 3)),
						...usesView,
					}),
					pass === 0 ? FIRST_PASS_TEMPERATURE : PASS_TEMPERATURE,
				),
				schema: FindingsSchema,
				schemaName: "review_findings",
			});
			if (!result.ok) ctx.log(`review pass ${pass + 1} ${result.outcome}: ${result.error}`);
			return result.ok ? result.value.findings : undefined;
		}),
	);
	const answered = passes.filter((p) => p !== undefined);
	if (answered.length === 0) return undefined;

	const added = addedLines(input.diff);
	const callers = uses?.lines ?? new Map<string, ReadonlySet<string>>();
	const anchored = passes.map((found) => (found ?? []).flatMap((f) => anchor(f, added, callers)));
	const buckets = group(anchored);
	const fresh = buckets.filter((b) => !input.reported.has(findingKey(b.finding)));
	const candidates = fresh
		.filter((b) => b.passes.size >= Math.min(MIN_VOTES, answered.length))
		.sort(byWeight)
		.slice(0, settings.reviewMaxFindings * 2);

	const checked = await Promise.all(
		candidates.map(async (bucket) => {
			const finding = bucket.finding;
			const section = sections.find((s) => s.path === finding.file);
			// A finding about a caller the change left behind is checked against the whole change.
			const shown = section
				? { diff_label: `The change to ${finding.file}`, diff: fitDiff(section.text, diffRoom) }
				: {
						diff_label: `The whole change (the report is about ${finding.file}, a place it left behind)`,
						diff: fitDiff(input.diff, diffRoom),
					};
			const result = await pool.run({
				...run(
					VERIFY_PROMPT.render({
						request,
						file: finding.file,
						...shown,
						quote: finding.quote,
						title: finding.title,
						scenario: finding.scenario,
						...usesView,
					}),
					FIRST_PASS_TEMPERATURE,
				),
				schema: CheckSchema,
				schemaName: "review_check",
			});
			if (!result.ok) ctx.log(`review check ${result.outcome}: ${result.error}`);
			return { bucket, check: result.ok ? result.value : undefined };
		}),
	);

	const findings = checked
		.filter(({ check }) => check?.verdict === "real")
		.map(({ bucket, check }) => ({
			...bucket.finding,
			scenario: check?.scenario.trim() || bucket.finding.scenario,
			votes: bucket.passes.size,
			reason: check?.reason.trim() ?? "",
		}))
		.sort((x, y) => SEVERITIES.indexOf(x.severity) - SEVERITIES.indexOf(y.severity) || y.votes - x.votes)
		.slice(0, settings.reviewMaxFindings);
	return {
		findings,
		passes: settings.reviewPasses,
		answered: answered.length,
		proposed: answered.flat().length,
		anchored: anchored.flat().length,
		distinct: buckets.length,
		repeated: buckets.length - fresh.length,
		checked: checked.map(({ bucket, check }) => ({
			title: bucket.finding.title,
			votes: bucket.passes.size,
			verdict: check?.verdict ?? "no_answer",
			reason: check?.reason ?? "",
		})),
	};
}

/** The trace's view of a review. */
export function reviewRecord(result: ReviewResult): { readonly [key: string]: JsonValue } {
	return {
		passes: result.passes,
		answered: result.answered,
		proposed: result.proposed,
		anchored: result.anchored,
		distinct: result.distinct,
		repeated: result.repeated,
		checked: result.checked.map((c) => ({ ...c })),
		kept: result.findings.map((f) => ({ file: f.file, title: f.title, severity: f.severity, votes: f.votes })),
	};
}

/** The follow-up to the agent: each finding to check, with leave to say it is not a bug. */
export function reviewMessage(findings: readonly Finding[]): string {
	return [
		`A review of your changes found ${findings.length === 1 ? "a possible bug" : `${findings.length} possible bugs`}. Check each one against the code. Fix the ones that are real; for any that is not, say why.`,
		...findings.map((f, i) =>
			[`${i + 1}. ${f.file}: ${f.title}`, `   Line: ${f.quote.trim()}`, `   How it fails: ${f.scenario.trim()}`].join(
				"\n",
			),
		),
	].join("\n");
}

/** One line on what a review found, for the status line and the notice beside the follow-up. */
export function reviewSummary(result: ReviewResult): string {
	const found = result.findings;
	if (found.length === 0) {
		return `review found nothing that held up (${result.distinct} proposed by ${result.answered}/${result.passes} passes)`;
	}
	const each = found.map((f) => `${f.severity}, ${f.votes}/${result.answered} passes`).join("; ");
	return `review found ${found.length === 1 ? "a possible bug" : `${found.length} possible bugs`} (${each})`;
}

interface Section {
	readonly path: string;
	readonly text: string;
}

/** A diff's files, each with its own text. */
export function fileSections(diff: string): Section[] {
	return diff
		.split(/^(?=diff --git )/m)
		.map((text) => ({ path: diffHeaderPath(text.split("\n", 1)[0] ?? ""), text: text.trimEnd() }))
		.filter((s): s is Section => s.path !== undefined);
}

function rotate<T>(items: readonly T[], by: number): T[] {
	return [...items.slice(by), ...items.slice(0, by)];
}

function emptyResult(passes: number): ReviewResult {
	return { findings: [], passes, answered: 0, proposed: 0, anchored: 0, distinct: 0, repeated: 0, checked: [] };
}

function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Each file's added lines, normalized. */
function addedLines(diff: string): Map<string, Set<string>> {
	return new Map(parseDiff(diff).map((file) => [file.path, new Set(file.added.map(normalize))]));
}

/**
 * The finding pinned to a line the change added, or to a line of a caller it left behind that the
 * passes were shown (D-107), or nothing: one that quotes neither is about code the change did not
 * write or touch, or about nothing in it. A finding that names the wrong file is moved to the one
 * file whose lines have its quote.
 */
function anchor(
	finding: Proposed,
	added: ReadonlyMap<string, ReadonlySet<string>>,
	callers: ReadonlyMap<string, ReadonlySet<string>>,
): Proposed[] {
	const quote = normalize(finding.quote.replace(/^\+/, ""));
	if (quote.replace(/\s/g, "").length < MIN_QUOTE_CHARS) return [];
	const file = normalizePath(finding.file);
	for (const lines of [added, normalizedLines(callers)]) {
		if (lines.get(file)?.has(quote)) return [{ ...finding, file, quote }];
		const holders = [...lines].filter(([, held]) => held.has(quote)).map(([path]) => path);
		if (holders.length === 1 && holders[0] !== undefined) return [{ ...finding, file: holders[0], quote }];
	}
	return [];
}

function normalizedLines(lines: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
	return new Map([...lines].map(([path, held]) => [normalizePath(path), new Set([...held].map(normalize))]));
}

function normalizePath(path: string): string {
	return path.trim().replace(/^[ab]\//, "");
}

interface Bucket {
	readonly finding: Proposed;
	readonly passes: Set<number>;
}

/** Findings that describe the same bug, across passes: the same line, or the same file and much the same title. */
function group(passes: readonly (readonly Proposed[])[]): Bucket[] {
	const buckets: Bucket[] = [];
	passes.forEach((found, pass) => {
		for (const finding of found) {
			const same = buckets.find(
				(b) =>
					b.finding.file === finding.file &&
					(b.finding.quote === finding.quote || similarity(b.finding.title, finding.title) >= SAME_BUG_SIMILARITY),
			);
			if (!same) buckets.push({ finding, passes: new Set([pass]) });
			else {
				same.passes.add(pass);
				// The most severe telling stands for the bucket.
				if (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(same.finding.severity)) {
					buckets[buckets.indexOf(same)] = { finding, passes: same.passes };
				}
			}
		}
	});
	return buckets;
}

/** Word-set overlap of two titles (Jaccard), on words of three letters or more. */
export function similarity(a: string, b: string): number {
	const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
	const x = words(a);
	const y = words(b);
	if (x.size === 0 || y.size === 0) return 0;
	const shared = [...x].filter((w) => y.has(w)).length;
	return shared / (x.size + y.size - shared);
}

/** What makes a bug the same one in a later review of the task: its file and the line it quotes. */
export function findingKey(finding: { readonly file: string; readonly quote: string }): string {
	return `${finding.file}\n${normalize(finding.quote)}`;
}

function byWeight(x: Bucket, y: Bucket): number {
	return (
		y.passes.size - x.passes.size || SEVERITIES.indexOf(x.finding.severity) - SEVERITIES.indexOf(y.finding.severity)
	);
}
