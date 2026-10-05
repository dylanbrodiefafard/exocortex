import { createHash } from "node:crypto";
import type { Static, TSchema } from "typebox";
import type { ExoConfig } from "../config.ts";
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
	/** End-to-end deadline including queueing. Defaults to `pool.timeoutMs`. */
	readonly timeoutMs?: number;
	/** Cancels the call (e.g. the user typed something). */
	readonly signal?: AbortSignal;
}

export type SidecarOutcome =
	| "ok"
	| "timeout"
	| "cancelled"
	| "rejected_budget"
	| "rejected_turn_cap"
	| "invalid_output"
	| "error"
	| "closed";

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
	readonly maxTokens: number;
	readonly usage: SidecarUsage;
	readonly error: string | null;
}

export interface PoolStats {
	readonly running: number;
	readonly queued: Readonly<Record<SidecarPriority, number>>;
	readonly maxRunningObserved: number;
	readonly sessionTokensUsed: number;
	readonly outcomes: Readonly<Record<SidecarOutcome, number>>;
}

export interface SidecarPool {
	/** Schedules a call. Never rejects: failures resolve to `ok: false` so callers degrade to a no-op. */
	run<S extends TSchema | undefined = undefined>(call: SidecarCall<S>): Promise<SidecarResult<S>>;
	/** The main agent is generating; `background` calls wait while this is true (if configured). */
	setMainActive(active: boolean): void;
	/** Starts a new user turn: resets per-module call counts. */
	beginTurn(): void;
	/** Cancels queued and running calls matching `filter` (all when omitted). */
	cancel(filter?: (call: { readonly module: string; readonly priority: SidecarPriority }) => boolean): void;
	stats(): PoolStats;
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
	readonly finish: (outcome: Exclude<SidecarOutcome, "ok">, error: string) => void;
	readonly start: () => void;
}

const ZERO_USAGE: SidecarUsage = { promptTokens: 0, cachedTokens: null, completionTokens: 0 };

/**
 * The sidecar scheduler (brief §5.2). It owns every sidecar slot: at most
 * `maxConcurrent - reservedForMain` calls run at once, the highest-priority queued call starts
 * first (FIFO within a class), `background` work can wait for the main agent to go idle, and
 * every call has an end-to-end deadline after which it resolves as a timeout (aborting the
 * HTTP request so the engine stops generating).
 */
export function createSidecarPool(options: SidecarPoolOptions): SidecarPool {
	const { client, target, config } = options;
	const now = options.now ?? Date.now;
	const slots = Math.max(1, config.maxConcurrent - config.reservedForMain);
	const queue: Job[] = [];
	const running = new Set<Job>();
	const turnCalls = new Map<string, number>();
	const outcomes = Object.fromEntries(
		(
			[
				"ok",
				"timeout",
				"cancelled",
				"rejected_budget",
				"rejected_turn_cap",
				"invalid_output",
				"error",
				"closed",
			] as const
		).map((o) => [o, 0]),
	) as Record<SidecarOutcome, number>;
	let mainActive = false;
	let closed = false;
	let tokensUsed = 0;
	let maxRunningObserved = 0;

	function eligible(job: Job): boolean {
		return !(job.call.priority === "background" && config.backgroundWhenIdleOnly && mainActive);
	}

	function pump(): void {
		while (running.size < slots) {
			const next = PRIORITY_ORDER.map((p) => queue.find((j) => j.call.priority === p && eligible(j))).find(
				(j) => j !== undefined,
			);
			if (!next) return;
			queue.splice(queue.indexOf(next), 1);
			running.add(next);
			maxRunningObserved = Math.max(maxRunningObserved, running.size);
			next.start();
		}
	}

	function record(
		job: Pick<Job, "call" | "submittedAt">,
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
				maxTokens: job.call.request.maxTokens,
				...timing,
				...extra,
			});
		} catch {
			// Recording must never affect the call.
		}
	}

	function rejectNow<S extends TSchema | undefined>(
		call: SidecarCall<S>,
		outcome: "rejected_budget" | "rejected_turn_cap" | "closed",
		error: string,
	): SidecarResult<S> {
		record(
			{ call, submittedAt: now() },
			outcome,
			{ queueMs: 0, latencyMs: 0 },
			{ attempts: 0, usage: ZERO_USAGE, error },
		);
		return { ok: false, outcome, error, usage: ZERO_USAGE, queueMs: 0, latencyMs: 0 };
	}

	return {
		run<S extends TSchema | undefined = undefined>(call: SidecarCall<S>): Promise<SidecarResult<S>> {
			if (closed) return Promise.resolve(rejectNow(call, "closed", "pool is closed"));
			if (config.sessionTokenBudget > 0 && tokensUsed >= config.sessionTokenBudget) {
				return Promise.resolve(rejectNow(call, "rejected_budget", "session sidecar token budget exhausted"));
			}
			const limits = options.moduleLimits(call.module);
			const callsThisTurn = turnCalls.get(call.module) ?? 0;
			if (callsThisTurn >= limits.maxCallsPerTurn) {
				return Promise.resolve(rejectNow(call, "rejected_turn_cap", `${call.module}: maxCallsPerTurn reached`));
			}
			turnCalls.set(call.module, callsThisTurn + 1);
			const request = { ...call.request, maxTokens: Math.min(call.request.maxTokens, limits.maxTokensPerCall) };

			return new Promise<SidecarResult<S>>((resolve) => {
				const submittedAt = now();
				const controller = new AbortController();
				let startedAt: number | undefined;
				let settled = false;
				let attempts = 0;
				let usage: SidecarUsage = ZERO_USAGE;

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
					call.signal?.removeEventListener("abort", onAbort);
					const index = queue.indexOf(job);
					if (index !== -1) queue.splice(index, 1);
					if (running.delete(job)) queueMicrotask(pump);
					tokensUsed += usage.promptTokens + usage.completionTokens;
					record(
						job,
						result.outcome,
						{ queueMs: result.queueMs, latencyMs: result.latencyMs },
						{ attempts, usage, error },
					);
					resolve(result);
				};
				const finish = (outcome: Exclude<SidecarOutcome, "ok">, error: string) => {
					controller.abort();
					settle({ ok: false, outcome, error, usage, ...timing() }, error);
				};
				const onAbort = () => finish("cancelled", "cancelled by caller");
				const deadline = setTimeout(() => finish("timeout", "deadline exceeded"), call.timeoutMs ?? config.timeoutMs);

				const start = () => {
					startedAt = now();
					execute(client, target, call, request, controller.signal, (response) => {
						attempts += 1;
						usage = addUsage(usage, response);
					}).then(
						// `execute` returns the text, or the schema-validated value when `call.schema` is set.
						(value) => settle({ ok: true, outcome: "ok", value, usage, ...timing() } as SidecarResult<S>, null),
						(error: unknown) => {
							if (settled) return;
							const outcome = error instanceof StructuredOutputError ? "invalid_output" : "error";
							settle({ ok: false, outcome, error: String(error), usage, ...timing() }, String(error));
						},
					);
				};

				const job: Job = { call, submittedAt, finish, start };
				if (call.signal?.aborted) {
					finish("cancelled", "cancelled by caller");
					return;
				}
				call.signal?.addEventListener("abort", onAbort, { once: true });
				queue.push(job);
				pump();
			});
		},
		setMainActive(active) {
			mainActive = active;
			pump();
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
): Promise<unknown> {
	const withPriority = { ...request, priority: ENGINE_PRIORITY[call.priority] };
	if (call.schema === undefined) {
		const response = await client.chat(withPriority, signal);
		onResponse(response);
		return response.text;
	}
	try {
		const result = await completeStructured(
			client,
			target,
			withPriority,
			call.schema,
			call.schemaName ?? call.module,
			signal,
		);
		for (const response of result.responses) onResponse(response);
		return result.value;
	} catch (error) {
		if (error instanceof StructuredOutputError) for (const response of error.responses) onResponse(response);
		throw error;
	}
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
