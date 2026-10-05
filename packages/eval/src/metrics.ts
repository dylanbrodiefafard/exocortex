import {
	type ChatRequestFingerprint,
	errorSignature as coreErrorSignature,
	type SidecarCallRecord,
	type StoredTraceEvent,
	sharedPrefix,
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
	/** Tool errors whose normalized signature already occurred earlier in the run. */
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
	/** Verdicts reached without an LLM call (supervisor preVerdict, D-046). */
	readonly deterministicVerdicts: number;
	/**
	 * Whether a test or build command succeeded after the agent's last file edit; null when it
	 * edited nothing. A pass without it is a "lucky pass" candidate (research R7.6).
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
	/** Compactions after which one of the agent's next two commands re-ran one that had already passed (R4.4). */
	readonly compactionReplays?: number;
	/** Tool outputs the trimmer shortened, and how many of their saved full outputs the agent read back (R2.1). */
	readonly trimmedOutputs?: number;
	readonly trimmedRereads?: number;
	/** One entry per error signature that occurred 2+ times: how the repeats and triage's hints went (D-057). */
	readonly recurringErrors?: readonly RecurringError[];
	/** Sidecar prompt + completion tokens by module (D-058). */
	readonly sidecarTokensByModule?: Readonly<Record<string, number>>;
	/** Sidecar calls Exocortex made (all outcomes). */
	readonly sidecarCalls: number;
	/** Sidecar prompt + completion tokens. */
	readonly sidecarTokens: number;
	/** Sidecar calls that did not succeed (timeout, error, invalid output, ...), excluding cap/budget rejections. */
	readonly sidecarFailures: number;
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

export function computeTraceMetrics(
	events: readonly StoredTraceEvent[],
	sidecarCalls: readonly SidecarCallRecord[] = [],
): TraceMetrics {
	let inputTokens = 0;
	let cachedTokens = 0;
	let outputTokens = 0;
	let turns = 0;
	for (const event of events.filter((e) => e.kind === "turn.end")) {
		turns += 1;
		const usage = record(record(event.data)["usage"]);
		inputTokens += number(usage["input"]);
		cachedTokens += number(usage["cacheRead"]);
		outputTokens += number(usage["output"]);
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
	const seen = new Set<string>();
	let repeatedToolErrors = 0;
	for (const error of errors) {
		const signature = errorSignature(error);
		if (seen.has(signature)) repeatedToolErrors += 1;
		seen.add(signature);
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
		...processQuality(events),
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
		compactionReplays: compactionReplays(events),
		...trimmerRereads(events),
		recurringErrors: recurringErrors(events),
		sidecarTokensByModule: tokensByModule(sidecarCalls),
		sidecarCalls: sidecarCalls.length,
		sidecarTokens: sidecarCalls.reduce((sum, c) => sum + c.usage.promptTokens + c.usage.completionTokens, 0),
		sidecarFailures: sidecarCalls.filter(
			(c) => c.outcome !== "ok" && c.outcome !== "rejected_turn_cap" && c.outcome !== "rejected_budget",
		).length,
	};
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
 * Follows each error signature through the run (D-057). A failure is what triage calls one: an
 * error result or a non-zero exit. Hints are read from triage's `exo.rewrite` notes, joined to
 * the failing result by tool call id.
 */
function recurringErrors(events: readonly StoredTraceEvent[]): RecurringError[] {
	const commands = new Map<string, string>();
	const hinted = new Set<string>();
	for (const e of events) {
		const data = record(e.data);
		if (e.kind === "tool.call")
			commands.set(String(data["toolCallId"]), String(record(data["input"])["command"] ?? ""));
		if (e.kind === "exo.rewrite" && e.module === "triage" && HINT_NOTE.test(String(data["note"])))
			hinted.add(String(data["toolCallId"]));
	}
	const results = events.filter((e) => e.kind === "tool.result").map((e) => record(e.data));
	const bySignature = new Map<string, number[]>();
	results.forEach((result, index) => {
		if (!failed(result)) return;
		const signature = errorSignature(result);
		bySignature.set(signature, [...(bySignature.get(signature) ?? []), index]);
	});
	const commandOf = (index: number) => commands.get(String(results[index]?.["toolCallId"])) ?? "";
	const out: RecurringError[] = [];
	for (const indexes of bySignature.values()) {
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
			fixed: command !== "" && results.some((r, i) => i > last && !failed(r) && commandOf(i) === command),
		});
	}
	return out;
}

function failed(toolResult: Readonly<Record<string, unknown>>): boolean {
	const exitCode = toolResult["exitCode"];
	return toolResult["isError"] === true || (typeof exitCode === "number" && exitCode !== 0);
}

const EDIT_TOOL = /^(edit|write|multi_?edit|apply_?patch)$/i;
const VERIFY_COMMAND =
	/\b(pytest|unittest|cargo (test|build|check)|go (test|build|vet)|ctest|make\b|cmake --build|npm (run )?(test|build)|npx (vitest|jest|tsc)|tox|g\+\+|clang\+\+)/;

function processQuality(events: readonly StoredTraceEvent[]) {
	const commands = new Map<string, string>();
	for (const e of events) {
		const data = record(e.data);
		if (e.kind === "tool.call")
			commands.set(String(data["toolCallId"]), String(record(data["input"])["command"] ?? ""));
	}
	let lastEdit = -1;
	let lastVerified = -1;
	const failures = new Map<string, number>();
	events.forEach((e, index) => {
		if (e.kind !== "tool.result") return;
		const data = record(e.data);
		const command = commands.get(String(data["toolCallId"])) ?? "";
		const failed = data["isError"] === true;
		if (EDIT_TOOL.test(String(data["toolName"])) && !failed) lastEdit = index;
		if (!failed && VERIFY_COMMAND.test(command)) lastVerified = index;
		if (failed && command !== "") failures.set(command, (failures.get(command) ?? 0) + 1);
	});
	return {
		verifiedAfterLastEdit: lastEdit === -1 ? null : lastVerified > lastEdit,
		maxRepeatedFailures: Math.max(0, ...failures.values()),
	};
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

/** The trace form of core's {@link coreErrorSignature}: one signature per tool.result event. */
export function errorSignature(toolResult: Readonly<Record<string, unknown>>): string {
	const exitCode = typeof toolResult["exitCode"] === "number" ? toolResult["exitCode"] : null;
	return coreErrorSignature(String(toolResult["toolName"]), exitCode, contentText(toolResult["content"]));
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
