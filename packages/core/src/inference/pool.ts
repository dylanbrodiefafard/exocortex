import { createHash } from "node:crypto";
import type { Static, TSchema } from "typebox";
import { clampTimeoutMs, type ExoConfig } from "../config.ts";
import { canonicalJson } from "../fingerprint.ts";
import type { JsonValue } from "../trace/store.ts";
import {
	type ChatOptions,
	type ChatRequest,
	type ChatResponse,
	type ForkPrefix,
	type InferenceClient,
	InferenceError,
	type Liveness,
	thinks,
} from "./client.ts";
import type { EngineTarget } from "./engine.ts";
import { completeStructured, StructuredOutputError } from "./structured.ts";

/** Brief §5.2: blocking verdicts > hot-path helpers > idle-time work. */
export type SidecarPriority = "critical" | "interactive" | "background";

const PRIORITY_ORDER: readonly SidecarPriority[] = ["critical", "interactive", "background"];
/** Engine-level priority (vLLM semantics, lower first); the main agent sends none, i.e. 0. */
const ENGINE_PRIORITY: Readonly<Record<SidecarPriority, number>> = { critical: 0, interactive: 1, background: 2 };

export interface SidecarCall<S extends TSchema | undefined = undefined> {
	/** Module id: used for per-module limits and recorded with the call. */
	readonly module: string;
	readonly priority: SidecarPriority;
	/**
	 * With `fork`, the call continues from the main agent's context (D-093). It is refused at once,
	 * as `error`, when the engine cannot do that for free or an earlier fork missed the cache: have
	 * a prompt that stands alone ready. One fork runs at a time.
	 */
	readonly request: Omit<ChatRequest, "jsonSchema" | "priority" | "cacheWrite">;
	/** When set, the reply must be JSON matching this schema (one repair attempt). */
	readonly schema?: S;
	readonly schemaName?: string;
	/**
	 * End-to-end deadline including queueing, for a call that holds the agent or the user. Defaults
	 * to `pool.timeoutMs`, and without that there is none: the call ends when it is done, cancelled,
	 * or the engine stops answering (`pool.firstTokenMs`, `pool.stallMs`; D-098). While a
	 * `background` call is held for the main agent, the deadline does not run (see `maxHoldMs`).
	 */
	readonly timeoutMs?: number;
	/** Called as the reply arrives, with its characters so far: for a progress line. */
	readonly onProgress?: (chars: number) => void;
	/**
	 * A diagnostic call (`/exo doctor`, D-099): it leaves the pool as it was. A fork that misses does
	 * not turn forks off, and its tokens do not count toward the session's budget.
	 */
	readonly probe?: boolean;
	/** Cancels the call (e.g. the user typed something). */
	readonly signal?: AbortSignal;
}

const OUTCOMES = [
	"ok",
	/** The deadline passed while the call was queued (and free to start) or running. */
	"timeout",
	"cancelled",
	"rejected_budget",
	"invalid_output",
	/** A structured reply was cut off at `max_tokens` before it held a valid answer; no repair turn was made. */
	"truncated",
	/** A `background` call was held for the main agent for `pool.maxHoldMs` without ever starting. */
	"expired_held",
	"error",
	"closed",
] as const;

export type SidecarOutcome = (typeof OUTCOMES)[number];

export interface SidecarUsage {
	readonly promptTokens: number;
	readonly cachedTokens: number | null;
	readonly completionTokens: number;
}

export type SidecarResult<S extends TSchema | undefined> =
	| {
			readonly ok: true;
			readonly outcome: "ok";
			readonly value: S extends TSchema ? Static<S> : string;
			/**
			 * Why the engine stopped, from the last response. `"length"` means the reply hit `max_tokens`:
			 * a text reply is then cut short, so check this before trusting it as complete.
			 */
			readonly finishReason: string | null;
			readonly usage: SidecarUsage;
			readonly queueMs: number;
			readonly latencyMs: number;
	  }
	| {
			readonly ok: false;
			readonly outcome: Exclude<SidecarOutcome, "ok">;
			readonly error: string;
			readonly usage: SidecarUsage;
			readonly queueMs: number;
			readonly latencyMs: number;
	  };

/** One row per call, for the trace's `sidecar_calls` table (brief §5.2). */
export interface SidecarCallRecord {
	readonly module: string;
	readonly priority: SidecarPriority;
	readonly outcome: SidecarOutcome;
	/** Hash of the canonical request messages: groups identical prompts for A/B analysis. */
	readonly promptHash: string;
	readonly startedAt: number;
	readonly queueMs: number;
	readonly latencyMs: number;
	readonly attempts: number;
	/** The limit sent to the engine: the call's `maxTokens` after the module's clamp. */
	readonly maxTokens: number;
	readonly usage: SidecarUsage;
	/** Why it failed; on an `ok` call, a note when the reply was cut off at `max_tokens`. */
	readonly error: string | null;
}

export interface PoolStats {
	readonly running: number;
	readonly queued: Readonly<Record<SidecarPriority, number>>;
	readonly maxRunningObserved: number;
	readonly sessionTokensUsed: number;
	readonly outcomes: Readonly<Record<SidecarOutcome, number>>;
}

export interface DrainResult {
	/** `background` calls that reached an outcome while draining. */
	readonly settled: number;
	/** `background` calls still queued or running when the time ran out. */
	readonly remaining: number;
}

export interface SidecarPool {
	/** Schedules a call. Never rejects and never throws: failures resolve to `ok: false` so callers degrade to a no-op. */
	run<S extends TSchema | undefined = undefined>(call: SidecarCall<S>): Promise<SidecarResult<S>>;
	/** The main agent is generating; `background` calls wait while this is true (if configured). */
	setMainActive(active: boolean): void;
	/** Cancels queued and running calls matching `filter` (all when omitted). */
	cancel(filter?: (call: { readonly module: string; readonly priority: SidecarPriority }) => boolean): void;
	stats(): PoolStats;
	/**
	 * How long this session's recent calls of one kind took, queueing included (D-098), counting a
	 * call cut off by its deadline as taking that long:
	 * the 90th percentile of the last {@link LATENCY_SAMPLES}, and how many there were. Undefined
	 * before the first.
	 */
	typicalMs(module: string, schemaName?: string): { readonly p90: number; readonly samples: number } | undefined;
	/**
	 * Gives `background` calls up to `timeoutMs` to finish, for use before `close()` at shutdown.
	 * While draining they are not held for the main agent. Resolves as soon as none is queued or
	 * running, or when the time is up; it cancels nothing and never rejects. Calls submitted while
	 * draining are waited for too.
	 */
	drain(timeoutMs: number): Promise<DrainResult>;
	/** Cancels everything; later calls resolve as `closed`. */
	close(): void;
}

export interface ModuleLimits {
	readonly maxTokensPerCall: number;
}

export interface SidecarPoolOptions {
	readonly client: InferenceClient;
	readonly target: EngineTarget;
	readonly config: ExoConfig["pool"];
	readonly moduleLimits: (module: string) => ModuleLimits;
	readonly onRecord?: (record: SidecarCallRecord) => void;
	readonly now?: () => number;
}

/**
 * The output limit a sidecar call asks for (D-068). It only stops a runaway reply: output is
 * fast on the target engine, so no call is given a low limit to save time, and a low one cuts
 * replies off (with thinking on, before the answer starts).
 */
export const SIDECAR_MAX_TOKENS = 4096;

/**
 * Room for reasoning, on top of a call's limit, when its reply begins with it (D-101): the limit is
 * for the answer. Qwen3.8 reasoned for up to 11,500 tokens over a small review, and a review pass
 * held to 4,096 in all was cut off before it answered.
 */
export const SIDECAR_THINKING_TOKENS = 32_768;

/**
 * There is no limit on how many calls a module makes (D-092): a module's work is as many calls as
 * its design needs, and a count cut off the last of them. What bounds sidecar use is the pool's
 * slots, each call's deadline and `pool.sessionTokenBudget`.
 */
export const DEFAULT_MODULE_LIMITS: ModuleLimits = { maxTokensPerCall: SIDECAR_MAX_TOKENS };

/** How long one stretch of holding a `background` call for the main agent may last (`pool.maxHoldMs`). */
const DEFAULT_MAX_HOLD_MS = 10 * 60_000;

/** Per-module limits from config, with defaults for unset fields. */
export function moduleLimitsFrom(modules: ExoConfig["modules"]): (module: string) => ModuleLimits {
	return (module) => ({
		maxTokensPerCall: modules[module]?.maxTokensPerCall ?? DEFAULT_MODULE_LIMITS.maxTokensPerCall,
	});
}

interface Job {
	readonly call: SidecarCall<TSchema | undefined>;
	readonly submittedAt: number;
	/** `max_tokens` as sent: after the module's clamp. */
	readonly maxTokens: number;
	readonly finish: (outcome: Exclude<SidecarOutcome, "ok">, error: string) => void;
	readonly start: () => void;
	/** Tells a queued job whether it may start now; its deadline runs only while it may. */
	readonly setHeld: (held: boolean) => void;
}

/** A fork that found less than this share of its prompt in the cache paid for the main agent's context again. */
const FORK_MIN_CACHED_SHARE = 0.5;

/** Successful calls of each kind whose time is kept for {@link SidecarPool.typicalMs}. */
const LATENCY_SAMPLES = 50;
/** Samples a hold needs before it is set from them, rather than from the module's setting. */
const HOLD_MIN_SAMPLES = 5;
/** A call slower than half again its kind's recent 90th percentile is unusual: what it holds is let go. */
const HOLD_FACTOR = 1.5;
/** No hold set from samples is shorter than this: below it, scheduling noise would decide. */
const HOLD_FLOOR_MS = 500;

/**
 * How long a call on the hot path holds what it is part of (D-098): half again the recent 90th
 * percentile of its kind of call, between {@link HOLD_FLOOR_MS} and `capMs` (the module's
 * setting), or `capMs` until there are {@link HOLD_MIN_SAMPLES} samples. A typical call is never
 * cut short; one far slower than usual stops costing the agent time.
 */
export function holdFor(pool: SidecarPool | undefined, module: string, schemaName: string, capMs: number): number {
	const typical = pool?.typicalMs(module, schemaName);
	if (!typical || typical.samples < HOLD_MIN_SAMPLES) return capMs;
	return Math.min(capMs, Math.max(HOLD_FLOOR_MS, Math.round(typical.p90 * HOLD_FACTOR)));
}

/** Defaults of `pool.firstTokenMs` and `pool.stallMs` (D-098): a dead engine, not a slow one. */
const DEFAULT_FIRST_TOKEN_MS = 120_000;
const DEFAULT_STALL_MS = 60_000;

const ZERO_USAGE: SidecarUsage = { promptTokens: 0, cachedTokens: null, completionTokens: 0 };
const BUDGET_SPENT = "session sidecar token budget exhausted";

/**
 * The sidecar scheduler (brief §5.2). It owns every sidecar slot: at most
 * `maxConcurrent - reservedForMain` calls run at once, the highest-priority queued call starts
 * first (FIFO within a class), `background` work can wait for the main agent to go idle, and
 * every call has an end-to-end deadline after which it resolves as a timeout (aborting the
 * HTTP request so the engine stops generating).
 *
 * The deadline includes queueing, except while a `background` call is held for the main agent
 * (D-080): being held is the pool's doing, not the engine being slow, so the clock stops and a
 * separate, long `maxHoldMs` bounds each hold (`expired_held`).
 */
export function createSidecarPool(options: SidecarPoolOptions): SidecarPool {
	const { client, target, config } = options;
	const now = options.now ?? Date.now;
	const slots = Math.max(1, config.maxConcurrent - config.reservedForMain);
	const maxHoldMs = clampTimeoutMs(config.maxHoldMs ?? DEFAULT_MAX_HOLD_MS);
	/** Recent successful calls' times, by kind (`typicalMs`). */
	const latencies = new Map<string, number[]>();
	const liveness: Liveness = {
		firstTokenMs: config.firstTokenMs ?? DEFAULT_FIRST_TOKEN_MS,
		stallMs: config.stallMs ?? DEFAULT_STALL_MS,
	};
	const queue: Job[] = [];
	const running = new Set<Job>();
	const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<SidecarOutcome, number>;
	const drains = new Set<(job: Job) => void>();
	let mainActive = false;
	let closed = false;
	let tokensUsed = 0;
	let maxRunningObserved = 0;
	/** Why forks are off for the rest of this pool's life: one missed the cache (D-093). */
	let forkOff: string | undefined;
	/** Forks that missed the cache this session; past {@link MAX_FORK_MISSES} they are refused for good. */
	let forkMisses = 0;
	/** The main agent ran since forks were paused: its context is in the cache again. */
	let mainRanSinceMiss = false;

	/** A fork that missed the cache pauses forks, and enough misses stop them (D-100). */
	function noteForkReply(response: ChatResponse, ownChars: number): void {
		noteForkTrouble(forkMiss(response, ownChars));
	}

	/** A fork that missed, or that the engine refused: forks pause, and enough of these stop them (D-100). */
	function noteForkTrouble(miss: string | undefined): void {
		if (!miss || forkOff !== undefined) return;
		forkMisses += 1;
		mainRanSinceMiss = false;
		forkOff =
			forkMisses >= MAX_FORK_MISSES
				? `fork refused: ${forkMisses} forks missed the cache this session`
				: `${miss}, until the main agent's next run puts its context back`;
	}

	/** Why a fork cannot be had from this engine now; undefined when it can. */
	function forkRefusal(fork: ForkPrefix): string | undefined {
		if (!target.features.cacheReadOnly || !target.features.cachedTokens) {
			return "fork refused: the engine profile lacks cacheReadOnly or cachedTokens";
		}
		if (fork.body["model"] !== target.model) return "fork refused: the main agent runs on another model";
		return forkOff;
	}

	/** One fork at a time: a cached prefix has one reader (D-023). */
	function startable(job: Job): boolean {
		if (!eligible(job)) return false;
		return !job.call.request.fork || ![...running].some((other) => other.call.request.fork);
	}

	function eligible(job: Job): boolean {
		return !(job.call.priority === "background" && config.backgroundWhenIdleOnly && mainActive && drains.size === 0);
	}

	function budgetSpent(): boolean {
		return config.sessionTokenBudget > 0 && tokensUsed >= config.sessionTokenBudget;
	}

	function pump(): void {
		while (running.size < slots) {
			const next = PRIORITY_ORDER.map((p) => queue.find((j) => j.call.priority === p && startable(j))).find(
				(j) => j !== undefined,
			);
			if (!next) return;
			// The budget may have been spent by calls that ran while this one was queued.
			if (budgetSpent()) {
				next.finish("rejected_budget", BUDGET_SPENT);
				continue;
			}
			queue.splice(queue.indexOf(next), 1);
			running.add(next);
			maxRunningObserved = Math.max(maxRunningObserved, running.size);
			next.start();
		}
	}

	/** Stops or restarts queued jobs' deadlines after a change in who is held, then starts what can start. */
	function reschedule(): void {
		for (const job of [...queue]) job.setHeld(!eligible(job));
		pump();
	}

	function record(
		job: Pick<Job, "call" | "submittedAt" | "maxTokens">,
		outcome: SidecarOutcome,
		timing: { queueMs: number; latencyMs: number },
		extra: {
			attempts: number;
			usage: SidecarUsage;
			error: string | null;
		},
	): void {
		outcomes[outcome] += 1;
		// A call cut off by its deadline took at least that long, and counts so: were only successes
		// kept, a hold set from them could never grow past the calls it cuts off.
		if (outcome === "ok" || outcome === "timeout") {
			const key = latencyKey(job.call.module, job.call.schemaName);
			const kept = [...(latencies.get(key) ?? []), timing.queueMs + timing.latencyMs].slice(-LATENCY_SAMPLES);
			latencies.set(key, kept);
		}
		try {
			options.onRecord?.({
				module: job.call.module,
				priority: job.call.priority,
				outcome,
				promptHash: hashMessages(job.call.request.messages),
				startedAt: job.submittedAt,
				maxTokens: job.maxTokens,
				...timing,
				...extra,
			});
		} catch {
			// Recording must never affect the call.
		}
	}

	function rejectNow<S extends TSchema | undefined>(
		call: SidecarCall<S>,
		maxTokens: number,
		outcome: "rejected_budget" | "closed" | "error",
		error: string,
	): SidecarResult<S> {
		record(
			{ call, submittedAt: now(), maxTokens },
			outcome,
			{ queueMs: 0, latencyMs: 0 },
			{ attempts: 0, usage: ZERO_USAGE, error },
		);
		return { ok: false, outcome, error, usage: ZERO_USAGE, queueMs: 0, latencyMs: 0 };
	}

	function submit<S extends TSchema | undefined>(call: SidecarCall<S>): Promise<SidecarResult<S>> {
		const limits = options.moduleLimits(call.module);
		const room = thinks(options.target, call.request) ? SIDECAR_THINKING_TOKENS : 0;
		const request = { ...call.request, maxTokens: Math.min(call.request.maxTokens, limits.maxTokensPerCall) + room };
		if (closed) return Promise.resolve(rejectNow(call, request.maxTokens, "closed", "pool is closed"));
		if (budgetSpent()) return Promise.resolve(rejectNow(call, request.maxTokens, "rejected_budget", BUDGET_SPENT));
		const refusal = request.fork && forkRefusal(request.fork);
		if (refusal) return Promise.resolve(rejectNow(call, request.maxTokens, "error", refusal));

		return new Promise<SidecarResult<S>>((resolve) => {
			const submittedAt = now();
			const controller = new AbortController();
			let startedAt: number | undefined;
			let settled = false;
			let attempts = 0;
			let usage: SidecarUsage = ZERO_USAGE;
			/** What is left of the deadline (none: infinite); it only runs down while `deadline` is set. */
			const total = call.timeoutMs ?? config.timeoutMs;
			let remainingMs = total === undefined ? Number.POSITIVE_INFINITY : clampTimeoutMs(total);
			let deadline: NodeJS.Timeout | undefined;
			let deadlineSince = submittedAt;
			let holdLimit: NodeJS.Timeout | undefined;

			const timing = () => {
				const end = now();
				return startedAt === undefined
					? { queueMs: end - submittedAt, latencyMs: 0 }
					: { queueMs: startedAt - submittedAt, latencyMs: end - startedAt };
			};
			const settle = (result: SidecarResult<S>, error: string | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				clearTimeout(holdLimit);
				call.signal?.removeEventListener("abort", onAbort);
				const index = queue.indexOf(job);
				if (index !== -1) queue.splice(index, 1);
				if (running.delete(job)) queueMicrotask(pump);
				record(
					job,
					result.outcome,
					{ queueMs: result.queueMs, latencyMs: result.latencyMs },
					{ attempts, usage, error },
				);
				resolve(result);
				for (const notify of [...drains]) notify(job);
			};
			const finish = (outcome: Exclude<SidecarOutcome, "ok">, error: string) => {
				controller.abort();
				settle({ ok: false, outcome, error, usage, ...timing() }, error);
			};
			const onAbort = () => finish("cancelled", "cancelled by caller");
			const setHeld = (held: boolean) => {
				if (settled || startedAt !== undefined) return;
				if (held && holdLimit === undefined) {
					if (deadline !== undefined) remainingMs = Math.max(0, remainingMs - (now() - deadlineSince));
					clearTimeout(deadline);
					deadline = undefined;
					holdLimit = setTimeout(
						() => finish("expired_held", `held for the main agent for ${maxHoldMs} ms without starting`),
						maxHoldMs,
					);
				} else if (!held && deadline === undefined) {
					clearTimeout(holdLimit);
					holdLimit = undefined;
					runDeadline();
				}
			};
			/** Starts what is left of the deadline; a call without one only ends by liveness (D-098). */
			const runDeadline = () => {
				deadlineSince = now();
				if (!Number.isFinite(remainingMs)) return;
				deadline = setTimeout(() => finish("timeout", "deadline exceeded"), remainingMs);
			};

			const start = () => {
				// A fork queued before forks were paused would pay for the agent's context again.
				const paused = request.fork ? forkOff : undefined;
				if (paused !== undefined) {
					finish("error", paused);
					return;
				}
				startedAt = now();
				const chat = { liveness, ...(call.onProgress ? { onProgress: call.onProgress } : {}) };
				execute(client, target, call, request, controller.signal, chat, (response) => {
					// Counted as each response arrives, so a call that fails later (a repair turn that
					// times out) still reports what it used, and the budget sees it at once.
					if (!call.probe) {
						tokensUsed += computedTokens(response);
						if (request.fork) noteForkReply(response, charsOf(request.messages));
					}
					if (settled) return;
					attempts += 1;
					usage = addUsage(usage, response);
				}).then(
					// `execute` returns the text, or the schema-validated value when `call.schema` is set.
					({ value, finishReason }) =>
						settle(
							{ ok: true, outcome: "ok", value, finishReason, usage, ...timing() } as SidecarResult<S>,
							finishReason === "length" ? "reply cut off at max_tokens (finish_reason=length)" : null,
						),
					(error: unknown) => {
						// A fork the engine refuses (a 4xx: a field or a shape it does not take) will be refused again.
						if (request.fork && !call.probe && refused(error)) {
							noteForkTrouble(`fork refused: the engine refused one (${String(error).slice(0, 120)})`);
						}
						if (settled) return;
						settle(
							{ ok: false, outcome: failureOutcome(error), error: String(error), usage, ...timing() },
							String(error),
						);
					},
				);
			};

			const job: Job = { call, submittedAt, maxTokens: request.maxTokens, finish, start, setHeld };
			if (call.signal?.aborted) {
				finish("cancelled", "cancelled by caller");
				return;
			}
			call.signal?.addEventListener("abort", onAbort, { once: true });
			queue.push(job);
			setHeld(!eligible(job));
			pump();
		});
	}

	function backgroundJobs(): number {
		return [...queue, ...running].filter((job) => job.call.priority === "background").length;
	}

	return {
		run<S extends TSchema | undefined = undefined>(call: SidecarCall<S>): Promise<SidecarResult<S>> {
			try {
				return submit(call);
			} catch (error) {
				return Promise.resolve(rejectNow(call, call.request?.maxTokens ?? 0, "error", String(error)));
			}
		},
		setMainActive(active) {
			mainActive = active;
			// A miss pauses forks; the agent's next run caches its context again (D-100).
			if (active && forkOff !== undefined) mainRanSinceMiss = true;
			if (!active && mainRanSinceMiss && forkMisses < MAX_FORK_MISSES) {
				forkOff = undefined;
				mainRanSinceMiss = false;
			}
			reschedule();
		},
		cancel(filter) {
			for (const job of [...queue, ...running]) {
				if (!filter || filter({ module: job.call.module, priority: job.call.priority })) {
					job.finish("cancelled", "cancelled by harness");
				}
			}
		},
		stats() {
			const queued = { critical: 0, interactive: 0, background: 0 };
			for (const job of queue) queued[job.call.priority] += 1;
			return {
				running: running.size,
				queued,
				maxRunningObserved,
				sessionTokensUsed: tokensUsed,
				outcomes: { ...outcomes },
			};
		},
		typicalMs(module, schemaName) {
			const kept = latencies.get(latencyKey(module, schemaName));
			if (!kept || kept.length === 0) return undefined;
			const sorted = [...kept].sort((a, b) => a - b);
			const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] ?? 0;
			return { p90, samples: sorted.length };
		},
		drain(timeoutMs) {
			if (backgroundJobs() === 0) return Promise.resolve({ settled: 0, remaining: 0 });
			return new Promise<DrainResult>((resolve) => {
				let settled = 0;
				const done = () => {
					clearTimeout(timer);
					drains.delete(onSettled);
					resolve({ settled, remaining: backgroundJobs() });
					// Whatever is left goes back to waiting for the main agent.
					reschedule();
				};
				const onSettled = (job: Job) => {
					if (job.call.priority === "background") settled += 1;
					if (backgroundJobs() > 0) return;
					// One turn of the event loop first: the caller of the call that just settled may
					// submit a follow-up from its result, and that one is waited for too.
					setTimeout(() => {
						if (drains.has(onSettled) && backgroundJobs() === 0) done();
					}, 0);
				};
				const timer = setTimeout(done, clampTimeoutMs(timeoutMs));
				drains.add(onSettled);
				reschedule();
			});
		},
		close() {
			closed = true;
			for (const job of [...queue, ...running]) job.finish("closed", "pool closed");
		},
	};
}

async function execute(
	client: InferenceClient,
	target: EngineTarget,
	call: SidecarCall<TSchema | undefined>,
	request: SidecarCall["request"],
	signal: AbortSignal,
	options: ChatOptions,
	onResponse: (response: ChatResponse) => void,
): Promise<{ value: unknown; finishReason: string | null }> {
	const withPriority = { ...request, priority: ENGINE_PRIORITY[call.priority], cacheWrite: false as const };
	if (call.schema === undefined) {
		const response = await client.chat(withPriority, signal, options);
		onResponse(response);
		return { value: response.text, finishReason: response.finishReason };
	}
	const result = await completeStructured(
		client,
		target,
		withPriority,
		call.schema,
		call.schemaName ?? call.module,
		signal,
		onResponse,
		options,
	);
	return { value: result.value, finishReason: result.responses.at(-1)?.finishReason ?? null };
}

/** A kind of call: its module and the reply it asks for. */
function latencyKey(module: string, schemaName: string | undefined): string {
	return `${module}\0${schemaName ?? ""}`;
}

/**
 * Forks that may miss the cache in one session. A miss pauses forks until the main agent's next
 * run has cached its context again: the entry may have been evicted once. Misses again and again
 * mean forks do not share the agent's prefix on this engine (D-100).
 */
const MAX_FORK_MISSES = 3;

/**
 * The tokens a call cost the engine: its prompt less what the cache served, and its output. A
 * fork of a 100k-token context that the cache served is a few hundred (D-100).
 */
function computedTokens(response: ChatResponse): number {
	const usage = response.usage;
	if (!usage) return 0;
	return usage.promptTokens - Math.min(usage.cachedTokens ?? 0, usage.promptTokens) + usage.completionTokens;
}

/** The outcome of a call that failed: an engine that stopped answering is a timeout (D-098). */
function failureOutcome(error: unknown): Exclude<SidecarOutcome, "ok"> {
	if (error instanceof InferenceError && error.kind === "stalled") return "timeout";
	if (!(error instanceof StructuredOutputError)) return "error";
	return error.reason === "truncated" ? "truncated" : "invalid_output";
}

/**
 * Why a fork's response shows it did not get the main agent's context from the cache; undefined
 * when it did. The share is of the context, not of the whole prompt: the fork's own messages (a
 * triage hint's tool output can be thousands of tokens) were never in the cache (D-100).
 */
function forkMiss(response: ChatResponse, ownChars: number): string | undefined {
	const usage = response.usage;
	const own = Math.round(ownChars / CHARS_PER_TOKEN);
	const context = usage ? Math.max(1, usage.promptTokens - own) : 1;
	if (usage && usage.cachedTokens !== null && usage.cachedTokens >= context * FORK_MIN_CACHED_SHARE) return undefined;
	return `fork refused: an earlier one missed the cache (${usage?.cachedTokens ?? "?"} of ${usage?.promptTokens ?? "?"} prompt tokens cached)`;
}

/** Characters per token, roughly: a fork's own messages in tokens. */
const CHARS_PER_TOKEN = 4;

function charsOf(messages: readonly ChatRequest["messages"][number][]): number {
	return JSON.stringify(messages).length;
}

/** An error the engine answered with a refusal of the request itself (4xx), not a failure of its own. */
function refused(error: unknown): boolean {
	return (
		error instanceof InferenceError && error.kind === "http" && (error.status ?? 0) >= 400 && (error.status ?? 0) < 500
	);
}

function addUsage(total: SidecarUsage, response: ChatResponse): SidecarUsage {
	const usage = response.usage;
	if (!usage) return total;
	return {
		promptTokens: total.promptTokens + usage.promptTokens,
		completionTokens: total.completionTokens + usage.completionTokens,
		cachedTokens:
			usage.cachedTokens === null && total.cachedTokens === null
				? null
				: (total.cachedTokens ?? 0) + (usage.cachedTokens ?? 0),
	};
}

function hashMessages(messages: readonly JsonValue[]): string {
	return createHash("sha256").update(canonicalJson(messages)).digest("hex").slice(0, 16);
}
