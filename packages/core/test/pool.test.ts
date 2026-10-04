import { startFakeOpenAIServer } from "@exocortex/testkit";
import fc from "fast-check";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExoConfig } from "../src/config.ts";
import {
	type ChatRequest,
	type ChatResponse,
	createOpenAIClient,
	type InferenceClient,
	InferenceError,
} from "../src/inference/client.ts";
import { ENGINE_PROFILES, type EngineTarget } from "../src/inference/engine.ts";
import {
	createSidecarPool,
	DEFAULT_MODULE_LIMITS,
	type ModuleLimits,
	type PoolStats,
	type SidecarCallRecord,
	type SidecarPriority,
} from "../src/inference/pool.ts";

const TARGET: EngineTarget = {
	baseUrl: "http://x/v1",
	model: "m",
	apiKey: undefined,
	features: ENGINE_PROFILES.generic,
};
const POOL: ExoConfig["pool"] = {
	maxConcurrent: 4,
	reservedForMain: 2,
	timeoutMs: 5_000,
	sessionTokenBudget: 0,
	backgroundWhenIdleOnly: true,
};

interface PendingCall {
	readonly request: ChatRequest;
	readonly signal: AbortSignal | undefined;
	reply(text?: string, tokens?: number): void;
	fail(error: Error): void;
}

/** A client whose responses the test releases by hand. */
function manualClient() {
	const pending: PendingCall[] = [];
	const started: ChatRequest[] = [];
	const client: InferenceClient = {
		chat(request, signal) {
			started.push(request);
			return new Promise<ChatResponse>((resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new InferenceError("aborted", "aborted")));
				pending.push({
					request,
					signal,
					reply: (text = "ok", tokens = 10) =>
						resolve({
							text,
							finishReason: "stop",
							usage: { promptTokens: tokens, completionTokens: 0, cachedTokens: null },
						}),
					fail: reject,
				});
			});
		},
	};
	return { client, pending, started };
}

function makePool(
	overrides: Partial<ExoConfig["pool"]> = {},
	limits: Partial<ModuleLimits> = {},
	client = manualClient(),
) {
	const records: SidecarCallRecord[] = [];
	const pool = createSidecarPool({
		client: client.client,
		target: TARGET,
		config: { ...POOL, ...overrides },
		moduleLimits: () => ({ ...DEFAULT_MODULE_LIMITS, maxCallsPerTurn: 100, ...limits }),
		onRecord: (r) => records.push(r),
	});
	return { pool, records, ...client };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function call(module: string, priority: SidecarPriority = "interactive", text = module) {
	return { module, priority, request: { messages: [{ role: "user", content: text }], maxTokens: 64 } } as const;
}

describe("sidecar pool scheduling", () => {
	it("runs at most maxConcurrent - reservedForMain calls, highest priority first, FIFO within a class", async () => {
		const { pool, pending, started } = makePool();
		const results = [
			pool.run(call("a", "background")),
			pool.run(call("b", "interactive")),
			pool.run(call("c", "interactive")),
			pool.run(call("d", "critical")),
			pool.run(call("e", "background")),
		];
		await flush();
		// Each run() pumps immediately, so a and b take the two free slots in submission order.
		expect(started.map((r) => r.messages[0]?.["content"])).toEqual(["a", "b"]);
		expect(pool.stats()).toMatchObject({ running: 2, queued: { critical: 1, interactive: 1, background: 1 } });

		pending[0]?.reply();
		await flush();
		expect(started.at(-1)?.messages[0]?.["content"]).toBe("d"); // critical jumps the queue
		pending[1]?.reply();
		await flush();
		expect(started.at(-1)?.messages[0]?.["content"]).toBe("c");
		pending[2]?.reply();
		await flush();
		expect(started.at(-1)?.messages[0]?.["content"]).toBe("e");
		for (const p of pending.slice(3)) p.reply();
		expect((await Promise.all(results)).every((r) => r.ok)).toBe(true);
		expect(pool.stats().maxRunningObserved).toBe(2);
	});

	it("holds background work while the main agent is active", async () => {
		const { pool, pending, started } = makePool();
		pool.setMainActive(true);
		const bg = pool.run(call("bg", "background"));
		const fg = pool.run(call("fg", "interactive"));
		await flush();
		expect(started.map((r) => r.messages[0]?.["content"])).toEqual(["fg"]);
		pool.setMainActive(false);
		await flush();
		expect(started.map((r) => r.messages[0]?.["content"])).toEqual(["fg", "bg"]);
		for (const p of pending) p.reply();
		expect((await bg).ok && (await fg).ok).toBe(true);
	});

	it("sends engine priority only when supported and clamps max tokens per module", async () => {
		const c = manualClient();
		const pool = createSidecarPool({
			client: c.client,
			target: { ...TARGET, features: { ...TARGET.features, priority: true } },
			config: POOL,
			moduleLimits: () => ({ maxCallsPerTurn: 10, maxTokensPerCall: 16 }),
		});
		const result = pool.run(call("m", "background"));
		await flush();
		expect(c.started[0]).toMatchObject({ priority: 2, maxTokens: 16 });
		c.pending[0]?.reply("hi");
		expect(await result).toMatchObject({ ok: true, value: "hi" });
	});
});

describe("sidecar pool failure handling (never rejects)", () => {
	it("times out queued and running calls, aborting the request and freeing the slot", async () => {
		const { pool, pending, records } = makePool({ maxConcurrent: 3, reservedForMain: 2 });
		const running = pool.run({ ...call("slow"), timeoutMs: 30 });
		const queued = pool.run({ ...call("queued"), timeoutMs: 20 });
		await flush();
		expect(await queued).toMatchObject({ ok: false, outcome: "timeout", latencyMs: 0 });
		const slow = await running;
		expect(slow).toMatchObject({ ok: false, outcome: "timeout" });
		expect(pending[0]?.signal?.aborted).toBe(true);
		expect(pool.stats().running).toBe(0);
		expect(records.map((r) => r.outcome)).toEqual(["timeout", "timeout"]);
	});

	it("cancels via the caller's signal and via pool.cancel(filter)", async () => {
		const { pool } = makePool();
		const controller = new AbortController();
		const a = pool.run({ ...call("a"), signal: controller.signal });
		const b = pool.run(call("b", "background"));
		const c = pool.run(call("c", "interactive"));
		controller.abort();
		pool.cancel((job) => job.priority === "background");
		expect(await a).toMatchObject({ outcome: "cancelled" });
		expect(await b).toMatchObject({ outcome: "cancelled" });
		pool.close();
		expect(await c).toMatchObject({ outcome: "closed" });
		expect(await pool.run(call("late"))).toMatchObject({ ok: false, outcome: "closed" });
	});

	it("enforces per-turn call caps and resets them on beginTurn", async () => {
		const { pool, pending } = makePool({}, { maxCallsPerTurn: 1 });
		const first = pool.run(call("triage"));
		expect(await pool.run(call("triage"))).toMatchObject({ outcome: "rejected_turn_cap" });
		pool.beginTurn();
		const third = pool.run(call("triage"));
		await flush();
		for (const p of pending) p.reply();
		expect((await first).ok && (await third).ok).toBe(true);
	});

	it("rejects new calls once the session token budget is spent", async () => {
		const { pool, pending } = makePool({ sessionTokenBudget: 25 });
		const a = pool.run(call("a"));
		await flush();
		pending[0]?.reply("x", 30);
		expect((await a).ok).toBe(true);
		expect(await pool.run(call("b"))).toMatchObject({ outcome: "rejected_budget" });
		expect(pool.stats().sessionTokensUsed).toBe(30);
	});

	it("reports engine errors and invalid structured output as outcomes", async () => {
		const { pool, pending } = makePool();
		const failing = pool.run(call("err"));
		const structured = pool.run({ ...call("json"), schema: Type.Object({ n: Type.Number() }) });
		await flush();
		pending[0]?.fail(new InferenceError("http", "HTTP 500"));
		pending[1]?.reply("not json");
		await flush();
		pending[2]?.reply("still not json");
		expect(await failing).toMatchObject({ ok: false, outcome: "error" });
		expect(await structured).toMatchObject({ ok: false, outcome: "invalid_output", usage: { promptTokens: 20 } });
	});

	it("returns schema-validated values", async () => {
		const { pool, pending } = makePool();
		const result = pool.run({ ...call("json"), schema: Type.Object({ n: Type.Number() }) });
		await flush();
		pending[0]?.reply('{"n": 3}');
		expect(await result).toMatchObject({ ok: true, value: { n: 3 } });
	});
});

const RANK: Readonly<Record<SidecarPriority, number>> = { critical: 0, interactive: 1, background: 2 };

/** Calls that just started must not be outranked by anything still queued. */
function expectNotOutranked(fresh: readonly PendingCall[], stats: PoolStats): void {
	const queued = (["critical", "interactive", "background"] as const).filter((p) => stats.queued[p] > 0);
	const queuedBest = Math.min(...queued.map((p) => RANK[p]));
	for (const p of fresh) {
		const started = String(p.request.messages[0]?.["content"]).split(":")[0] as SidecarPriority;
		expect(RANK[started]).toBeLessThanOrEqual(queuedBest);
	}
}

describe("sidecar pool properties", () => {
	it("never exceeds its slots, always starts the highest-priority eligible call, and settles every call", async () => {
		const priority = fc.constantFrom<SidecarPriority>("critical", "interactive", "background");
		await fc.assert(
			fc.asyncProperty(
				fc.array(priority, { minLength: 1, maxLength: 25 }),
				fc.integer({ min: 2, max: 6 }),
				fc.integer({ min: 0, max: 1 }),
				fc.array(fc.nat(), { maxLength: 60 }),
				async (priorities, maxConcurrent, reserved, completionPicks) => {
					const slots = maxConcurrent - reserved;
					const c = manualClient();
					const pool = createSidecarPool({
						client: c.client,
						target: TARGET,
						config: { ...POOL, maxConcurrent, reservedForMain: reserved, backgroundWhenIdleOnly: false },
						moduleLimits: () => ({ maxCallsPerTurn: 1000, maxTokensPerCall: 64 }),
					});
					const results = priorities.map((p, i) => pool.run(call(`${i}`, p, `${p}:${i}`)));
					const live = new Set<PendingCall>();
					let seen = 0;
					let firstRound = true;
					const picks = [...completionPicks];
					for (;;) {
						await flush();
						const fresh = c.pending.slice(seen);
						seen = c.pending.length;
						for (const p of fresh) live.add(p);
						expect(pool.stats().running).toBeLessThanOrEqual(slots);
						// The first round is submission order (everything was enqueued synchronously); after
						// that, each call started when a slot freed up must be the best one available.
						if (!firstRound) expectNotOutranked(fresh, pool.stats());
						firstRound = false;
						if (live.size === 0) break;
						const list = [...live];
						const pick = list[(picks.shift() ?? 0) % list.length];
						if (pick) {
							live.delete(pick);
							pick.reply();
						}
					}
					const settled = await Promise.all(results);
					expect(settled.every((r) => r.ok)).toBe(true);
					expect(pool.stats().maxRunningObserved).toBeLessThanOrEqual(slots);
				},
			),
			{ numRuns: 150 },
		);
	});
});

describe("Phase 2 acceptance: 20 queued jobs against an HTTP engine", { timeout: 20_000 }, () => {
	it("never exceeds the configured concurrency and completes every job", async () => {
		const server = await startFakeOpenAIServer([], { fallback: { kind: "text", text: "done", delayMs: 40 } });
		try {
			const pool = createSidecarPool({
				client: createOpenAIClient({ ...TARGET, baseUrl: server.baseUrl }),
				target: { ...TARGET, baseUrl: server.baseUrl },
				config: { ...POOL, maxConcurrent: 6, reservedForMain: 2 },
				moduleLimits: () => ({ maxCallsPerTurn: 100, maxTokensPerCall: 64 }),
			});
			const priorities: SidecarPriority[] = ["critical", "interactive", "background"];
			const results = await Promise.all(
				Array.from({ length: 20 }, (_, i) => pool.run(call(`m${i % 3}`, priorities[i % 3], `job ${i}`))),
			);
			expect(results.every((r) => r.ok)).toBe(true);
			expect(server.requests).toHaveLength(20);
			expect(server.maxInFlight).toBe(4);
			expect(pool.stats().maxRunningObserved).toBe(4);
		} finally {
			await server.close();
		}
	});
});
