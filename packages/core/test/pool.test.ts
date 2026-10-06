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
	reply(text?: string, tokens?: number, finishReason?: string): void;
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
					reply: (text = "ok", tokens = 10, finishReason = "stop") =>
						resolve({
							text,
							finishReason,
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe("held background calls (D3)", () => {
	it("does not run a held call's deadline while the main agent is active", async () => {
		const { pool, pending, started } = makePool();
		pool.setMainActive(true);
		const bg = pool.run({ ...call("bg", "background"), timeoutMs: 40 });
		await sleep(120);
		expect(pool.stats().queued.background).toBe(1);
		pool.setMainActive(false);
		await flush();
		expect(started).toHaveLength(1);
		pending[0]?.reply();
		const result = await bg;
		expect(result).toMatchObject({ ok: true, outcome: "ok" });
		expect(result.queueMs).toBeGreaterThanOrEqual(100);
	});

	it("applies the deadline as soon as the call is free to start", async () => {
		const { pool, pending, records } = makePool();
		pool.setMainActive(true);
		const bg = pool.run({ ...call("bg", "background"), timeoutMs: 40 });
		await sleep(80);
		pool.setMainActive(false);
		await flush();
		// It runs, the engine never answers, and the 40 ms count from when it stopped being held.
		const released = performance.now();
		expect(await bg).toMatchObject({ ok: false, outcome: "timeout" });
		expect(performance.now() - released).toBeLessThan(500);
		expect(pending[0]?.signal?.aborted).toBe(true);
		expect(records.map((r) => r.outcome)).toEqual(["timeout"]);
	});

	it("stops the clock again when the main agent resumes before a slot was free", async () => {
		const { pool, pending } = makePool({ maxConcurrent: 3, reservedForMain: 2 });
		const busy = pool.run(call("busy", "interactive"));
		const bg = pool.run({ ...call("bg", "background"), timeoutMs: 80 });
		await sleep(20); // free to start, but the only slot is taken: the deadline runs
		pool.setMainActive(true);
		await sleep(150); // held: it does not
		expect(pool.stats().queued.background).toBe(1);
		pool.setMainActive(false);
		pending[0]?.reply();
		await flush();
		pending[1]?.reply();
		expect((await busy).ok && (await bg).ok).toBe(true);
	});

	it("still times out a background call that is queued but not held", async () => {
		const { pool } = makePool({ maxConcurrent: 3, reservedForMain: 2 });
		void pool.run(call("busy", "interactive"));
		expect(await pool.run({ ...call("bg", "background"), timeoutMs: 30 })).toMatchObject({
			outcome: "timeout",
			latencyMs: 0,
		});
		pool.close();
	});

	it("gives up on a call held longer than maxHoldMs, with its own outcome", async () => {
		const { pool, started, records } = makePool({ maxHoldMs: 40 });
		pool.setMainActive(true);
		const held = await pool.run({ ...call("bg", "background"), timeoutMs: 5_000 });
		expect(held).toMatchObject({ ok: false, outcome: "expired_held", latencyMs: 0 });
		expect(held.queueMs).toBeGreaterThanOrEqual(30);
		expect(started).toEqual([]);
		expect(records.map((r) => r.outcome)).toEqual(["expired_held"]);
		expect(pool.stats().outcomes.expired_held).toBe(1);
	});

	it("holds nothing when backgroundWhenIdleOnly is off", async () => {
		const { pool, started } = makePool({ backgroundWhenIdleOnly: false, maxHoldMs: 1 });
		pool.setMainActive(true);
		void pool.run(call("bg", "background"));
		await sleep(20);
		expect(started).toHaveLength(1);
		pool.close();
	});
});

describe("drain (D4)", () => {
	it("lets queued and running background calls finish, even while the main agent is active", async () => {
		const { pool, pending, started } = makePool();
		pool.setMainActive(true);
		const calls = ["a", "b", "c"].map((name) => pool.run(call(name, "background")));
		await flush();
		expect(started).toEqual([]);

		const drained = pool.drain(2_000);
		await flush();
		expect(started).toHaveLength(2); // both slots, though main is still active
		pending[0]?.reply();
		pending[1]?.reply();
		await flush();
		expect(started).toHaveLength(3);
		pending[2]?.reply();
		expect(await drained).toEqual({ settled: 3, remaining: 0 });
		expect((await Promise.all(calls)).every((r) => r.ok)).toBe(true);
	});

	it("waits no longer than asked, cancels nothing, and holds background work again afterwards", async () => {
		const { pool, started } = makePool({ maxConcurrent: 3, reservedForMain: 2 });
		const running = pool.run(call("slow", "background"));
		pool.setMainActive(true);
		const queued = pool.run(call("queued", "background"));
		const began = performance.now();
		expect(await pool.drain(40)).toEqual({ settled: 0, remaining: 2 });
		expect(performance.now() - began).toBeLessThan(500);
		expect(pool.stats()).toMatchObject({ running: 1, queued: { background: 1 } });
		expect(started).toHaveLength(1);

		pool.close();
		expect(await running).toMatchObject({ outcome: "closed" });
		expect(await queued).toMatchObject({ outcome: "closed" });
		expect(await pool.drain(1_000)).toEqual({ settled: 0, remaining: 0 });
	});

	it("resolves at once when no background call is pending, whatever else is running", async () => {
		const { pool, pending } = makePool();
		const fg = pool.run(call("fg", "interactive"));
		expect(await pool.drain(60_000)).toEqual({ settled: 0, remaining: 0 });
		pending[0]?.reply();
		expect((await fg).ok).toBe(true);
	});

	it("also waits for background calls submitted while draining", async () => {
		const { pool, pending } = makePool();
		const first = pool.run(call("distill", "background"));
		const drained = pool.drain(2_000);
		await flush();
		// A module chaining a second call from the first one's result.
		const second = first.then(() => pool.run(call("embed", "background")));
		pending[0]?.reply();
		await flush();
		await flush();
		pending[1]?.reply();
		expect(await drained).toEqual({ settled: 2, remaining: 0 });
		expect((await second).ok).toBe(true);
	});
});

describe("pool accounting (D9)", () => {
	it("keeps the usage of a structured call whose repair turn times out", async () => {
		const { pool, pending, records } = makePool();
		const result = pool.run({ ...call("json"), schema: Type.Object({ n: Type.Number() }), timeoutMs: 60 });
		await flush();
		pending[0]?.reply("not json", 30);
		expect(await result).toMatchObject({ ok: false, outcome: "timeout", usage: { promptTokens: 30 } });
		expect(pending).toHaveLength(2);
		expect(records[0]).toMatchObject({ attempts: 1, usage: { promptTokens: 30 } });
		expect(pool.stats().sessionTokensUsed).toBe(30);
	});

	it("checks the token budget again when a queued call's turn comes", async () => {
		const { pool, pending, started } = makePool({ sessionTokenBudget: 25, maxConcurrent: 3, reservedForMain: 2 });
		const a = pool.run(call("a"));
		const b = pool.run(call("b"));
		await flush();
		pending[0]?.reply("x", 30);
		expect((await a).ok).toBe(true);
		expect(await b).toMatchObject({ ok: false, outcome: "rejected_budget", latencyMs: 0 });
		expect(started).toHaveLength(1);
	});

	it("records the max_tokens that was sent, after the module's clamp", async () => {
		const { pool, pending, records } = makePool({}, { maxTokensPerCall: 16, maxCallsPerTurn: 1 });
		const first = pool.run(call("m"));
		await flush();
		expect(pending[0]?.request.maxTokens).toBe(16);
		pending[0]?.reply();
		await first;
		await pool.run(call("m")); // over the turn cap
		expect(records.map((r) => [r.outcome, r.maxTokens])).toEqual([
			["ok", 16],
			["rejected_turn_cap", 16],
		]);
	});

	it("says when a text reply was cut off at max_tokens", async () => {
		const { pool, pending, records } = makePool();
		const cut = pool.run(call("text"));
		const whole = pool.run(call("text"));
		await flush();
		pending[0]?.reply("The cause is", 10, "length");
		pending[1]?.reply("The cause is a typo.");
		expect(await cut).toMatchObject({ ok: true, value: "The cause is", finishReason: "length" });
		expect(await whole).toMatchObject({ ok: true, finishReason: "stop" });
		expect(records.map((r) => [r.outcome, r.error])).toEqual([
			["ok", expect.stringMatching(/cut off at max_tokens/)],
			["ok", null],
		]);
	});

	it("reports a structured reply cut off at max_tokens as truncated, without a repair turn", async () => {
		const { pool, pending, started, records } = makePool();
		const result = pool.run({ ...call("json"), schema: Type.Object({ n: Type.Number() }) });
		await flush();
		pending[0]?.reply('<think>I should count the {"n":', 4096, "length");
		expect(await result).toMatchObject({ ok: false, outcome: "truncated", usage: { promptTokens: 4096 } });
		await flush();
		expect(started).toHaveLength(1);
		expect(records[0]).toMatchObject({ outcome: "truncated", attempts: 1 });
		expect(pool.stats().outcomes.truncated).toBe(1);
	});

	it("resolves, never throws, when the limits callback or the recorder throws", async () => {
		const c = manualClient();
		let broken = true;
		const pool = createSidecarPool({
			client: c.client,
			target: TARGET,
			config: POOL,
			moduleLimits: () => {
				if (broken) throw new Error("limits exploded");
				return DEFAULT_MODULE_LIMITS;
			},
			onRecord: () => {
				throw new Error("recorder exploded");
			},
		});
		expect(await pool.run(call("m"))).toMatchObject({ ok: false, outcome: "error" });
		broken = false;
		const fine = pool.run({ ...call("m"), timeoutMs: Number.POSITIVE_INFINITY });
		await flush();
		c.pending[0]?.reply();
		expect((await fine).ok).toBe(true);
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
