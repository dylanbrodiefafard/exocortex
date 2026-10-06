import {
	callKey,
	cleanTerminalOutput,
	type ExoModule,
	type FileEdit,
	failureKey,
	fileEdits,
	firstErrorLine,
	loadPrompt,
	loopHistoryLength,
	type ModuleContext,
	maskedFailure,
	SIDECAR_MAX_TOKENS,
	type ToolResultDraft,
	trailingLoop,
	ungroundedReferences,
} from "@exocortex/core";
import { Type } from "typebox";
import { parseSettings, type TriageSettings } from "./settings.ts";
import { errorSites, renderSites } from "./sites.ts";

export const TRIAGE_ID = "triage";

const DIAGNOSE_PROMPT = loadPrompt(new URL("../prompts/diagnose.v3.md", import.meta.url));
const HYPOTHESIS_PROMPT = loadPrompt(new URL("../prompts/hypothesis.v2.md", import.meta.url));
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
const RECENT_COMMANDS = 6;
/** Edits kept per task, and what the sidecar is shown of the ones a failure outlived. */
const MAX_EDITS = 40;
const SHOWN_EDITS = 6;
const EDIT_TEXT_CHARS = 500;
const MAX_SITES = 4;
const EXCERPT_CONTEXT_LINES = 12;
const EXCERPT_TAIL_LINES = 8;
const EXCERPT_CHARS = 4_000;
const MAX_LINE_CHARS = 300;

interface TaskState {
	/** Times each failure was seen, by what it reported ({@link failureKey}). */
	readonly counts: Map<string, number>;
	/** Sidecar calls made for hints, per failure (the cap counts calls, shown or not). */
	readonly hintCalls: Map<string, number>;
	/** Hints the agent was shown, per failure. */
	readonly hints: Map<string, string[]>;
	readonly recent: string[];
	readonly hypothesized: Set<string>;
	/** The task's latest file edits, each with its number in the task. */
	readonly edits: { readonly seq: number; readonly edit: FileEdit }[];
	/** Edits made in the task so far. */
	edited: number;
	/** How many edits had been made when each failure was first seen. */
	readonly editedAtFirst: Map<string, number>;
	/** Every tool call of the task with its result, oldest first, as far back as a loop can reach. */
	readonly calls: { readonly key: string; readonly label: string }[];
	/** Notices given for the loop the calls now end in: 0 none, 1 the warning, 2 the hand-over. */
	loopLevel: number;
}

/**
 * Error triage (brief §6.3, gated as research R3.1 recommends): on a first failure only surface a
 * buried first error (deterministic); on a repeat append a runtime notice and, optionally, a
 * grounded two-sentence sidecar diagnosis; past the loop threshold the notice becomes a stronger,
 * still advisory, warning. Never blocks a tool call.
 *
 * A repeat is a failure that reports the same errors as one seen earlier in the task (D-073):
 * fewer failing tests or a different message is a new failure, however alike its first line. The
 * diagnosis reads what the main model is too close to weigh: the request, the code the errors
 * point at, and the edits the failure outlived.
 *
 * It also notices going round in circles without an error (D-069): the same call returning the
 * same result, or a short cycle of calls ending the same way each round. One notice when the loop
 * is established, one more that tells the agent to hand over to the user if it goes on.
 */
export function createTriage(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	let goal = "";
	let task: TaskState = newTask();
	let repeats = 0;
	let hintsGiven = 0;
	let loops = 0;
	/** Twice the threshold is where a notice becomes the hand-over. */
	const handOverAt = settings.loopThreshold * 2;

	return {
		id: TRIAGE_ID,

		onUserTurn(turn) {
			if (turn.origin !== "user") return;
			goal = startAndEnd(turn.text, GOAL_CHARS);
			task = newTask();
		},

		onToolResult(tool) {
			const command = commandOf(tool.input, tool.toolName);
			const outcome = isFailure(tool)
				? `exit ${tool.exitCode ?? "error"}`
				: isMasked(tool)
					? "errors in the output (exit code hidden by a pipe)"
					: "ok";
			task.recent.push(`${command} → ${outcome}`);
			if (task.recent.length > RECENT_COMMANDS) task.recent.shift();
			for (const edit of fileEdits(tool, EDIT_TEXT_CHARS) ?? []) {
				task.edited += 1;
				task.edits.push({ seq: task.edited, edit });
				if (task.edits.length > MAX_EDITS) task.edits.shift();
			}
			task.calls.push({ key: callKey(tool.toolName, tool.input, tool.output), label: command });
			if (task.calls.length > loopHistoryLength(handOverAt)) task.calls.shift();
			// The loop ended: a later one starts over with its first notice.
			if (!currentLoop()) task.loopLevel = 0;
		},

		async rewriteToolResult(draft, signal) {
			const masked = isMasked(draft);
			if (!masked && (!isFailure(draft) || isBenign(draft, settings))) return noProgress(draft);
			// Identity from the original output; position from what the model will see (maybe trimmed).
			const signature = failureKey(draft);
			const count = (task.counts.get(signature) ?? 0) + 1;
			task.counts.set(signature, count);
			const first = firstErrorLine(draft.output);
			if (count === 1) {
				task.editedAtFirst.set(signature, task.edited);
				return surfaced(draft);
			}
			repeats += 1;
			const outlived = editsSince(signature);
			const notice = repeatNotice({
				count,
				errorLine: first?.line,
				edited: [...new Set(outlived.map((e) => e.path))],
				masked,
				loopThreshold: settings.loopThreshold,
				handOverAt,
			});
			const evidence = evidenceFor(count, draft, outlived, masked);
			const hypotheses = count >= settings.loopThreshold ? await hypothesize(signature, evidence, signal) : undefined;
			if (hypotheses) {
				return {
					text: `${draft.current}\n${notice}\n${renderHypotheses(hypotheses)}`,
					note: `repeat ${count} + ${hypotheses.length} hypotheses`,
				};
			}
			const hint = await diagnose(signature, evidence, signal);
			if (hint) hintsGiven += 1;
			return {
				text: `${draft.current}\n${notice}${hint ? `\n[exo triage hint: ${hint}]` : ""}`,
				// The eval report reads "+ hint" to follow each hint's outcome (D-057).
				note: `repeat ${count}${hint ? " + hint" : ""}`,
			};
		},

		status() {
			if (repeats === 0 && loops === 0) return TRIAGE_ID;
			return `${TRIAGE_ID} (${repeats} repeats, ${hintsGiven} hints${loops > 0 ? `, ${loops} loops` : ""})`;
		},
	};

	function currentLoop() {
		return settings.loops
			? trailingLoop(
					task.calls.map((c) => c.key),
					settings.loopThreshold,
				)
			: undefined;
	}

	/**
	 * A result that is not a failure, at the end of a loop: says so once, and once more at twice the
	 * threshold. Failures in a loop get their own notice above, so the level only rises here.
	 */
	function noProgress(draft: ToolResultDraft) {
		const loop = currentLoop();
		// Results can arrive out of order when calls ran in parallel: only speak for the latest.
		if (!loop || task.calls.at(-1)?.key !== callKey(draft.toolName, draft.input, draft.output)) return undefined;
		const level = loop.repeats >= handOverAt ? 2 : 1;
		if (level <= task.loopLevel) return undefined;
		task.loopLevel = level;
		loops += 1;
		const cycle = task.calls.slice(-loop.period).map((c) => c.label);
		return {
			text: `${draft.current}\n${loopNotice(loop.repeats, cycle, level === 2)}`,
			note: `no progress ×${loop.repeats}${loop.period > 1 ? ` (cycle of ${loop.period})` : ""}`,
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

	/** The edits made since this failure was first seen: it outlived every one of them. */
	function editsSince(signature: string): FileEdit[] {
		const from = task.editedAtFirst.get(signature) ?? task.edited;
		return task.edits.filter((e) => e.seq > from).map((e) => e.edit);
	}

	/** What a sidecar is given to read, and the text its answer is checked against. */
	function evidenceFor(count: number, draft: ToolResultDraft, outlived: readonly FileEdit[], masked: boolean) {
		const excerpt = errorExcerpt(draft.output);
		const vars = {
			count: String(count),
			goal: goal || "(unknown)",
			recent: task.recent.map((r) => `- ${r}`).join("\n") || "(none)",
			command: commandOf(draft.input, draft.toolName),
			exit_code: masked ? "hidden by a pipe" : draft.exitCode === null ? "unknown" : String(draft.exitCode),
			excerpt,
			edits: renderEdits(outlived),
			code:
				renderSites(errorSites(excerpt, ctx.cwd, MAX_SITES), ctx.cwd) ||
				"(the output names no line in a file of this workspace)",
		};
		return { vars, text: `${draft.output}\n${goal}\n${task.recent.join("\n")}\n${vars.edits}\n${vars.code}` };
	}

	type Evidence = ReturnType<typeof evidenceFor>;

	/**
	 * Phase 6 (D-015): K isolated sidecars, each from a different angle, in parallel. Only distinct,
	 * grounded hypotheses that name a check are kept, and only a list of 2+ is shown: no LLM picks a
	 * winner (research R6.1).
	 */
	async function hypothesize(signature: string, evidence: Evidence, signal: AbortSignal) {
		const pool = ctx.pool();
		if (settings.hypotheses === 0 || !pool || task.hypothesized.has(signature)) return undefined;
		task.hypothesized.add(signature);
		ctx.progress("Considering other causes of the repeated failure…");
		const results = await Promise.all(
			FRAMES.slice(0, settings.hypotheses).map((frame) =>
				pool.run({
					module: TRIAGE_ID,
					priority: "interactive",
					timeoutMs: settings.hypothesisTimeoutMs,
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

	async function diagnose(signature: string, evidence: Evidence, signal: AbortSignal) {
		const calls = task.hintCalls.get(signature) ?? 0;
		const pool = ctx.pool();
		if (!settings.sidecar || !pool || calls >= settings.maxHintsPerSignature) return undefined;
		task.hintCalls.set(signature, calls + 1);
		const earlier = task.hints.get(signature) ?? [];
		ctx.progress("Diagnosing the repeated failure…");
		const result = await pool.run({
			module: TRIAGE_ID,
			priority: "interactive",
			timeoutMs: settings.hintTimeoutMs,
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
		const shown = clip(hint, 600);
		task.hints.set(signature, [...earlier, shown]);
		return shown;
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

function newTask(): TaskState {
	return {
		counts: new Map(),
		hintCalls: new Map(),
		hints: new Map(),
		recent: [],
		hypothesized: new Set(),
		edits: [],
		edited: 0,
		editedAtFirst: new Map(),
		calls: [],
		loopLevel: 0,
	};
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

/** `grep` finding nothing (exit 1) is an answer, not a failure. Looks at the last `&&`/`;` step. */
export function isBenign(
	draft: Pick<ToolResultDraft, "exitCode" | "input" | "toolName">,
	settings: TriageSettings,
): boolean {
	if (draft.exitCode !== 1) return false;
	const command = commandOf(draft.input, draft.toolName);
	const last =
		command
			.split(/&&|;|\|\|/)
			.at(-1)
			?.trim() ?? "";
	const words = last.replace(/^(\w+=\S*\s+)+/, "");
	return settings.benignCommands.some((benign) => words === benign || words.startsWith(`${benign} `));
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
 * escalates at the loop threshold (R3.4). It says what is known: the errors are the ones reported
 * before, and which edited files they outlived.
 */
function repeatNotice(repeat: {
	readonly count: number;
	readonly errorLine: string | undefined;
	/** Files edited since the failure was first seen. */
	readonly edited: readonly string[];
	readonly masked: boolean;
	readonly loopThreshold: number;
	readonly handOverAt: number;
}): string {
	const { count, errorLine } = repeat;
	const same = errorLine ? ` with the same errors as before (first: ${clip(errorLine)})` : " the same way as before";
	const pipe = repeat.masked ? " The exit code shown is the pipe's last command's, not this run's." : "";
	const edits =
		repeat.edited.length > 0
			? ` The edits made since (${repeat.edited
					.slice(0, 4)
					.map((p) => clip(p, 80))
					.join(", ")}${repeat.edited.length > 4 ? ", …" : ""}) did not change it.`
			: "";
	if (count >= repeat.handOverAt) {
		return `[exo triage: this has now failed ${count} times${same}.${pipe}${edits} ${HAND_OVER}]`;
	}
	if (count >= repeat.loopThreshold) {
		return `[exo triage: this has now failed ${count} times${same}.${pipe}${edits} The current approach is not working: stop retrying it, re-read the code around the error and question the assumption behind the last changes before the next attempt.]`;
	}
	return `[exo triage: this failed again${same}; it is the ${ordinal(count)} time this task.${pipe}${edits} Repeating the same fix is unlikely to help: change something first.]`;
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
	return out.join("\n").slice(0, EXCERPT_CHARS);
}

/** A long request keeps its start and its end: the task is stated first, the constraints often last. */
function startAndEnd(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor((max * 2) / 3);
	return `${text.slice(0, head)}\n[…]\n${text.slice(text.length - (max - head))}`;
}

function ordinal(n: number): string {
	const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
	return `${n}${suffix}`;
}

function clip(text: string, max = 200): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
