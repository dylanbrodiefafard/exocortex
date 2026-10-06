import { createHash } from "node:crypto";
import type { Static, TSchema } from "typebox";
import { clampTimeoutMs, type ExoConfig } from "../config.ts";
import { canonicalJson } from "../fingerprint.ts";
import type { JsonValue } from "../trace/store.ts";
import type { ChatRequest, ChatResponse, InferenceClient } from "./client.ts";
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
	readonly request: Omit<ChatRequest, "jsonSchema" | "priority">;
	/** When set, the reply must be JSON matching this schema (one repair attempt). */
	readonly schema?: S;
	readonly schemaName?: string;
	/**
	 * End-to-end deadline including queueing. Defaults to `pool.timeoutMs`. The one exception: while
	 * a `background` call is held for the main agent, the deadline does not run (see `maxHoldMs`).
	 */
	readonly timeoutMs?: number;
	/** Cancels the call (e.g. the user typed something). */
	readonly signal?: AbortSignal;
}

const OUTCOMES = [
	"ok",
	/** The deadline passed while the call was queued (and free to start) or running. */
	"timeout",
	"cancelled",
	"rejected_budget",
	"rejected_turn_cap",
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
	/** Starts a new user turn: resets per-module call counts. */
	beginTurn(): void;
	/** Cancels queued and running calls matching `filter` (all when omitted). */
	cancel(filter?: (call: { readonly module: string; readonly priority: SidecarPriority }) => boolean): void;
	stats(): PoolStats;
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
	readonly maxCallsPerTurn: number;
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

export const DEFAULT_MODULE_LIMITS: ModuleLimits = { maxCallsPerTurn: 4, maxTokensPerCall: SIDECAR_MAX_TOKENS };

/** How long one stretch of holding a `background` call for the main agent may last (`pool.maxHoldMs`). */
const DEFAULT_MAX_HOLD_MS = 10 * 60_000;

/** Per-module limits from config, with defaults for unset fields. */
export function moduleLimitsFrom(modules: ExoConfig["modules"]): (module: string) => ModuleLimits {
	return (module) => ({
		maxCallsPerTurn: modules[module]?.maxCallsPerTurn ?? DEFAULT_MODULE_LIMITS.maxCallsPerTurn,
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
	const queue: Job[] = [];
	const running = new Set<Job>();
	const turnCalls = new Map<string, number>();
	const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<SidecarOutcome, number>;
	const drains = new Set<(job: Job) => void>();
	let mainActive = false;
	let closed = false;
	let tokensUsed = 0;
	let maxRunningObserved = 0;

	function eligible(job: Job): boolean {
		return !(job.call.priority === "background" && config.backgroundWhenIdleOnly && mainActive && drains.size === 0);
	}

	function budgetSpent(): boolean {
		return config.sessionTokenBudget > 0 && tokensUsed >= config.sessionTokenBudget;
	}

	function pump(): void {
		while (running.size < slots) {
			const next = PRIORITY_ORDER.map((p) => queue.find((j) => j.call.priority === p && eligible(j))).find(
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
		outcome: "rejected_budget" | "rejected_turn_cap" | "closed" | "error",
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
		const request = { ...call.request, maxTokens: Math.min(call.request.maxTokens, limits.maxTokensPerCall) };
		if (closed) return Promise.resolve(rejectNow(call, request.maxTokens, "closed", "pool is closed"));
		if (budgetSpent()) return Promise.resolve(rejectNow(call, request.maxTokens, "rejected_budget", BUDGET_SPENT));
		const callsThisTurn = turnCalls.get(call.module) ?? 0;
		if (callsThisTurn >= limits.maxCallsPerTurn) {
			const error = `${call.module}: maxCallsPerTurn reached`;
			return Promise.resolve(rejectNow(call, request.maxTokens, "rejected_turn_cap", error));
		}
		turnCalls.set(call.module, callsThisTurn + 1);

		return new Promise<SidecarResult<S>>((resolve) => {
			const submittedAt = now();
			const controller = new AbortController();
			let startedAt: number | undefined;
			let settled = false;
			let attempts = 0;
			let usage: SidecarUsage = ZERO_USAGE;
			/** What is left of the deadline; it only runs down while `deadline` is set. */
			let remainingMs = clampTimeoutMs(call.timeoutMs ?? config.timeoutMs);
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
					deadlineSince = now();
					deadline = setTimeout(() => finish("timeout", "deadline exceeded"), remainingMs);
				}
			};

			const start = () => {
				startedAt = now();
				execute(client, target, call, request, controller.signal, (response) => {
					// Counted as each response arrives, so a call that fails later (a repair turn that
					// times out) still reports what it used, and the budget sees it at once.
					tokensUsed += (response.usage?.promptTokens ?? 0) + (response.usage?.completionTokens ?? 0);
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
						if (settled) return;
						const outcome = !(error instanceof StructuredOutputError)
							? "error"
							: error.reason === "truncated"
								? "truncated"
								: "invalid_output";
						settle({ ok: false, outcome, error: String(error), usage, ...timing() }, String(error));
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
			reschedule();
		},
		beginTurn() {
			turnCalls.clear();
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
	onResponse: (response: ChatResponse) => void,
): Promise<{ value: unknown; finishReason: string | null }> {
	const withPriority = { ...request, priority: ENGINE_PRIORITY[call.priority] };
	if (call.schema === undefined) {
		const response = await client.chat(withPriority, signal);
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
	);
	return { value: result.value, finishReason: result.responses.at(-1)?.finishReason ?? null };
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
