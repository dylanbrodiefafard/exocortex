import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerTraceRecorder } from "../src/trace-recorder.ts";
import { type AdapterHarness, createAdapterHarness } from "./harness.ts";

let harness: AdapterHarness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

function setup(config: (dir: string) => Record<string, unknown>, env: Record<string, string> = {}) {
	harness = createAdapterHarness(config);
	registerTraceRecorder(harness.pi.api, {
		runtime: harness.runtime,
		env: { ...harness.env, ...env },
		onError: harness.onError,
	});
	return harness;
}

const traced = (dir: string) => ({ trace: { enabled: true, dbPath: join(dir, "trace.db") } });

describe("trace recorder (in process)", () => {
	it("records a whole session as harness-agnostic trace events", async () => {
		const h = setup(traced, { EXO_TRACE_LABEL: "run-1" });
		const ctx = h.pi.ctx({ model: { provider: "local", id: "qwen" } });
		await h.pi.emit("session_start", { reason: "startup" }, ctx);
		const sessionId = h.runtime.traceSession?.id;
		await h.pi.emit("input", { text: "fix it", source: "interactive", images: [{}] });
		await h.pi.emit("turn_start", { turnIndex: 0 });
		await h.pi.emit("before_provider_request", {
			payload: { model: "qwen", messages: [{ role: "system", content: "sys" }], tools: [] },
		});
		await h.pi.emit("message_end", { message: { role: "assistant", content: "ok" } });
		await h.pi.emit("message_end", { message: { role: "custom", customType: "exo.supervisor", content: "go" } });
		await h.pi.emit("tool_call", { toolCallId: "t1", toolName: "bash", input: { command: "ls" } });
		await h.pi.emit("tool_result", {
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			structuredContent: { exitCode: 0 },
			content: [{ type: "text", text: "a" }],
		});
		await h.pi.emit("turn_end", {
			turnIndex: 0,
			message: { stopReason: "stop", usage: { input: 3 } },
			toolResults: [],
		});
		await h.pi.emit("session_compact", { reason: "threshold", fromExtension: false, willRetry: false });
		await h.pi.emit("session_compact_failed", {
			reason: "overflow",
			errorMessage: "still too long",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		});
		await h.pi.emit("model_select", {
			model: { provider: "p", id: "b" },
			previousModel: { provider: "p", id: "a" },
			source: "set",
		});
		await h.pi.emit("model_select", { model: { provider: "p", id: "c" }, source: "cycle" });
		await h.pi.emit("agent_settled");
		await h.pi.emit("session_shutdown", { reason: "reload" });
		expect(h.runtime.traceSession).toBeUndefined();
		// The session's end closed the store (D-078); the next activation opens it again.
		expect(h.runtime.store).toBeUndefined();
		h.runtime.activate(h.dir);

		const store = h.runtime.store;
		if (!store || !sessionId) throw new Error("no trace");
		const [session] = store.sessions({ label: "run-1" });
		expect(session?.harness).toBe("pi");
		expect(session?.meta).toMatchObject({ reason: "startup", model: "local/qwen" });
		expect(session?.endedAt).not.toBeNull();
		const events = store.events(sessionId);
		expect(events.map((e) => e.kind)).toEqual([
			"session.start",
			"user.input",
			"llm.request",
			"message",
			"message",
			"tool.call",
			"tool.result",
			"turn.end",
			"compaction",
			"compaction.failed",
			"model.change",
			"model.change",
			"agent.settled",
			"session.end",
		]);
		expect(events[1]?.data).toEqual({ text: "fix it", source: "interactive", images: 1 });
		expect(events[1]?.turn).toBeNull();
		expect(events[2]?.turn).toBe(0);
		expect(events[4]).toMatchObject({ synthetic: true, module: "supervisor" });
		expect(events[6]?.data).toMatchObject({ exitCode: 0 });
		expect(events[9]?.data).toMatchObject({ reason: "overflow", errorMessage: "still too long", aborted: false });
		expect(events[11]?.data).toMatchObject({ model: "p/c", previous: null });
	});

	it("closes the store when pi quits", async () => {
		const h = setup(traced);
		await h.pi.emit("session_start", { reason: "startup" });
		await h.pi.emit("session_shutdown", { reason: "quit" });
		expect(h.runtime.store).toBeUndefined();
	});

	it("warns about config problems and records nothing when disabled", async () => {
		const h = setup(() => ({ pool: { maxConcurrent: 1, reservedForMain: 1 } }));
		await h.pi.emit("session_start", { reason: "startup" });
		await h.pi.emit("input", { text: "x", source: "interactive" });
		expect(h.runtime.traceSession).toBeUndefined();
		const [notice] = h.pi.ui.filter((c) => c.method === "notify");
		expect(notice?.args[0]).toContain("Exocortex disabled by config problems");
	});

	it("records nothing with tracing off and swallows handler errors", async () => {
		const h = setup(() => ({}));
		await h.pi.emit("session_start", { reason: "startup" });
		expect(h.runtime.traceSession).toBeUndefined();
		await h.pi.emit("turn_end", { turnIndex: 0, message: {}, toolResults: undefined });
		expect(h.errors.map((e) => e.where)).toEqual(["turn_end"]);
	});
});
