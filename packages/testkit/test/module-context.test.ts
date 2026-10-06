import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createTestModuleContext } from "../src/index.ts";

describe("test module context: persisted state (D-078)", () => {
	it("captures what a module saves and hands it to the next instance", () => {
		const first = createTestModuleContext({ cwd: tmpdir() });
		expect(first.context.sessionId).toBe("test-session");
		expect(first.context.savedState).toBeUndefined();
		const counts = { failures: 1 };
		first.context.saveState(counts);
		counts.failures = 2;
		first.context.saveState(counts);
		// A copy is kept each time, as a session file would: later changes to the object do not reach it.
		expect(first.states).toEqual([{ failures: 1 }, { failures: 2 }]);

		const savedState = first.states.at(-1);
		const next = createTestModuleContext({
			cwd: tmpdir(),
			sessionId: "resumed",
			...(savedState === undefined ? {} : { savedState }),
		});
		expect(next.context.sessionId).toBe("resumed");
		expect(next.context.savedState).toEqual({ failures: 2 });
		expect(next.states).toEqual([]);
	});
});

const REQUEST = { module: "test", priority: "interactive", request: { messages: [], maxTokens: 16 } } as const;
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createTestModuleContext", () => {
	it("answers sidecar calls from the script and records the requests", async () => {
		const test = createTestModuleContext({ cwd: tmpdir(), reply: () => ({ answer: 1 }) });
		const result = await test.context.pool()?.run(REQUEST);
		expect(result).toMatchObject({ ok: true, value: '{"answer":1}' });
		expect(test.requests).toHaveLength(1);
		const failing = createTestModuleContext({ cwd: tmpdir(), reply: () => new Error("engine down") });
		expect(await failing.context.pool()?.run(REQUEST)).toMatchObject({ ok: false, outcome: "error" });
		expect(createTestModuleContext({ cwd: tmpdir() }).context.pool()).toBeUndefined();
	});

	it("stops when the call is cancelled, as a real client does, instead of carrying on", async () => {
		// The scripted reply is not valid for the schema and arrives after the caller has cancelled.
		// A real client has thrown by then. Before D-079 the fake handed the late reply over, and the
		// pool went on to send the repair request of a call nobody was waiting for: tests counted
		// requests a real session never makes.
		const test = createTestModuleContext({
			cwd: tmpdir(),
			reply: async () => {
				await later(60);
				return "not json";
			},
		});
		const controller = new AbortController();
		const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
		const pending = test.context.pool()?.run({ ...REQUEST, schema: schema as never, signal: controller.signal });
		setTimeout(() => controller.abort(), 15);
		expect(await pending).toMatchObject({ ok: false, outcome: "cancelled" });
		await later(150);
		expect(test.requests).toHaveLength(1);
	});

	it("fails at once on a signal that has already fired", async () => {
		const test = createTestModuleContext({ cwd: tmpdir(), reply: () => new Promise<string>(() => {}) });
		const result = await test.context.pool()?.run({ ...REQUEST, signal: AbortSignal.abort() });
		expect(result).toMatchObject({ ok: false, outcome: "cancelled" });
	});
});
