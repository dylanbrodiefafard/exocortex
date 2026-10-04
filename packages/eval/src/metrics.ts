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
	readonly compactions: number;
	/** Sidecar calls Exocortex made (all outcomes). */
	readonly sidecarCalls: number;
	/** Sidecar prompt + completion tokens. */
	readonly sidecarTokens: number;
	/** Sidecar calls that did not succeed (timeout, error, invalid output, ...), excluding cap/budget rejections. */
	readonly sidecarFailures: number;
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
		compactions: events.filter((e) => e.kind === "compaction").length,
		sidecarCalls: sidecarCalls.length,
		sidecarTokens: sidecarCalls.reduce((sum, c) => sum + c.usage.promptTokens + c.usage.completionTokens, 0),
		sidecarFailures: sidecarCalls.filter(
			(c) => c.outcome !== "ok" && c.outcome !== "rejected_turn_cap" && c.outcome !== "rejected_budget",
		).length,
	};
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
