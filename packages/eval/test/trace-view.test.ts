import { openTraceStore, type SidecarCallRecord, type StoredSession } from "@exocortex/core";
import { describe, expect, it } from "vitest";
import { renderCalls, renderSessions, renderTimeline, resolveSession, summarizeEvent } from "../src/trace-view.ts";

const session = (id: string, startedAt = 0, extra: Partial<StoredSession> = {}): StoredSession => ({
	id,
	harness: "pi",
	harnessSessionId: null,
	cwd: "/w",
	label: null,
	startedAt,
	endedAt: null,
	meta: {},
	...extra,
});

const call = (module: string, outcome: SidecarCallRecord["outcome"], latencyMs: number): SidecarCallRecord => ({
	module,
	priority: "interactive",
	outcome,
	promptHash: "h",
	startedAt: 0,
	queueMs: 1,
	latencyMs,
	attempts: 1,
	maxTokens: 64,
	usage: { promptTokens: 100, cachedTokens: 80, completionTokens: 10 },
	error: outcome === "ok" ? null : "timed\nout",
});

describe("resolveSession", () => {
	const sessions = [session("abc123"), session("abd456"), session("xyz")];
	it("matches exact ids and unique prefixes", () => {
		expect(resolveSession(sessions, "xyz")).toEqual({ session: sessions[2] });
		expect(resolveSession(sessions, "abc")).toEqual({ session: sessions[0] });
	});
	it("rejects unknown and ambiguous prefixes", () => {
		expect(resolveSession(sessions, "q")).toEqual({ error: 'no session matches "q"' });
		expect(resolveSession(sessions, "ab")).toEqual({ error: '"ab" is ambiguous: abc123, abd456' });
	});
});

describe("renderSessions", () => {
	it("lists newest first with length and label", () => {
		const text = renderSessions([
			session("old-session", 0, { endedAt: 125_000 }),
			session("new-session", 10_000, { label: "run-1" }),
		]);
		const [, first, second] = text.split("\n");
		expect(first).toMatch(/^new-sess .* open {2}run-1 {2}\/w$/);
		expect(second).toMatch(/^old-sess .* 2m05s {2}- {2}\/w$/);
		expect(renderSessions([])).toBe("(no sessions)");
	});
});

describe("summarizeEvent", () => {
	it("summarizes each kind on one line", () => {
		expect(summarizeEvent({ kind: "user.input", data: { source: "interactive", text: "fix\nit" } })).toBe(
			"(interactive) fix it",
		);
		expect(
			summarizeEvent({
				kind: "message",
				data: { role: "custom", customType: "exo.supervisor", content: [{ type: "text", text: "go on" }] },
			}),
		).toBe("custom/exo.supervisor: go on");
		expect(summarizeEvent({ kind: "tool.call", data: { toolName: "bash", input: { command: "ls" } } })).toBe(
			'bash {"command":"ls"}',
		);
		expect(
			summarizeEvent({
				kind: "tool.result",
				data: { toolName: "bash", exitCode: 2, isError: true, content: [{ type: "text", text: "boom" }] },
			}),
		).toBe("bash exit 2 ERROR: boom");
		expect(
			summarizeEvent({ kind: "llm.request", data: { model: "q", messageHashes: ["a", "b"], messageChars: 9 } }),
		).toBe("q · 2 messages · 9 chars");
		expect(summarizeEvent({ kind: "turn.end", data: { stopReason: "toolUse", toolResults: 1 } })).toBe(
			"stop toolUse · 1 tool results",
		);
		expect(summarizeEvent({ kind: "exo.verdict", data: { verdict: "incomplete", reason: "tests" } })).toBe(
			"incomplete: tests",
		);
		expect(summarizeEvent({ kind: "exo.action", data: { action: "suggested", missing: ["a"] } })).toBe(
			'suggested · ["a"]',
		);
		expect(summarizeEvent({ kind: "exo.ledger", data: { is_task: false } })).toBe("not a task");
		expect(summarizeEvent({ kind: "model.change", data: { previous: null, model: "p/m" } })).toBe("- → p/m");
		expect(summarizeEvent({ kind: "agent.settled", data: {} })).toBe("{}");
	});

	it("truncates long text", () => {
		const text = summarizeEvent({ kind: "user.input", data: { source: "x", text: "a".repeat(500) } });
		expect(text.length).toBeLessThan(120);
		expect(text.endsWith("…")).toBe(true);
	});
});

describe("renderTimeline", () => {
	it("prints metrics and one line per event from a real store", () => {
		let now = 1_000;
		const store = openTraceStore({ path: ":memory:", now: () => now });
		const trace = store.startSession({ harness: "pi", cwd: "/w", label: "t" });
		trace.append({ kind: "user.input", data: { text: "do it", source: "interactive" } });
		now += 1_500;
		trace.append({ kind: "turn.end", turn: 0, data: { stopReason: "stop", toolResults: 0 } });
		trace.append({ kind: "exo.verdict", synthetic: true, module: "supervisor", data: { verdict: "complete" } });
		store.flush();
		const [stored] = store.sessions();
		if (!stored) throw new Error("no session");
		const text = renderTimeline(stored, store.events(stored.id), [call("supervisor", "ok", 10)]);
		expect(text).toContain("· t\n");
		expect(text).toContain("sidecar calls 1 (110 tok, 0 failed)");
		expect(text).toContain("   +0.0s t   user.input  (interactive) do it");
		expect(text).toContain("   +1.5s t 0 turn.end  stop stop");
		expect(text).toContain("exo.verdict [exo:supervisor]  complete: -");
		store.close();
	});
});

describe("renderCalls", () => {
	it("lists calls and per-module totals", () => {
		const text = renderCalls([
			call("supervisor", "ok", 10),
			call("supervisor", "timeout", 30),
			call("triage", "ok", 5),
		]);
		expect(text).toContain("timed out");
		expect(text).toContain("supervisor: 2 calls, 1 ok, 220 tokens, p50 10 ms, max 30 ms");
		expect(text).toContain("triage: 1 calls, 1 ok, 110 tokens, p50 5 ms, max 5 ms");
		expect(renderCalls([])).toBe("(no sidecar calls)");
	});
});
