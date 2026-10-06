import { createHash } from "node:crypto";
import {
	callKey,
	cleanTerminalOutput,
	type ExoModule,
	type FileEdit,
	failureKey,
	fileEdits,
	firstErrorLine,
	isBenignExit,
	type JsonValue,
	loadPrompt,
	loopHistoryLength,
	type ModuleContext,
	maskedFailure,
	outcomeOf,
	SIDECAR_MAX_TOKENS,
	startAndEnd,
	type ToolOutcome,
	type ToolResultDraft,
	type ToolRewrite,
	trailingLoop,
	ungroundedReferences,
	verifyingRun,
} from "@exocortex/core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { parseSettings, type TriageSettings } from "./settings.ts";
import { errorSites, renderSites } from "./sites.ts";

export const TRIAGE_ID = "triage";

const DIAGNOSE_PROMPT = loadPrompt(new URL("../prompts/diagnose.v4.md", import.meta.url));
const HYPOTHESIS_PROMPT = loadPrompt(new URL("../prompts/hypothesis.v3.md", import.meta.url));
/** Diagnostic angles for parallel hypotheses (PlanSearch-style diversity, research R6.1). */
const FRAMES = loadPrompt(new URL("../prompts/frames.v1.md", import.meta.url))
	.text.split("\n")
	.filter((line) => line.startsWith("- "))
	.map((line) => line.slice(2).trim());

const HypothesisSchema = Type.Object({
	hypothesis: Type.String({ maxLength: 400 }),
	check: Type.String({ maxLength: 400 }),
});
const HYPOTHESIS_TEMPERATURE = 0.8;
/** Hypotheses or hints sharing more of their words than this are duplicates. */
const DUPLICATE_SIMILARITY = 0.6;

const DiagnosisSchema = Type.Object({
	diagnosis: Type.String({ maxLength: 400 }),
	next_action: Type.String({ maxLength: 400 }),
});

/** The request is where the expected behaviour is written down: a diagnosis reads most of it. */
const GOAL_CHARS = 6_000;
/** The user's latest messages are the goal (D-082): the request, and what they said about it since. */
const MAX_GOAL_MESSAGES = 6;
/** An older message is left out when less than this is left for it. */
const MIN_GOAL_PART = 200;
const RECENT_COMMANDS = 6;
/** Edits kept, and what the sidecar is shown of the ones a failure outlived. */
const MAX_EDITS = 40;
const SHOWN_EDITS = 6;
const EDIT_TEXT_CHARS = 500;
const MAX_SITES = 4;
const EXCERPT_CONTEXT_LINES = 12;
const EXCERPT_TAIL_LINES = 8;
const EXCERPT_CHARS = 4_000;
const MAX_LINE_CHARS = 300;
/**
 * Failures and commands remembered at once. No user message ends the counting any more (D-082),
 * and all of it is saved with the session, so the ones not seen for longest are dropped.
 */
const MAX_FAILURES = 64;
const MAX_COMMANDS = 64;
/** Commands remembered as having reported one failure. */
const MAX_FAILURE_COMMANDS = 8;
/** A sidecar call with less time than this left is not started. */
const MIN_SIDECAR_MS = 400;
/** Hints remembered per failure, whatever the cap on calls is set to. */
const MAX_KEPT_HINTS = 16;

/** What is kept of one failure, by what it reported ({@link failureIdentity}). Saved with the session. */
const FailureSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 64 }),
	/** Times it was seen since it was first seen, or since a command that reported it last passed. */
	count: Type.Integer({ minimum: 1 }),
	/** Edits made when its current unbroken run of sightings began: it outlived every later one. */
	since: Type.Integer({ minimum: 0 }),
	/** Edits made when it was last seen. */
	seen: Type.Integer({ minimum: 0 }),
	/** Its count when the user last spoke: a hand-over is asked for again only after more failures. */
	atUser: Type.Integer({ minimum: 0 }),
	/** Sidecar calls made for hints (the cap counts calls, shown or not). */
	hintCalls: Type.Integer({ minimum: 0 }),
	/** Hints the agent was shown and that are still in its context. */
	hints: Type.Array(Type.String({ maxLength: 700 }), { maxItems: MAX_KEPT_HINTS }),
	/** Whether hypotheses were asked for. */
	hypothesized: Type.Boolean(),
	/** The commands that reported it ({@link commandIdentity}). */
	by: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: MAX_FAILURE_COMMANDS }),
});
type Failure = Static<typeof FailureSchema>;

/** What `saveState` is given (T6): enough to go on counting after a reload. Edits' text and loops are not kept. */
const SavedSchema = Type.Object({
	v: Type.Literal(1),
	edited: Type.Integer({ minimum: 0 }),
	failures: Type.Array(FailureSchema, { maxItems: MAX_FAILURES }),
	last: Type.Array(Type.Tuple([Type.String({ maxLength: 64 }), Type.String({ maxLength: 64 })]), {
		maxItems: MAX_COMMANDS,
	}),
});

interface State {
	/** Every failure being counted, the one seen longest ago first. */
	readonly failures: Map<string, Failure>;
	/** The failure each command last reported. A failure stands while it is some command's latest. */
	readonly last: Map<string, string>;
	readonly recent: string[];
	/** The latest file edits, each with its number in the session. */
	readonly edits: { readonly seq: number; readonly edit: FileEdit }[];
	/** Edits made so far. */
	edited: number;
	/** Tool calls since the user last spoke, each with its result, as far back as a loop can reach. */
	calls: { readonly key: string; readonly label: string }[];
	/** Notices given for the loop the calls now end in: 0 none, 1 the warning, 2 the hand-over. */
	loopLevel: number;
}

/** What `onToolResult` made of the latest result; the rewrite speaks only for that one. */
interface Observation {
	readonly key: string;
	readonly sighting: Sighting | undefined;
}

/** One sighting of a failure. */
interface Sighting {
	readonly id: string;
	readonly count: number;
	/**
	 * Whether the failure stood until now: it was the last thing one of its commands reported. If
	 * not, the command reported other errors in between and these are back.
	 */
	readonly standing: boolean;
	/** The edits numbered above this came between the sightings the notice compares. */
	readonly editsFrom: number;
	readonly masked: boolean;
}

/**
 * Error triage (brief §6.3, gated as research R3.1 recommends): on a first failure only surface a
 * buried first error (deterministic); on a repeat append a runtime notice and, optionally, a
 * grounded two-sentence sidecar diagnosis; past the loop threshold the notice becomes a stronger,
 * still advisory, warning. Never blocks a tool call.
 *
 * A repeat is a failure that reports the same errors as one seen earlier (D-073): fewer failing
 * tests or a different message is a new failure, however alike its first line. The diagnosis
 * reads what the main model is too close to weigh: the request, the code the errors point at, and
 * the edits the failure outlived.
 *
 * What it says is what it can know (D-082):
 * - A failure is forgotten when a command that reported it passes, so a regression is a first
 *   failure again. A message from the user does not end anything.
 * - "The edits made since did not change it" is said only of a failure that stood: one that was
 *   the last thing its command reported. One that went away and came back is described as that.
 * - Failures are counted when their results come in. What rests on the model having read
 *   something (a hint, a loop notice) changes when the host says the rewrite was used.
 * - Counts are saved with the session; hints are forgotten when a compaction removes them.
 *
 * It also notices going round in circles without an error (D-069): the same call returning the
 * same result, or a short cycle of calls ending the same way each round. One notice when the loop
 * is established, one more that tells the agent to hand over to the user if it goes on.
 */
export function createTriage(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	/** The user's latest messages, oldest first. */
	const asked: string[] = [];
	const state = restore(ctx.savedState) ?? newState();
	let observed: Observation | undefined;
	/** Whether what is saved with the session changed since it was last saved. */
	let unsaved = false;
	let repeats = 0;
	let hintsGiven = 0;
	let loops = 0;
	/** Twice the threshold is where a notice becomes the hand-over. */
	const handOverAt = settings.loopThreshold * 2;
	/**
	 * The longest one result is held for sidecar calls, on this module's own clock: the notice must
	 * be back before the host's deadline, which the pool's timeouts do not promise (their clock
	 * stops while a call waits for a slot).
	 */
	const holdMs = Math.max(settings.hintTimeoutMs, settings.hypothesisTimeoutMs);

	return {
		id: TRIAGE_ID,

		onUserTurn(turn) {
			if (turn.origin !== "user") return;
			if (turn.text.trim() !== "") asked.push(startAndEnd(turn.text.trim(), GOAL_CHARS));
			if (asked.length > MAX_GOAL_MESSAGES) asked.shift();
			// A loop is the agent's own doing: a call the user asked for again is not part of one.
			state.calls = [];
			state.loopLevel = 0;
			for (const failure of state.failures.values()) {
				if (failure.atUser === failure.count) continue;
				failure.atUser = failure.count;
				unsaved = true;
			}
			save();
		},

		onToolResult(tool) {
			const command = commandOf(tool.input, tool.toolName);
			const outcome = isFailure(tool)
				? `exit ${tool.exitCode ?? "error"}`
				: isMasked(tool)
					? "errors in the output (exit code hidden by a pipe)"
					: "ok";
			state.recent.push(`${command} → ${outcome}`);
			if (state.recent.length > RECENT_COMMANDS) state.recent.shift();
			for (const edit of fileEdits(tool, EDIT_TEXT_CHARS) ?? []) {
				state.edited += 1;
				state.edits.push({ seq: state.edited, edit });
				if (state.edits.length > MAX_EDITS) state.edits.shift();
			}
			const key = callKey(tool.toolName, tool.input, tool.output);
			state.calls.push({ key, label: command });
			if (state.calls.length > loopHistoryLength(handOverAt)) state.calls.shift();
			// The loop ended: a later one starts over with its first notice.
			if (!currentLoop()) state.loopLevel = 0;
			observed = { key, sighting: sightingOf(tool) };
			save();
		},

		async rewriteToolResult(draft, signal) {
			// Only the result just counted: its count is what the notice states.
			if (observed?.key !== callKey(draft.toolName, draft.input, draft.output)) return undefined;
			const { sighting } = observed;
			if (!sighting) return noProgress(draft);
			if (sighting.count === 1) return surfaced(draft);
			const failure = state.failures.get(sighting.id);
			const outlived = state.edits.filter((e) => e.seq > sighting.editsFrom).map((e) => e.edit);
			const notice = repeatNotice({
				count: sighting.count,
				sinceUser: sighting.count - (failure?.atUser ?? 0),
				errorLine: firstErrorLine(draft.output)?.line,
				edited: [...new Set(outlived.map((e) => e.path))],
				standing: sighting.standing,
				masked: sighting.masked,
				loopThreshold: settings.loopThreshold,
				handOverAt,
			});
			const text = `${draft.current}\n${notice}`;
			const advice = failure && (await advise(failure, sighting, draft, outlived, signal));
			save();
			if (advice?.hypotheses) {
				return {
					text: `${text}\n${renderHypotheses(advice.hypotheses)}`,
					note: `repeat ${sighting.count} + ${advice.hypotheses.length} hypotheses`,
				};
			}
			const hint = advice?.hint;
			if (!failure || !hint) return { text, note: `repeat ${sighting.count}` };
			return {
				text: `${text}\n[exo triage hint: ${hint}]`,
				// The eval report reads "+ hint" to follow each hint's outcome (D-057).
				note: `repeat ${sighting.count} + hint`,
				// A hint counts as given, and is one not to repeat, once the model has it.
				commit: () => {
					hintsGiven += 1;
					failure.hints = [...failure.hints, hint].slice(-MAX_KEPT_HINTS);
					unsaved = true;
					save();
				},
			};
		},

		onCompacted() {
			// Hints, hypotheses and loop notices were in the span that is gone: there is nothing left
			// to repeat. The failures are still failing, so the counts stay.
			state.loopLevel = 0;
			for (const failure of state.failures.values()) {
				if (failure.hints.length === 0 && failure.hintCalls === 0 && !failure.hypothesized) continue;
				failure.hints = [];
				failure.hintCalls = 0;
				failure.hypothesized = false;
				unsaved = true;
			}
			save();
		},

		status() {
			if (repeats === 0 && loops === 0) return TRIAGE_ID;
			return `${TRIAGE_ID} (${repeats} repeats, ${hintsGiven} hints${loops > 0 ? `, ${loops} loops` : ""})`;
		},
	};

	/** Keeps the counts with the session (T6), when they changed. */
	function save(): void {
		if (!unsaved) return;
		unsaved = false;
		ctx.saveState({
			v: 1,
			edited: state.edited,
			failures: [...state.failures.values()].map((f) => ({ ...f, hints: [...f.hints], by: [...f.by] })),
			last: [...state.last],
		});
	}

	/**
	 * Counts a failing result, and forgets what a passing one shows to be fixed. Done here and not
	 * in the rewrite: a failure happened whether or not the host had time to ask for a notice.
	 */
	function sightingOf(tool: ToolOutcome): Sighting | undefined {
		const masked = isMasked(tool);
		const command = commandIdentity(tool);
		if (!masked && (!isFailure(tool) || isBenign(tool, settings))) {
			// An exit code a pipe hid, and a benign exit 1, say nothing either way.
			if (!isFailure(tool) && outcomeOf(tool) === "passed") forget(command);
			return undefined;
		}
		const id = failureIdentity(tool);
		const known = state.failures.get(id);
		const standing = known?.by.some((c) => state.last.get(c) === id) ?? false;
		const now = state.edited;
		const failure: Failure = known
			? { ...known, count: known.count + 1, since: standing ? known.since : now, seen: now }
			: { id, count: 1, since: now, seen: now, atUser: 0, hintCalls: 0, hints: [], hypothesized: false, by: [] };
		if (!failure.by.includes(command)) failure.by = [...failure.by, command].slice(-MAX_FAILURE_COMMANDS);
		// Newest last, so the ones dropped are the ones not seen for longest.
		state.failures.delete(id);
		state.failures.set(id, failure);
		state.last.delete(command);
		state.last.set(command, id);
		dropOldest(state.failures, MAX_FAILURES);
		dropOldest(state.last, MAX_COMMANDS);
		unsaved = true;
		if (!known) return { id, count: 1, standing: true, editsFrom: now, masked };
		repeats += 1;
		return { id, count: failure.count, standing, editsFrom: standing ? known.since : known.seen, masked };
	}

	/** The command passed (T1): what it reported is fixed, and seeing it again is a new failure. */
	function forget(command: string): void {
		if (state.last.delete(command)) unsaved = true;
		for (const [id, failure] of state.failures) {
			if (!failure.by.includes(command)) continue;
			state.failures.delete(id);
			unsaved = true;
		}
	}

	function currentLoop() {
		return settings.loops
			? trailingLoop(
					state.calls.map((c) => c.key),
					settings.loopThreshold,
				)
			: undefined;
	}

	/**
	 * A result that is not a failure, at the end of a loop: says so once, and once more at twice the
	 * threshold. Failures in a loop get their own notice above, so the level only rises here.
	 */
	function noProgress(draft: ToolResultDraft): ToolRewrite | undefined {
		const loop = currentLoop();
		if (!loop) return undefined;
		const level = loop.repeats >= handOverAt ? 2 : 1;
		if (level <= state.loopLevel) return undefined;
		const cycle = state.calls.slice(-loop.period).map((c) => c.label);
		return {
			text: `${draft.current}\n${loopNotice(loop.repeats, cycle, level === 2)}`,
			note: `no progress ×${loop.repeats}${loop.period > 1 ? ` (cycle of ${loop.period})` : ""}`,
			// Each level is said once, and it has been said when the model has it.
			commit: () => {
				state.loopLevel = Math.max(state.loopLevel, level);
				loops += 1;
			},
		};
	}

	/** A first failure whose first error is far down what the model will read: point at it. */
	function surfaced(draft: ToolResultDraft) {
		const shown = firstErrorLine(draft.current);
		if (!shown || shown.index < settings.buriedAfterLines) return undefined;
		return {
			text: `[exo triage: first error (line ${shown.index + 1} below): ${clip(shown.line)}]\n${draft.current}`,
			note: "surfaced the first error",
		};
	}

	function isMasked(tool: Parameters<typeof maskedFailure>[0]): boolean {
		return settings.maskedFailures && maskedFailure(tool);
	}

	/** The user's latest messages within {@link GOAL_CHARS}, the newest given the most room. */
	function goal(): string {
		const parts: string[] = [];
		let left = GOAL_CHARS;
		for (let i = asked.length - 1; i >= 0; i--) {
			// Two thirds of what is left, so there is always room for what was said before.
			const share = i > 0 ? Math.ceil((left * 2) / 3) : left;
			if (parts.length > 0 && share < MIN_GOAL_PART) break;
			const part = startAndEnd(asked[i] ?? "", share);
			parts.unshift(part);
			left -= part.length;
		}
		return parts.length > 1 ? parts.map((part, i) => `[${i + 1}] ${part}`).join("\n\n") : (parts[0] ?? "");
	}

	/** What a sidecar is given to read, and the text its answer is checked against. */
	function evidenceFor(sighting: Sighting, draft: ToolResultDraft, outlived: readonly FileEdit[]) {
		const excerpt = errorExcerpt(draft.output);
		const request = goal();
		const vars = {
			history: sighting.standing
				? `the command below has now reported the same errors ${sighting.count} times, with nothing else reported in between: whatever was changed since did not change them.`
				: `the command below has reported the same errors ${sighting.count} times, but not in a row: it reported something else in between, and now these errors are back.`,
			edits_heading: sighting.standing
				? "Edits made since this run of the same failure began (it failed the same way after them)"
				: "Edits made since this failure was last seen (something else was reported in between, then these errors again)",
			goal: request || "(unknown)",
			recent: state.recent.map((r) => `- ${r}`).join("\n") || "(none)",
			command: commandOf(draft.input, draft.toolName),
			exit_code: sighting.masked ? "hidden by a pipe" : draft.exitCode === null ? "unknown" : String(draft.exitCode),
			excerpt,
			edits: renderEdits(outlived),
			code:
				renderSites(errorSites(excerpt, ctx.cwd, MAX_SITES), ctx.cwd) ||
				"(the output names no line in a file of this workspace)",
		};
		return { vars, text: `${draft.output}\n${request}\n${state.recent.join("\n")}\n${vars.edits}\n${vars.code}` };
	}

	type Evidence = ReturnType<typeof evidenceFor>;

	/**
	 * The sidecar's part of a notice: hypotheses at the loop threshold, else a hint. It answers by
	 * {@link holdMs} or the host's signal at the latest (T5) and never rejects, since the notice
	 * does not depend on it. A call still running then is cancelled and its answer dropped.
	 */
	async function advise(
		failure: Failure,
		sighting: Sighting,
		draft: ToolResultDraft,
		outlived: readonly FileEdit[],
		signal: AbortSignal,
	): Promise<{ readonly hypotheses?: Hypothesis[]; readonly hint?: string } | undefined> {
		if (signal.aborted || !ctx.pool() || (!settings.sidecar && settings.hypotheses === 0)) return undefined;
		const deadline = Date.now() + holdMs;
		const left = () => deadline - Date.now();
		const hold = new AbortController();
		const work = async () => {
			const evidence = evidenceFor(sighting, draft, outlived);
			const hypotheses =
				sighting.count >= settings.loopThreshold ? await hypothesize(failure, evidence, hold.signal, left) : undefined;
			if (hypotheses) return { hypotheses };
			const hint = await diagnose(failure, evidence, hold.signal, left);
			return hint === undefined ? undefined : { hint };
		};
		const report = (error: unknown) => {
			ctx.log(`sidecar advice failed: ${String(error)}`);
			return undefined;
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stopped = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), holdMs);
			signal.addEventListener("abort", () => resolve(undefined), { once: true });
		});
		try {
			// Caught on the work itself: it may fail after the wait for it is over.
			return await Promise.race([work().catch(report), stopped]);
		} finally {
			clearTimeout(timer);
			hold.abort();
		}
	}

	/**
	 * Phase 6 (D-015): K isolated sidecars, each from a different angle, in parallel. Only distinct,
	 * grounded hypotheses that name a check are kept, and only a list of 2+ is shown: no LLM picks a
	 * winner (research R6.1).
	 */
	async function hypothesize(failure: Failure, evidence: Evidence, signal: AbortSignal, left: () => number) {
		const pool = ctx.pool();
		if (settings.hypotheses === 0 || !pool || failure.hypothesized) return undefined;
		// Asked once, shown or not: it is several calls each time.
		failure.hypothesized = true;
		unsaved = true;
		ctx.progress("Considering other causes of the repeated failure…");
		const results = await Promise.all(
			FRAMES.slice(0, settings.hypotheses).map((frame) =>
				pool.run({
					module: TRIAGE_ID,
					priority: "interactive",
					timeoutMs: Math.min(settings.hypothesisTimeoutMs, left()),
					signal,
					schema: HypothesisSchema,
					schemaName: "hypothesis",
					request: {
						messages: [{ role: "user", content: HYPOTHESIS_PROMPT.render({ ...evidence.vars, frame }) }],
						maxTokens: SIDECAR_MAX_TOKENS,
						temperature: HYPOTHESIS_TEMPERATURE,
						thinking: settings.thinking,
					},
				}),
			),
		);
		const candidates = results.flatMap((r) =>
			r.ok && r.value.hypothesis.trim() !== "" && r.value.check.trim() !== ""
				? [{ hypothesis: clip(r.value.hypothesis.trim(), 300), check: clip(r.value.check.trim(), 200) }]
				: [],
		);
		const grounded = candidates.filter(
			(c) => ungroundedReferences(`${c.hypothesis} ${c.check}`, evidence.text, ctx.cwd).length === 0,
		);
		const distinct = dedupe(grounded);
		ctx.log(`hypotheses: ${candidates.length} answered, ${grounded.length} grounded, ${distinct.length} distinct`);
		return distinct.length >= 2 ? distinct : undefined;
	}

	async function diagnose(failure: Failure, evidence: Evidence, signal: AbortSignal, left: () => number) {
		const pool = ctx.pool();
		if (!settings.sidecar || !pool || failure.hintCalls >= settings.maxHintsPerSignature) return undefined;
		// The hypotheses used the time: the notice goes without a hint, and no call is spent on one.
		if (signal.aborted || left() < MIN_SIDECAR_MS) return undefined;
		failure.hintCalls += 1;
		unsaved = true;
		const earlier = [...failure.hints];
		ctx.progress("Diagnosing the repeated failure…");
		const result = await pool.run({
			module: TRIAGE_ID,
			priority: "interactive",
			timeoutMs: Math.min(settings.hintTimeoutMs, left()),
			signal,
			schema: DiagnosisSchema,
			schemaName: "diagnosis",
			request: {
				messages: [
					{
						role: "user",
						content: DIAGNOSE_PROMPT.render({
							...evidence.vars,
							previous: earlier.map((h) => `- ${h}`).join("\n") || "(none)",
						}),
					},
				],
				maxTokens: SIDECAR_MAX_TOKENS,
				thinking: settings.thinking,
			},
		});
		if (!result.ok) {
			ctx.log(`diagnosis ${result.outcome}: ${result.error}`);
			return undefined;
		}
		const hint = [result.value.diagnosis, result.value.next_action]
			.map((s) => s.trim())
			.filter(Boolean)
			.join(" ");
		if (hint === "") return undefined;
		const ungrounded = ungroundedReferences(hint, evidence.text, ctx.cwd);
		if (ungrounded.length > 0) {
			ctx.log(`dropped a hint naming unknown ${ungrounded.join(", ")}`);
			return undefined;
		}
		// The earlier hint did not stop the failure, so saying it again cannot help (D-061).
		if (earlier.some((h) => similarity(wordSet(h), wordSet(hint)) > DUPLICATE_SIMILARITY)) {
			ctx.log("dropped a hint that repeats an earlier one");
			return undefined;
		}
		return clip(hint, 600);
	}
}

interface Hypothesis {
	readonly hypothesis: string;
	readonly check: string;
}

export function renderHypotheses(hypotheses: readonly Hypothesis[]): string {
	return [
		"[exo triage: possible causes to check before the next attempt (unverified):",
		...hypotheses.map((h, i) => `${i + 1}. ${h.hypothesis} Check: ${h.check}`),
		"]",
	].join("\n");
}

/** Keeps the first of any hypotheses that share most of their words. */
export function dedupe<T extends Hypothesis>(items: readonly T[]): T[] {
	const kept: T[] = [];
	for (const item of items) {
		const words = wordSet(item.hypothesis);
		if (kept.every((k) => similarity(words, wordSet(k.hypothesis)) <= DUPLICATE_SIMILARITY)) kept.push(item);
	}
	return kept;
}

function wordSet(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_]+/)
			.filter((w) => w.length >= 3),
	);
}

function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	const shared = [...a].filter((w) => b.has(w)).length;
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 1 : shared / union;
}

function newState(): State {
	return { failures: new Map(), last: new Map(), recent: [], edits: [], edited: 0, calls: [], loopLevel: 0 };
}

/** The state an earlier instance saved, if it is one this version wrote. */
function restore(saved: JsonValue | undefined): State | undefined {
	if (saved === undefined || !Value.Check(SavedSchema, saved)) return undefined;
	return {
		...newState(),
		edited: saved.edited,
		failures: new Map(saved.failures.map((f) => [f.id, { ...f, hints: [...f.hints], by: [...f.by] }])),
		last: new Map(saved.last),
	};
}

function dropOldest(map: Map<string, unknown>, max: number): void {
	for (const key of map.keys()) {
		if (map.size <= max) return;
		map.delete(key);
	}
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/**
 * What a failing call reported: core's {@link failureKey}, and for a failed `edit` also the text it
 * looked for (T2). The tool's message names only the file, so without this every failed edit to a
 * file would be the same failure, whatever was tried.
 */
function failureIdentity(tool: Pick<ToolOutcome, "toolName" | "input" | "output">): string {
	const key = failureKey(tool);
	if (tool.toolName !== "edit") return key;
	const edits = tool.input["edits"];
	const sought = [tool.input["oldText"], ...(Array.isArray(edits) ? edits.map(oldTextOf) : [])].filter(
		(text) => typeof text === "string",
	);
	return sought.length > 0 ? digest(`${key}\n${JSON.stringify(sought)}`) : key;
}

function oldTextOf(edit: unknown): unknown {
	return typeof edit === "object" && edit !== null ? (edit as { oldText?: unknown }).oldText : undefined;
}

/**
 * Names what was run, so a later pass can be matched to an earlier failure: a test or build run
 * by the run itself (`cd x && cargo test 2>&1 | tail` is `cargo test`), another shell command by
 * its text, a file tool by its path, any other tool by its name.
 */
function commandIdentity(tool: Pick<ToolOutcome, "toolName" | "input">): string {
	const command = tool.input["command"];
	if (typeof command === "string") return digest(verifyingRun(command)?.bare ?? command.replace(/\s+/g, " ").trim());
	const path = tool.input["path"] ?? tool.input["file_path"];
	return digest(typeof path === "string" ? `${tool.toolName} ${path}` : tool.toolName);
}

function isFailure(tool: Pick<ToolResultDraft, "isError" | "exitCode">): boolean {
	return tool.isError || (tool.exitCode !== null && tool.exitCode !== 0);
}

/** The newest edits a failure outlived, as before/after text per file. */
function renderEdits(edits: readonly FileEdit[]): string {
	if (edits.length === 0) return "(none made with the edit tools)";
	const shown = edits.slice(-SHOWN_EDITS).map((e) => `${e.path}\n- ${indent(e.before)}\n+ ${indent(e.after)}`);
	const earlier = edits.length - shown.length;
	return [...(earlier > 0 ? [`(${earlier} earlier edit(s) not shown)`] : []), ...shown].join("\n\n");
}

function indent(text: string): string {
	return text.split("\n").join("\n  ");
}

/** `grep` finding nothing (exit 1) is an answer, not a failure: core's rule (D-077), with this module's list. */
export function isBenign(
	draft: Pick<ToolResultDraft, "exitCode" | "input" | "toolName">,
	settings: TriageSettings,
): boolean {
	const command = draft.input["command"];
	const line = typeof command === "string" ? command : commandOf(draft.input, draft.toolName);
	return isBenignExit(line, draft.exitCode, settings.benignCommands);
}

/** The command, or for file tools the tool and its path (`edit src/lib.rs`), so hints know what was tried. */
function commandOf(input: ToolResultDraft["input"], toolName: string): string {
	const command = input["command"];
	if (typeof command === "string") return clip(command.replace(/\s+/g, " ").trim(), 200);
	const path = input["path"] ?? input["file_path"];
	return typeof path === "string" ? `${toolName} ${clip(path, 160)}` : toolName;
}

/**
 * Describes the repeat at runtime instead of echoing the failed call back (research R3.3), and
 * escalates at the loop threshold (R3.4). It says what is known and no more (D-082): that edits
 * "did not change it" only of a failure that stood through them.
 */
function repeatNotice(repeat: {
	readonly count: number;
	/** How many of those came since the user last spoke. */
	readonly sinceUser: number;
	readonly errorLine: string | undefined;
	/** Files edited between the sightings compared. */
	readonly edited: readonly string[];
	readonly standing: boolean;
	readonly masked: boolean;
	readonly loopThreshold: number;
	readonly handOverAt: number;
}): string {
	const { count, errorLine, standing } = repeat;
	const earlier = standing ? "as before" : "as an earlier run";
	const between = standing ? "" : ", after other results in between";
	const same = `${errorLine ? ` with the same errors ${earlier} (first: ${clip(errorLine)})` : ` the same way ${earlier}`}${between}`;
	const pipe = repeat.masked ? " The exit code shown is the pipe's last command's, not this run's." : "";
	const edits =
		standing && repeat.edited.length > 0
			? ` The edits made since (${repeat.edited
					.slice(0, 4)
					.map((p) => clip(p, 80))
					.join(", ")}${repeat.edited.length > 4 ? ", …" : ""}) did not change it.`
			: "";
	// The user answers a hand-over by speaking: it is asked for again only if the failures go on.
	if (count >= repeat.handOverAt && repeat.sinceUser >= repeat.loopThreshold) {
		return `[exo triage: this has now failed ${count} times${same}.${pipe}${edits} ${HAND_OVER}]`;
	}
	if (count >= repeat.loopThreshold) {
		return `[exo triage: this has now failed ${count} times${same}.${pipe}${edits} The current approach is not working: stop retrying it, re-read the code around the error and question the assumption behind the last changes before the next attempt.]`;
	}
	const advice = standing
		? "Repeating the same fix is unlikely to help: change something first."
		: "It went away and came back: look at what the last changes undid before trying an earlier fix again.";
	return `[exo triage: this failed${standing ? " again" : ""}${same}; it has now failed this way ${count} times.${pipe}${edits} ${advice}]`;
}

/** What a loop that survived its first warning is told: the agent cannot be stopped (D-010), so it is asked to stop. */
const HAND_OVER =
	"Stop repeating it. If you cannot find a different approach, stop and tell the user what you tried and what is blocking you.";

/** Describes a loop of calls that keep ending the same way, without an error to point at (D-069). */
function loopNotice(repeats: number, cycle: readonly string[], handOver: boolean): string {
	const what =
		cycle.length === 1
			? `this exact call has now returned the same result ${repeats} times in a row`
			: `the same ${cycle.length} calls (${cycle.map((c) => clip(c, 60)).join(" → ")}) have now run ${repeats} times in a row with the same results each time`;
	const advice =
		cycle.length === 1
			? "Running it again will not change the result: use what it already shows, or do something different."
			: "This loop is not making progress: change the approach before running them again.";
	return `[exo triage: ${what}. ${handOver ? HAND_OVER : advice}]`;
}

/** The first error with context plus the output's tail: what a diagnosis needs, bounded. */
export function errorExcerpt(output: string): string {
	const lines = cleanTerminalOutput(output).split("\n");
	const first = firstErrorLine(output);
	const keep = new Set<number>();
	const from = first ? first.index - 2 : 0;
	for (let i = Math.max(0, from); i < Math.min(lines.length, from + EXCERPT_CONTEXT_LINES); i++) keep.add(i);
	for (let i = Math.max(0, lines.length - EXCERPT_TAIL_LINES); i < lines.length; i++) keep.add(i);
	const out: string[] = [];
	let previous = -1;
	for (const i of [...keep].sort((a, b) => a - b)) {
		if (previous !== -1 && i > previous + 1) out.push("[…]");
		out.push(clip(lines[i] ?? "", MAX_LINE_CHARS));
		previous = i;
	}
	const excerpt = out.join("\n");
	// The same mark as between its parts: the end of the output is gone, and the reader is told (D-089).
	return excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}\n[…]` : excerpt;
}

function clip(text: string, max = 200): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
