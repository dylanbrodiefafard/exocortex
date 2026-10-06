import { type FakeOpenAIServer, startFakeOpenAIServer } from "@exocortex/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { registerExoCommand } from "../src/command.ts";
import { registerSidecars } from "../src/sidecars.ts";
import { type AdapterHarness, createAdapterHarness } from "./harness.ts";

let harness: AdapterHarness | undefined;
let server: FakeOpenAIServer | undefined;
afterEach(async () => {
	harness?.cleanup();
	await server?.close();
	harness = undefined;
	server = undefined;
});

function setup(config: Record<string, unknown>) {
	harness = createAdapterHarness(config);
	registerSidecars(harness.pi.api, { runtime: harness.runtime, env: harness.env, onError: harness.onError });
	registerExoCommand(harness.pi.api, harness.runtime);
	return harness;
}

const lastNotify = (h: AdapterHarness) =>
	h.pi.ui.filter((c) => c.method === "notify").at(-1)?.args as [string, string] | undefined;

describe("sidecar lifecycle", () => {
	it("builds a pool from the configured engine and pings it", async () => {
		server = await startFakeOpenAIServer([{ kind: "text", text: "pong", cachedTokens: 3 }]);
		const h = setup({ engine: { baseUrl: server.baseUrl, model: "fake-model" } });
		await h.pi.emit("session_start");
		expect(h.runtime.pool).toBeDefined();
		await h.pi.command("exo", "ping");
		const [text, level] = lastNotify(h) ?? [];
		expect(level).toBe("info");
		expect(text).toMatch(/sidecar OK in \d+ ms .*3 cached.*pong/);
		await h.pi.emit("session_shutdown");
		expect(h.runtime.pool).toBeUndefined();
	});

	it("reports a failing engine without throwing", async () => {
		server = await startFakeOpenAIServer([{ kind: "error", status: 500, message: "boom" }]);
		const h = setup({ engine: { baseUrl: server.baseUrl, model: "fake-model" } });
		await h.pi.emit("session_start");
		await h.pi.command("exo", "ping");
		expect(lastNotify(h)?.[1]).toBe("error");
	});

	it("falls back to an openai-completions main model and follows model changes", async () => {
		server = await startFakeOpenAIServer([], { fallback: { kind: "text", text: "pong" } });
		const h = setup({});
		const model = { api: "openai-completions", provider: "local", id: "fake-model", baseUrl: server.baseUrl };
		await h.pi.emit("session_start", {}, h.pi.ctx({ model }));
		const first = h.runtime.pool;
		expect(first).toBeDefined();
		await h.pi.emit("model_select", {}, h.pi.ctx({ model }));
		expect(h.runtime.pool).not.toBe(first);
		await h.pi.command("exo", "ping");
		expect(lastNotify(h)?.[1]).toBe("info");
		expect(server.requests).toHaveLength(1);
	});

	it("does not rebuild on model change when the engine is pinned", async () => {
		server = await startFakeOpenAIServer([]);
		const h = setup({ engine: { baseUrl: server.baseUrl, model: "m" } });
		await h.pi.emit("session_start");
		const pool = h.runtime.pool;
		await h.pi.emit("model_select");
		expect(h.runtime.pool).toBe(pool);
	});

	it("pings the embeddings server too, and says so when it does not answer", async () => {
		server = await startFakeOpenAIServer([
			{ kind: "text", text: "pong" },
			{ kind: "text", text: "pong" },
		]);
		const h = setup({ engine: { baseUrl: server.baseUrl, model: "fake-model" } });
		await h.pi.emit("session_start");
		h.runtime.embedder = { model: "small-embed", embed: async () => [new Float32Array(384)] };
		await h.pi.command("exo", "ping");
		expect(lastNotify(h)?.[0]).toMatch(/^Exocortex embeddings OK in \d+ ms \(small-embed, 384 dimensions\)$/);
		h.runtime.embedder = { model: "small-embed", embed: async () => undefined };
		await h.pi.command("exo", "ping");
		expect(lastNotify(h)).toEqual([
			"Exocortex embeddings (small-embed) did not answer: modules fall back to keywords",
			"warning",
		]);
	});

	it("builds an embedder only when an embeddings server is configured", async () => {
		server = await startFakeOpenAIServer([]);
		const engine = { baseUrl: server.baseUrl, model: "m" };
		const without = setup({ engine });
		await without.pi.emit("session_start");
		expect(without.runtime.embedder).toBeUndefined();
		without.cleanup();
		const h = setup({ engine, embeddings: { baseUrl: "http://127.0.0.1:9/v1", model: "small-embed" } });
		await h.pi.emit("session_start");
		expect(h.runtime.embedder?.model).toBe("small-embed");
		// Nothing listens there: the embedder reports it and callers fall back.
		expect(await h.runtime.embedder?.embed(["x"])).toBeUndefined();
		expect(h.errors.map((e) => e.where)).toEqual(["embeddings"]);
	});

	it("reports a missing engine once and leaves the pool unset", async () => {
		const h = setup({});
		await h.pi.emit("session_start", {}, h.pi.ctx({ model: { api: "anthropic-messages", provider: "x", id: "y" } }));
		expect(h.runtime.pool).toBeUndefined();
		expect(h.errors.map((e) => e.where)).toEqual(["sidecars"]);
		await h.pi.command("exo", "ping");
		expect(lastNotify(h)).toEqual(["Exocortex: no sidecar engine configured", "warning"]);
	});

	it("holds background work while the main agent runs and cancels hot-path work on user input", async () => {
		server = await startFakeOpenAIServer([], { fallback: { kind: "text", text: "ok", delayMs: 200 } });
		const h = setup({ engine: { baseUrl: server.baseUrl, model: "m" } });
		await h.pi.emit("session_start");
		const pool = h.runtime.pool;
		if (!pool) throw new Error("no pool");
		await h.pi.emit("agent_start");
		const request = { messages: [{ role: "user" as const, content: "x" }], maxTokens: 4 };
		const background = pool.run({ module: "t", priority: "background", timeoutMs: 5_000, request });
		const interactive = pool.run({ module: "t", priority: "interactive", timeoutMs: 5_000, request });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(pool.stats().queued.background).toBe(1);
		await h.pi.emit("input", { text: "new task", source: "interactive" });
		expect((await interactive).ok).toBe(false);
		await h.pi.emit("agent_settled");
		expect((await background).ok).toBe(true);
	});

	it("ignores extension-originated input", async () => {
		server = await startFakeOpenAIServer([], { fallback: { kind: "text", text: "ok", delayMs: 100 } });
		const h = setup({ engine: { baseUrl: server.baseUrl, model: "m" } });
		await h.pi.emit("session_start");
		const pool = h.runtime.pool;
		if (!pool) throw new Error("no pool");
		const call = pool.run({
			module: "t",
			priority: "interactive",
			timeoutMs: 5_000,
			request: { messages: [{ role: "user", content: "x" }], maxTokens: 4 },
		});
		await h.pi.emit("input", { text: "continue", source: "extension" });
		expect((await call).ok).toBe(true);
	});

	it("leaves the turn's sidecar work alone when the user steers or follows up mid-run (B7)", async () => {
		server = await startFakeOpenAIServer([], { fallback: { kind: "text", text: "ok", delayMs: 100 } });
		const h = setup({ engine: { baseUrl: server.baseUrl, model: "m" } });
		await h.pi.emit("session_start");
		const pool = h.runtime.pool;
		if (!pool) throw new Error("no pool");
		const request = { messages: [{ role: "user" as const, content: "x" }], maxTokens: 4 };
		const call = () => pool.run({ module: "t", priority: "interactive", timeoutMs: 5_000, request });
		const steered = call();
		await h.pi.emit("input", { text: "use the other file", source: "interactive", streamingBehavior: "steer" });
		const followed = call();
		await h.pi.emit("input", { text: "then run the tests", source: "rpc", streamingBehavior: "followUp" });
		expect([(await steered).ok, (await followed).ok]).toEqual([true, true]);
	});

	describe("rebuilding the pool (B9)", () => {
		/** A main model whose key lookup resolves when the test says so. */
		function slowModel(baseUrl: string) {
			const releases: (() => void)[] = [];
			const model = { api: "openai-completions", provider: "local", id: "fake-model", baseUrl };
			const modelRegistry = {
				getApiKeyForProvider: () => new Promise<undefined>((resolve) => releases.push(() => resolve(undefined))),
			};
			return { releases, slow: { model, modelRegistry }, fast: { model } };
		}
		const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

		it("keeps the old pool until the new one is ready, and carries over that the agent is running", async () => {
			server = await startFakeOpenAIServer([], { fallback: { kind: "text", text: "ok", delayMs: 50 } });
			const h = setup({});
			const { releases, slow, fast } = slowModel(server.baseUrl);
			await h.pi.emit("session_start", {}, h.pi.ctx(fast));
			const first = h.runtime.pool;
			expect(first).toBeDefined();
			await h.pi.emit("agent_start");
			const rebuilding = h.pi.emit("model_select", {}, h.pi.ctx(slow));
			await tick();
			// The key lookup is still running: modules must find a pool, not a gap.
			expect(h.runtime.pool).toBe(first);
			releases[0]?.();
			await rebuilding;
			const second = h.runtime.pool;
			expect(second).toBeDefined();
			expect(second).not.toBe(first);
			const request = { messages: [{ role: "user" as const, content: "x" }], maxTokens: 4 };
			// The old pool is closed; the new one knows the agent is mid-run and holds background work.
			expect((await first?.run({ module: "t", priority: "interactive", timeoutMs: 1_000, request }))?.ok).toBe(false);
			const background = second?.run({ module: "t", priority: "background", timeoutMs: 5_000, request });
			await tick();
			expect(second?.stats().queued.background).toBe(1);
			await h.pi.emit("agent_settled");
			expect((await background)?.ok).toBe(true);
		});

		it("drops a rebuild that a newer one, or the session's end, overtook", async () => {
			server = await startFakeOpenAIServer([]);
			const h = setup({});
			const { releases, slow, fast } = slowModel(server.baseUrl);
			await h.pi.emit("session_start", {}, h.pi.ctx(fast));
			const overtaken = h.pi.emit("model_select", {}, h.pi.ctx(slow));
			await h.pi.emit("model_select", {}, h.pi.ctx(fast));
			const current = h.runtime.pool;
			releases[0]?.();
			await overtaken;
			expect(h.runtime.pool).toBe(current);

			const late = h.pi.emit("model_select", {}, h.pi.ctx(slow));
			await h.pi.emit("session_shutdown");
			releases[1]?.();
			await late;
			// No pool is left behind for a session that is gone.
			expect(h.runtime.pool).toBeUndefined();
			expect(h.runtime.embedder).toBeUndefined();
		});
	});

	it("builds nothing when Exocortex is disabled", async () => {
		const h = setup({ enabled: false, engine: { baseUrl: "http://127.0.0.1:1/v1", model: "m" } });
		await h.pi.emit("session_start");
		expect(h.runtime.pool).toBeUndefined();
		expect(h.errors).toEqual([]);
	});
});
