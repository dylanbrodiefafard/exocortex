import type { JsonValue, SidecarCallRecord, StoredSession, StoredTraceEvent } from "@exocortex/core";
import { computeTraceMetrics } from "./metrics.ts";

const SNIPPET_CHARS = 100;

/** Finds the session whose id equals or starts with `idOrPrefix`; errors when none or several match. */
export function resolveSession(
	sessions: readonly StoredSession[],
	idOrPrefix: string,
): { session: StoredSession } | { error: string } {
	const exact = sessions.find((s) => s.id === idOrPrefix);
	if (exact) return { session: exact };
	const matches = sessions.filter((s) => s.id.startsWith(idOrPrefix));
	if (matches.length === 1 && matches[0]) return { session: matches[0] };
	return {
		error:
			matches.length === 0
				? `no session matches "${idOrPrefix}"`
				: `"${idOrPrefix}" is ambiguous: ${matches.map((s) => s.id).join(", ")}`,
	};
}

/** One line per session, newest first. */
export function renderSessions(sessions: readonly StoredSession[]): string {
	if (sessions.length === 0) return "(no sessions)";
	const rows = [...sessions]
		.sort((a, b) => b.startedAt - a.startedAt)
		.map((s) =>
			[
				s.id.slice(0, 8),
				new Date(s.startedAt).toISOString().replace("T", " ").slice(0, 19),
				s.endedAt === null ? "open" : formatDuration(s.endedAt - s.startedAt),
				s.label ?? "-",
				s.cwd,
			].join("  "),
		);
	return ["id        started              length  label  cwd", ...rows].join("\n");
}

/** A session's timeline: one line per event, with a metrics header. */
export function renderTimeline(
	session: StoredSession,
	events: readonly StoredTraceEvent[],
	calls: readonly SidecarCallRecord[],
): string {
	const m = computeTraceMetrics(events, calls);
	const header = [
		`session ${session.id} · ${session.harness} · ${session.cwd}${session.label ? ` · ${session.label}` : ""}`,
		`turns ${m.turns} · llm requests ${m.llmRequests} · tokens in ${m.inputTokens} cached ${m.cachedTokens} out ${m.outputTokens} · cache hit ${percent(m.cacheHitRate)} · prefix kept ${percent(m.prefixKeptRate)}`,
		`tools ${m.toolCalls} (errors ${m.toolErrors}, repeated ${m.repeatedToolErrors}) · injections ${m.injections} · continuations ${m.continuations} · compactions ${m.compactions} · sidecar calls ${m.sidecarCalls} (${m.sidecarTokens} tok, ${m.sidecarFailures} failed)`,
		"",
	];
	const start = events[0]?.ts ?? session.startedAt;
	const lines = events.map((e) => {
		const turn = e.turn === null ? "  " : String(e.turn).padStart(2);
		const tag = e.synthetic ? ` [exo${e.module ? `:${e.module}` : ""}]` : "";
		return `${formatOffset(e.ts - start)} t${turn} ${e.kind}${tag}  ${summarizeEvent(e)}`.trimEnd();
	});
	return [...header, ...lines].join("\n");
}

/** Sidecar calls, then per-module totals. */
export function renderCalls(calls: readonly SidecarCallRecord[]): string {
	if (calls.length === 0) return "(no sidecar calls)";
	const rows = calls.map(
		(c) =>
			`${c.module.padEnd(12)} ${c.priority.padEnd(11)} ${c.outcome.padEnd(9)} queue ${String(c.queueMs).padStart(5)} ms  latency ${String(c.latencyMs).padStart(6)} ms  prompt ${c.usage.promptTokens} (cached ${c.usage.cachedTokens ?? "?"}) out ${c.usage.completionTokens}${c.error ? `  ${oneLine(c.error)}` : ""}`,
	);
	const byModule = new Map<string, SidecarCallRecord[]>();
	for (const c of calls) byModule.set(c.module, [...(byModule.get(c.module) ?? []), c]);
	const totals = [...byModule].map(([module, list]) => {
		const ok = list.filter((c) => c.outcome === "ok").length;
		const tokens = list.reduce((sum, c) => sum + c.usage.promptTokens + c.usage.completionTokens, 0);
		const latencies = list.map((c) => c.latencyMs).sort((a, b) => a - b);
		return `${module}: ${list.length} calls, ${ok} ok, ${tokens} tokens, p50 ${median(latencies)} ms, max ${latencies.at(-1) ?? 0} ms`;
	});
	return [...rows, "", ...totals].join("\n");
}

export interface SessionData {
	readonly session: StoredSession;
	readonly events: readonly StoredTraceEvent[];
	readonly calls: readonly SidecarCallRecord[];
}

/**
 * Real-session metrics (D-014): what the modules did across the user's own sessions, the numbers
 * that decide whether a module earns its place outside the eval.
 */
export function renderStats(data: readonly SessionData[]): string {
	if (data.length === 0) return "(no sessions)";
	const metrics = data.map((d) => computeTraceMetrics(d.events, d.calls));
	const events = data.flatMap((d) => d.events);
	const sum = (pick: (m: (typeof metrics)[number]) => number) => metrics.reduce((a, m) => a + pick(m), 0);
	const actions = countBy(
		events.filter((e) => e.kind === "exo.action"),
		(e) => str(asRecord(e.data)["action"]),
	);
	const rewrites = countBy(
		events.filter((e) => e.kind === "exo.rewrite"),
		(e) => e.module ?? "?",
	);
	const memory = countBy(
		events.filter((e) => e.kind === "exo.memory"),
		(e) => str(asRecord(e.data)["action"]),
	);
	const suggested = actions.get("suggested") ?? 0;
	const accepted = actions.get("accepted") ?? 0;
	const callsByModule = countBy(
		data.flatMap((d) => d.calls),
		(c) => c.module,
	);
	const tokensByModule = new Map<string, number>();
	for (const c of data.flatMap((d) => d.calls)) {
		tokensByModule.set(c.module, (tokensByModule.get(c.module) ?? 0) + c.usage.promptTokens + c.usage.completionTokens);
	}
	const toolErrors = sum((m) => m.toolErrors);
	return [
		`${data.length} sessions · ${sum((m) => m.turns)} turns · ${sum((m) => m.toolCalls)} tool calls · ${toolErrors} tool errors (${toolErrors > 0 ? percent(sum((m) => m.repeatedToolErrors) / toolErrors) : "-"} repeats)`,
		`main tokens: in ${sum((m) => m.inputTokens)} · cached ${sum((m) => m.cachedTokens)} · out ${sum((m) => m.outputTokens)} · compactions ${sum((m) => m.compactions)}`,
		`supervisor: ${sum((m) => m.verdicts.complete + m.verdicts.incomplete + m.verdicts.failed + m.verdicts.uncertain)} verdicts (c/i/f/u ${["complete", "incomplete", "failed", "uncertain"].map((v) => sum((m) => m.verdicts[v as "complete"])).join("/")}) · ${suggested} suggestions, ${accepted} accepted${suggested > 0 ? ` (${percent(accepted / suggested)})` : ""} · ${actions.get("continued") ?? 0} auto-continued`,
		`rewrites: ${[...rewrites].map(([module, n]) => `${module} ${n}`).join(", ") || "none"}`,
		`memory: ${[...memory].map(([action, n]) => `${action} ${n}`).join(", ") || "none"}`,
		`sidecars: ${[...callsByModule].map(([module, n]) => `${module} ${n} calls/${tokensByModule.get(module) ?? 0} tok`).join(", ") || "none"} · ${sum((m) => m.sidecarFailures)} failed`,
	].join("\n");
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
	return counts;
}

/** A one-line, kind-specific summary of an event's data. */
export function summarizeEvent(event: Pick<StoredTraceEvent, "kind" | "data">): string {
	const d = asRecord(event.data);
	switch (event.kind) {
		case "user.input":
			return `(${str(d["source"])}) ${snippet(d["text"])}`;
		case "message":
			return `${str(d["role"])}${d["customType"] ? `/${str(d["customType"])}` : ""}: ${snippet(contentText(d["content"]))}`;
		case "tool.call":
			return `${str(d["toolName"])} ${snippet(JSON.stringify(d["input"] ?? {}))}`;
		case "tool.result": {
			const exit = d["exitCode"] === null || d["exitCode"] === undefined ? "" : ` exit ${str(d["exitCode"])}`;
			return `${str(d["toolName"])}${exit}${d["isError"] === true ? " ERROR" : ""}: ${snippet(contentText(d["content"]))}`;
		}
		case "llm.request": {
			const hashes = Array.isArray(d["messageHashes"]) ? d["messageHashes"].length : 0;
			return `${str(d["model"])} · ${hashes} messages · ${str(d["messageChars"])} chars`;
		}
		case "turn.end":
			return `stop ${str(d["stopReason"])} · ${str(d["toolResults"])} tool results`;
		case "exo.verdict":
			return `${str(d["verdict"])}: ${snippet(d["reason"])}`;
		case "exo.action":
			return [str(d["action"]), d["reason"], d["missing"]]
				.filter((v) => v !== undefined && v !== "")
				.map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
				.join(" · ");
		case "exo.ledger":
			return d["is_task"] === false ? "not a task" : snippet(JSON.stringify(d["criteria"] ?? d));
		case "model.change":
			return `${str(d["previous"])} → ${str(d["model"])}`;
		default:
			return snippet(JSON.stringify(event.data));
	}
}

function contentText(content: JsonValue | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => asRecord(part))
		.filter((part) => part["type"] === "text")
		.map((part) => str(part["text"]))
		.join(" ");
}

function asRecord(value: JsonValue | undefined): { readonly [key: string]: JsonValue } {
	return isJsonObject(value) ? value : {};
}

function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: JsonValue | undefined): string {
	if (value === undefined || value === null) return "-";
	return typeof value === "string" ? value : JSON.stringify(value);
}

function snippet(value: JsonValue | undefined): string {
	const text = oneLine(typeof value === "string" ? value : str(value));
	return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function percent(rate: number | null): string {
	return rate === null ? "-" : `${Math.round(rate * 100)}%`;
}

function median(sorted: readonly number[]): number {
	return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function formatOffset(ms: number): string {
	return `+${(ms / 1000).toFixed(1)}s`.padStart(8);
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
