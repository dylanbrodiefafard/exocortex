import {
	type ChatRequestFingerprint,
	callKey,
	failureKey,
	maskedFailure,
	outcomeOf,
	type SidecarCallRecord,
	type StoredTraceEvent,
	sharedPrefix,
	trailingLoop,
	verifyingRun,
} from "@exocortex/core";

/** Per-run metrics derived purely from the harness-agnostic trace (brief §7). */
export interface TraceMetrics {
	readonly turns: number;
	readonly llmRequests: number;
	/** Main-model prompt tokens not served from cache. */
	readonly inputTokens: number;
	readonly cachedTokens: number;
	readonly outputTokens: number;
	/** cached / (input + cached); null when no prompt tokens were reported. */
	readonly cacheHitRate: number | null;
	/** Share of consecutive LLM requests that kept the previous request's full prefix. */
	readonly prefixKeptRate: number | null;
	readonly maxPromptChars: number;
	readonly toolCalls: number;
	readonly toolErrors: number;
	/** Tool errors that reported the same errors as an earlier one in the run (D-073). */
	readonly repeatedToolErrors: number;
	/** Messages Exocortex injected (synthetic). */
	readonly injections: number;
	/**
	 * Follow-ups Exocortex caused: extension-sent prompts, supervisor auto-continuations and
	 * accepted supervisor suggestions.
	 */
	readonly continuations: number;
	/** Supervisor verdicts by kind (brief §6.1: the labels memory will learn from). */
	readonly verdicts: Readonly<Record<"complete" | "incomplete" | "failed" | "uncertain", number>>;
	/** The run's last supervisor verdict: what it believed when the agent finally stopped. */
	readonly lastVerdict: "complete" | "incomplete" | "failed" | "uncertain" | null;
	/** Verdicts reached without a verdict call (supervisor preVerdict, D-046). */
	readonly deterministicVerdicts: number;
	/**
	 * Whether a test or build run passed after the agent's last change to the workspace; null when
	 * it changed nothing. A pass without it is a "lucky pass" candidate (research R7.6). What counts
	 * as a run and as passing is core's reading (D-077), and the changes are the workspace's diff
	 * against the task's baseline when {@link WorkspaceFacts.edits} is given (D-086).
	 */
	readonly verifiedAfterLastEdit: boolean | null;
	/** Most times one identical command failed: blind retrying (research R7.6). */
	readonly maxRepeatedFailures: number;
	readonly compactions: number;
	/**
	 * Context pressure (D-059). Optional: results recorded before these existed lack them.
	 * Compactions pi started because a request overflowed the context window, done or failed.
	 */
	readonly overflowCompactions?: number;
	/** Compactions that failed or were aborted (`compaction.failed` events). */
	readonly failedCompactions?: number;
	/** Turns that ended with `stopReason: "error"`: where an overflow pi did not recognise shows up. */
	readonly errorStops?: number;
	/** Turns cut off by the output limit (`stopReason: "length"`). */
	readonly lengthStops?: number;
	/** How the run's last turn ended; `"error"` with no tool call marks a run the model server failed (D-079). */
	readonly lastStopReason?: string | null;
	/**
	 * Tokens pi's own compaction summaries cost, already included in the three main-token counts.
	 * They are not turns, so `turn.end` never carries them (PI_API_NOTES "Compaction: where the summariser's usage goes", D-079).
	 */
	readonly compactionTokens?: number;
	/** Compactions after which one of the agent's next two commands re-ran one that had already passed (R4.4). */
	readonly compactionReplays?: number;
	/** Tool outputs the trimmer shortened, and how many of their saved full outputs the agent read back (R2.1). */
	readonly trimmedOutputs?: number;
	readonly trimmedRereads?: number;
	/**
	 * Stuck loops (D-069): times the agent's tool calls ended in the same call or short cycle with
	 * the same results 3 times running, and the calls it went on to make inside such a loop.
	 */
	readonly stuckLoops?: number;
	readonly stuckLoopCalls?: number;
	/** One entry per failure seen 2+ times: how the repeats and triage's hints went (D-057, D-073). */
	readonly recurringErrors?: readonly RecurringError[];
	/** Sidecar prompt + completion tokens by module (D-058). */
	readonly sidecarTokensByModule?: Readonly<Record<string, number>>;
	/** Sidecar calls Exocortex made (all outcomes). */
	readonly sidecarCalls: number;
	/** Sidecar prompt + completion tokens. */
	readonly sidecarTokens: number;
	/** Sidecar calls that did not succeed (timeout, error, invalid output, ...), excluding cap/budget rejections. */
	readonly sidecarFailures: number;
	/**
	 * Background sidecar calls (memory's lesson-writing) still queued or running when the session
	 * ended: those that finished in the time shutdown gave them, and those it cut off (D-086).
	 * Optional: results recorded before these existed lack them.
	 */
	readonly backgroundFinishedAtShutdown?: number;
	readonly backgroundCutOff?: number;
}

/** One normalized error signature that came back within a run. */
export interface RecurringError {
	/** Times the signature occurred (2 or more). */
	readonly occurrences: number;
	/** Triage hints the agent was shown for it (0 without triage, at most D-043's cap). */
	readonly hints: number;
	/**
	 * What followed the last hint (the last occurrence when no hint was given):
	 * - `stopped`: the error did not come back and the agent kept working;
	 * - `recurred`: it came back;
	 * - `ended`: the run ended before another tool result, so nothing can be said.
	 */
	readonly after: "stopped" | "recurred" | "ended";
	/** The command that last failed this way succeeded later in the run. */
	readonly fixed: boolean;
}

/** What the harness knows about a run that its trace cannot say (D-086). */
export interface WorkspaceFacts {
	/**
	 * How the finished workspace differs from the task's baseline commit. With it, an edit is a
	 * file that ended up different, however it was written (`sed -i`, a heredoc, a formatter), and
	 * a file put back as it was is not one. Without it, edits are the edit tools' calls.
	 */
	readonly edits?: WorkspaceEdits;
	/** The task's check command: a run of it verifies, even when it names no runner core knows. */
	readonly checks?: readonly string[];
}

export interface WorkspaceEdits {
	/** Repo-relative paths that were changed, added or deleted; build output and ignored files aside. */
	readonly files: readonly string[];
	/** When the newest of those still present was last written (epoch ms); null when none is (deletions only). */
	readonly lastEditMs: number | null;
}

export function computeTraceMetrics(
	events: readonly StoredTraceEvent[],
	sidecarCalls: readonly SidecarCallRecord[] = [],
	workspace: WorkspaceFacts = {},
): TraceMetrics {
	let inputTokens = 0;
	let cachedTokens = 0;
	let outputTokens = 0;
	let turns = 0;
	let lastStopReason: string | null = null;
	for (const event of events.filter((e) => e.kind === "turn.end")) {
		turns += 1;
		const usage = record(record(event.data)["usage"]);
		inputTokens += number(usage["input"]);
		cachedTokens += number(usage["cacheRead"]);
		outputTokens += number(usage["output"]);
		const stopReason = record(event.data)["stopReason"];
		lastStopReason = typeof stopReason === "string" ? stopReason : null;
	}
	// Pi's summariser is a direct model call, not a turn: its usage reaches only the compaction
	// entry. Without it a baseline that compacts looks cheaper than it was. A summary an extension
	// supplied (Exocortex's compaction module) was paid for as sidecar calls, counted elsewhere.
	let compactionTokens = 0;
	for (const event of events.filter((e) => e.kind === "compaction")) {
		const data = record(event.data);
		if (data["fromExtension"] === true) continue;
		const usage = record(record(data["entry"])["usage"]);
		inputTokens += number(usage["input"]);
		cachedTokens += number(usage["cacheRead"]);
		outputTokens += number(usage["output"]);
		compactionTokens += number(usage["input"]) + number(usage["cacheRead"]) + number(usage["output"]);
	}

	const requests = events
		.filter((e) => e.kind === "llm.request")
		.map((e) => e.data as unknown as ChatRequestFingerprint);
	let keptPairs = 0;
	for (let i = 1; i < requests.length; i++) {
		const previous = requests[i - 1];
		const next = requests[i];
		if (previous && next && sharedPrefix(previous, next).fullPrefixKept) keptPairs += 1;
	}

	const toolResults = events.filter((e) => e.kind === "tool.result").map((e) => record(e.data));
	const errors = toolResults.filter((r) => r["isError"] === true);
	const commands = commandsByCall(events);
	const seen = new Set<string>();
	let repeatedToolErrors = 0;
	for (const error of errors) {
		const failure = failureOf(error, commands);
		if (seen.has(failure)) repeatedToolErrors += 1;
		seen.add(failure);
	}

	const promptTokens = inputTokens + cachedTokens;
	return {
		turns,
		llmRequests: requests.length,
		inputTokens,
		cachedTokens,
		outputTokens,
		cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : null,
		prefixKeptRate: requests.length > 1 ? keptPairs / (requests.length - 1) : null,
		maxPromptChars: Math.max(0, ...requests.map((r) => number(r.messageChars))),
		toolCalls: events.filter((e) => e.kind === "tool.call").length,
		toolErrors: errors.length,
		repeatedToolErrors,
		injections: events.filter((e) => e.kind === "message" && e.synthetic).length,
		continuations:
			events.filter((e) => e.kind === "user.input" && record(e.data)["source"] === "extension").length +
			events.filter(
				(e) => e.kind === "exo.action" && ["accepted", "continued"].includes(String(record(e.data)["action"])),
			).length,
		verdicts: countVerdicts(events),
		lastVerdict: lastVerdict(events),
		...processQuality(events, workspace),
		deterministicVerdicts: events.filter(
			(e) => e.kind === "exo.verdict" && record(e.data)["source"] === "deterministic",
		).length,
		compactions: events.filter((e) => e.kind === "compaction").length,
		overflowCompactions: events.filter(
			(e) => (e.kind === "compaction" || e.kind === "compaction.failed") && record(e.data)["reason"] === "overflow",
		).length,
		failedCompactions: events.filter((e) => e.kind === "compaction.failed").length,
		errorStops: stops(events, "error"),
		lengthStops: stops(events, "length"),
		lastStopReason,
		compactionTokens,
		compactionReplays: compactionReplays(events),
		...trimmerRereads(events),
		...stuckLoops(events),
		recurringErrors: recurringErrors(events),
		sidecarTokensByModule: tokensByModule(sidecarCalls),
		sidecarCalls: sidecarCalls.length,
		sidecarTokens: sidecarCalls.reduce((sum, c) => sum + c.usage.promptTokens + c.usage.completionTokens, 0),
		sidecarFailures: sidecarCalls.filter((c) => c.outcome !== "ok" && c.outcome !== "rejected_budget").length,
		...shutdownDrains(events),
	};
}

/** What the adapter's wait for background calls at `session_shutdown` came to (its `drained` action). */
function shutdownDrains(events: readonly StoredTraceEvent[]) {
	let backgroundFinishedAtShutdown = 0;
	let backgroundCutOff = 0;
	for (const e of events) {
		const data = record(e.data);
		if (e.kind !== "exo.action" || data["action"] !== "drained") continue;
		backgroundFinishedAtShutdown += number(data["settled"]);
		backgroundCutOff += number(data["remaining"]);
	}
	return { backgroundFinishedAtShutdown, backgroundCutOff };
}

/** How many commands the agent runs right after a compaction count as "its next actions" (research R4.4). */
const REPLAY_WINDOW = 2;

/**
 * Research R4.4: a summary that loses "this already passed" makes the agent run it again. Counts
 * compactions followed, within its next two commands, by a successful re-run of a command whose
 * last run before the compaction had also succeeded.
 */
function compactionReplays(events: readonly StoredTraceEvent[]): number {
	const results = new Map<string, boolean>();
	for (const e of events) {
		if (e.kind === "tool.result") results.set(String(record(e.data)["toolCallId"]), !failed(record(e.data)));
	}
	const passedLast = new Map<string, boolean>();
	let replays = 0;
	/** Commands still to look at after the latest compaction, and what had passed before it. */
	let watch: { left: number; passed: Set<string> } | undefined;
	for (const e of events) {
		if (e.kind === "compaction") {
			watch = { left: REPLAY_WINDOW, passed: new Set([...passedLast].filter(([, ok]) => ok).map(([c]) => c)) };
			continue;
		}
		if (e.kind !== "tool.call") continue;
		const data = record(e.data);
		const command = record(data["input"])["command"];
		if (typeof command !== "string") continue;
		const ok = results.get(String(data["toolCallId"])) ?? false;
		if (watch && watch.left > 0) {
			watch.left -= 1;
			if (ok && watch.passed.has(command)) {
				replays += 1;
				watch = undefined;
			}
		}
		passedLast.set(command, ok);
	}
	return replays;
}

/** Repeats that make a loop: triage's default threshold, so the metric counts what triage would flag. */
const STUCK_LOOP_REPEATS = 3;

/**
 * Loops by the definition triage uses (core's `trailingLoop`), from the original tool results, so
 * the count is the same with triage on or off. `stuckLoopCalls` is what a notice can save: the
 * calls made after a loop was established and before it broke.
 */
function stuckLoops(events: readonly StoredTraceEvent[]): { stuckLoops: number; stuckLoopCalls: number } {
	const inputs = new Map<string, unknown>();
	let keys: string[] = [];
	let inLoop = false;
	let loops = 0;
	let calls = 0;
	for (const e of events) {
		const data = record(e.data);
		if (e.kind === "tool.call") inputs.set(String(data["toolCallId"]), data["input"]);
		// A new request from the user starts a new task, as in triage.
		if (e.kind === "user.input" && data["source"] !== "extension") {
			keys = [];
			inLoop = false;
		}
		if (e.kind !== "tool.result") continue;
		keys.push(callKey(String(data["toolName"]), inputs.get(String(data["toolCallId"])), contentText(data["content"])));
		if (!trailingLoop(keys, STUCK_LOOP_REPEATS)) inLoop = false;
		else if (inLoop) calls += 1;
		else {
			inLoop = true;
			loops += 1;
		}
	}
	return { stuckLoops: loops, stuckLoopCalls: calls };
}

/** Research R2.1: the agent reading a saved full output back means the trimmer cut something it needed. */
function trimmerRereads(events: readonly StoredTraceEvent[]): { trimmedOutputs: number; trimmedRereads: number } {
	const saved = new Map<string, number>();
	let trimmedOutputs = 0;
	events.forEach((e, index) => {
		if (e.kind !== "exo.rewrite" || e.module !== "trimmer") return;
		trimmedOutputs += 1;
		const path = record(e.data)["fullOutputPath"];
		if (typeof path === "string" && path !== "" && !saved.has(path)) saved.set(path, index);
	});
	let trimmedRereads = 0;
	for (const [path, index] of saved) {
		const reread = events.some(
			(e, i) => i > index && e.kind === "tool.call" && JSON.stringify(record(e.data)["input"] ?? "").includes(path),
		);
		if (reread) trimmedRereads += 1;
	}
	return { trimmedOutputs, trimmedRereads };
}

function stops(events: readonly StoredTraceEvent[], reason: string): number {
	return events.filter((e) => e.kind === "turn.end" && record(e.data)["stopReason"] === reason).length;
}

function tokensByModule(calls: readonly SidecarCallRecord[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const call of calls) {
		out[call.module] = (out[call.module] ?? 0) + call.usage.promptTokens + call.usage.completionTokens;
	}
	return out;
}

/** Triage's rewrite note when its sidecar hint was shown (`repeat 3 + hint`, mod-triage). */
const HINT_NOTE = /\+ hint$/;

/**
 * Follows each failure through the run (D-057). A failure is what triage calls one: an error
 * result, a non-zero exit, or a test or build run that failed behind a pipe. It is the same
 * failure again only when it reports the same errors (D-073): a run with fewer failing tests is
 * another one. Hints are read from triage's `exo.rewrite` notes, joined to the failing result by
 * tool call id.
 */
function recurringErrors(events: readonly StoredTraceEvent[]): RecurringError[] {
	const commands = commandsByCall(events);
	const hinted = new Set<string>();
	for (const e of events) {
		const data = record(e.data);
		if (e.kind === "exo.rewrite" && e.module === "triage" && HINT_NOTE.test(String(data["note"])))
			hinted.add(String(data["toolCallId"]));
	}
	const results = events.filter((e) => e.kind === "tool.result").map((e) => record(e.data));
	const commandOf = (index: number) => commands.get(String(results[index]?.["toolCallId"])) ?? "";
	const failedAt = (index: number) => failed(results[index] ?? {}, commandOf(index));
	const byFailure = new Map<string, number[]>();
	results.forEach((result, index) => {
		if (!failedAt(index)) return;
		const failure = failureOf(result, commands);
		byFailure.set(failure, [...(byFailure.get(failure) ?? []), index]);
	});
	const out: RecurringError[] = [];
	for (const indexes of byFailure.values()) {
		if (indexes.length < 2) continue;
		const last = indexes.at(-1) ?? 0;
		const hintIndexes = indexes.filter((i) => hinted.has(String(results[i]?.["toolCallId"])));
		// Without a hint the question is whether the first repeat was also the last.
		const pivot = hintIndexes.at(-1) ?? indexes[1] ?? last;
		const command = commandOf(last);
		out.push({
			occurrences: indexes.length,
			hints: hintIndexes.length,
			after: last > pivot ? "recurred" : pivot === results.length - 1 ? "ended" : "stopped",
			fixed: command !== "" && results.some((_, i) => i > last && !failedAt(i) && commandOf(i) === command),
		});
	}
	return out;
}

/** The shell command of each tool call, by call id ("" for other tools). */
function commandsByCall(events: readonly StoredTraceEvent[]): Map<string, string> {
	const commands = new Map<string, string>();
	for (const e of events) {
		if (e.kind !== "tool.call") continue;
		const data = record(e.data);
		commands.set(String(data["toolCallId"]), String(record(data["input"])["command"] ?? ""));
	}
	return commands;
}

function failed(toolResult: Readonly<Record<string, unknown>>, command = ""): boolean {
	const exitCode = typeof toolResult["exitCode"] === "number" ? toolResult["exitCode"] : null;
	const isError = toolResult["isError"] === true;
	if (isError || (exitCode !== null && exitCode !== 0)) return true;
	return maskedFailure({ input: { command }, isError, exitCode, output: contentText(toolResult["content"]) });
}

const EDIT_TOOL = /^(edit|write|multi_?edit|apply_?patch)$/i;

/**
 * Whether the agent's last change was followed by a passing test or build run, and how often it
 * repeated one failing command.
 * - **A verifying run** is what core reads as one (`verifyingRun`: the line is parsed, so
 *   `grep -rn pytest .` is not), or a run of the task's own check.
 * - **It passed** when core's `outcomeOf` says so: a run whose exit code a pipe hid is read from
 *   its output, and one that shows a failure or nothing readable does not count. The reading is
 *   core's own, never a sidecar's, so the metric means the same in every config.
 * - **The last change** is the newest write to a file that differs from the baseline. A run
 *   counts when it ended at or after that write: what the run itself wrote (`Cargo.lock`, a
 *   formatter earlier on the same line) comes before its result. Without the workspace's diff,
 *   the last successful edit-tool call stands in, by position.
 */
function processQuality(events: readonly StoredTraceEvent[], workspace: WorkspaceFacts) {
	const commands = commandsByCall(events);
	const options = { tests: workspace.checks ?? [] };
	let lastEdit = -1;
	let lastVerified = -1;
	let lastVerifiedMs: number | null = null;
	const failures = new Map<string, number>();
	events.forEach((e, index) => {
		if (e.kind !== "tool.result") return;
		const data = record(e.data);
		const command = commands.get(String(data["toolCallId"])) ?? "";
		const isError = data["isError"] === true;
		if (EDIT_TOOL.test(String(data["toolName"])) && !isError) lastEdit = index;
		if (isError && command !== "") failures.set(command, (failures.get(command) ?? 0) + 1);
		if (command === "" || !verifyingRun(command, options)) return;
		const exitCode = typeof data["exitCode"] === "number" ? data["exitCode"] : null;
		const outcome = outcomeOf({ input: { command }, isError, exitCode, output: contentText(data["content"]) });
		if (outcome !== "passed") return;
		lastVerified = index;
		lastVerifiedMs = e.ts;
	});
	const edits = workspace.edits;
	const verifiedAfterLastEdit = edits
		? edits.files.length === 0
			? null
			: lastVerifiedMs !== null && lastVerifiedMs >= Math.floor(edits.lastEditMs ?? 0)
		: lastEdit === -1
			? null
			: lastVerified > lastEdit;
	return { verifiedAfterLastEdit, maxRepeatedFailures: Math.max(0, ...failures.values()) };
}

function lastVerdict(events: readonly StoredTraceEvent[]): TraceMetrics["lastVerdict"] {
	const verdict = record([...events].reverse().find((e) => e.kind === "exo.verdict")?.data)["verdict"];
	return verdict === "complete" || verdict === "incomplete" || verdict === "failed" || verdict === "uncertain"
		? verdict
		: null;
}

function countVerdicts(events: readonly StoredTraceEvent[]): TraceMetrics["verdicts"] {
	const counts = { complete: 0, incomplete: 0, failed: 0, uncertain: 0 };
	for (const event of events) {
		if (event.kind !== "exo.verdict") continue;
		const verdict = record(event.data)["verdict"];
		if (verdict === "complete" || verdict === "incomplete" || verdict === "failed" || verdict === "uncertain") {
			counts[verdict] += 1;
		}
	}
	return counts;
}

/** The trace form of core's {@link failureKey}: what a failing tool.result event reported. */
export function failureOf(
	toolResult: Readonly<Record<string, unknown>>,
	commands: ReadonlyMap<string, string> = new Map(),
): string {
	return failureKey({
		toolName: String(toolResult["toolName"]),
		input: { command: commands.get(String(toolResult["toolCallId"])) ?? "" },
		output: contentText(toolResult["content"]),
	});
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const p = record(part);
			return p["type"] === "text" && typeof p["text"] === "string" ? p["text"] : "";
		})
		.join("\n");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
