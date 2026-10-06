import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createEmbedder,
	createOpenAIClient,
	createSidecarPool,
	type EngineFallback,
	moduleLimitsFrom,
	resolveEmbeddings,
	resolveEngine,
	type SidecarPool,
} from "@exocortex/core";
import type { Runtime } from "./runtime.ts";

export interface SidecarOptions {
	readonly runtime: Runtime;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly onError: (where: string, error: unknown) => void;
	/**
	 * Runs at `session_shutdown` after background calls have had their time and before the pool
	 * closes: the place to dispose modules, which may still be writing what those calls returned.
	 */
	readonly beforeClose?: () => Promise<void>;
}

const API_KEY_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * How long a session's end waits for `background` sidecar calls (memory writing a card's lesson)
 * before the pool closes and cancels them (D-086). Pi awaits `session_shutdown` handlers with no
 * limit of its own, and on quit it has already put the terminal back (PI_API_NOTES §16), so this
 * is time the user spends looking at a terminal that has not returned. Two seconds is about one
 * short call on a local engine and still reads as "closing"; the wait ends the moment nothing is
 * left, and most sessions end with nothing running.
 */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 2_000;
/** A mistyped setting cannot hold a quit for longer than this. */
export const MAX_SHUTDOWN_DRAIN_MS = 300_000;
/** Overrides {@link DEFAULT_SHUTDOWN_DRAIN_MS}, in ms; `0` turns the wait off. The eval asks for longer. */
const SHUTDOWN_DRAIN_ENV = "EXO_SHUTDOWN_DRAIN_MS";

export function shutdownDrainMs(env: Readonly<Record<string, string | undefined>>): number {
	const value = (env[SHUTDOWN_DRAIN_ENV] ?? "").trim();
	return /^\d+$/.test(value) ? Math.min(Number(value), MAX_SHUTDOWN_DRAIN_MS) : DEFAULT_SHUTDOWN_DRAIN_MS;
}

/**
 * Owns the sidecar pool's lifecycle for each pi session (brief §5.2):
 * - built at `session_start` (and on `model_select` when the engine follows the main model): the
 *   new pool replaces the old one in one step, so modules never find the pool missing in between;
 * - marks the main agent active between `agent_start` and `agent_settled`, so background work waits;
 * - on a new prompt (not a message steered into the running turn), starts a new turn and cancels
 *   stale hot-path calls;
 * - at `session_shutdown`: background calls get a bounded time to finish, `beforeClose` runs, and
 *   the pool closes, cancelling what is left.
 *
 * Register this before the trace recorder so in-flight calls are still recorded at shutdown.
 */
export function registerSidecars(pi: ExtensionAPI, options: SidecarOptions): void {
	const { runtime, onError } = options;
	/** Counts rebuilds and shutdowns: a rebuild that finds it changed while it waited was overtaken. */
	let generation = 0;
	/** Whether the main agent is running, so a pool built mid-run starts out knowing it. */
	let mainActive = false;

	async function rebuild(ctx: ExtensionContext): Promise<void> {
		generation += 1;
		const mine = generation;
		const { config } = runtime.activate(ctx.cwd);
		// Looking up the main model's key can take a while: the current pool serves until then.
		const target = config.enabled ? resolveEngine(config.engine, await mainModelFallback(ctx), options.env) : undefined;
		// A newer rebuild or the session's end came first: its result stands, this one builds nothing.
		if (mine !== generation) return;
		const embeddings = config.enabled ? resolveEmbeddings(config.embeddings, options.env) : undefined;
		const pool =
			target &&
			createSidecarPool({
				client: createOpenAIClient(target),
				target,
				config: config.pool,
				moduleLimits: moduleLimitsFrom(config.modules),
				onRecord: (record) => runtime.traceSession?.recordSidecarCall(record),
			});
		pool?.setMainActive(mainActive);
		const previous = runtime.pool;
		runtime.pool = pool;
		runtime.embedder = embeddings
			? createEmbedder(embeddings, { onError: (message) => onError("embeddings", message) })
			: undefined;
		previous?.close();
		if (config.enabled && !target) {
			onError("sidecars", "no sidecar engine (set engine.baseUrl/model, or use an openai-completions main model)");
		}
	}

	const guarded =
		<A extends unknown[]>(where: string, fn: (...args: A) => unknown) =>
		async (...args: A): Promise<undefined> => {
			try {
				await fn(...args);
			} catch (error) {
				onError(where, error);
			}
			return undefined;
		};

	pi.on(
		"session_start",
		guarded("sidecars.session_start", (_event, ctx) => rebuild(ctx)),
	);
	pi.on(
		"model_select",
		guarded("sidecars.model_select", (_event, ctx) => {
			const engine = runtime.config?.engine;
			// Only an engine that follows the main model needs rebuilding.
			if (engine && (!engine.baseUrl || !engine.model)) return rebuild(ctx);
			return undefined;
		}),
	);
	pi.on(
		"input",
		guarded("sidecars.input", (event) => {
			if (event.source === "extension") return;
			// Typed while the agent runs, to steer it or to follow up: the turn goes on, and so does
			// the sidecar work it is waiting on (`streamingBehavior` is set only then, PI_API_NOTES §2).
			if (event.streamingBehavior !== undefined) return;
			runtime.pool?.beginTurn();
			// The user moved on: hot-path work for the previous turn is stale.
			runtime.pool?.cancel((call) => call.priority !== "background");
		}),
	);
	pi.on(
		"agent_start",
		guarded("sidecars.agent_start", () => {
			mainActive = true;
			runtime.pool?.setMainActive(true);
		}),
	);
	pi.on(
		"agent_settled",
		guarded("sidecars.agent_settled", () => {
			mainActive = false;
			runtime.pool?.setMainActive(false);
		}),
	);
	pi.on(
		"session_shutdown",
		guarded("sidecars.session_shutdown", async () => {
			// From here a rebuild still waiting on a key lookup builds nothing.
			generation += 1;
			mainActive = false;
			// Whatever goes wrong in either step, the pool is closed: none outlives its session.
			try {
				await drain(runtime.pool);
			} catch (error) {
				onError("sidecars.drain", error);
			}
			try {
				await options.beforeClose?.();
			} catch (error) {
				onError("sidecars.beforeClose", error);
			}
			const pool = runtime.pool;
			runtime.pool = undefined;
			runtime.embedder = undefined;
			pool?.close();
		}),
	);

	/**
	 * Lets queued and running `background` calls finish, for at most the configured time. The pool
	 * stays in `runtime` meanwhile, so a module can still submit the call its result leads to. What
	 * happened goes to the trace when there was anything to wait for: `remaining` calls were cut off.
	 */
	async function drain(pool: SidecarPool | undefined): Promise<void> {
		const limitMs = shutdownDrainMs(options.env);
		if (!pool || limitMs === 0) return;
		const started = performance.now();
		const { settled, remaining } = await pool.drain(limitMs);
		if (settled + remaining === 0) return;
		runtime.record({
			kind: "exo.action",
			synthetic: true,
			module: "sidecars",
			data: { action: "drained", settled, remaining, ms: Math.round(performance.now() - started), limitMs },
		});
	}
}

/** The main model's endpoint, when it is an OpenAI-compatible chat model (D-032 fallback). */
async function mainModelFallback(ctx: ExtensionContext): Promise<EngineFallback> {
	const model = ctx.model;
	if (model?.api !== "openai-completions") return {};
	const apiKey = await Promise.race([
		ctx.modelRegistry.getApiKeyForProvider(model.provider),
		new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), API_KEY_LOOKUP_TIMEOUT_MS).unref()),
	]);
	return { baseUrl: model.baseUrl, model: model.id, ...(apiKey ? { apiKey } : {}) };
}
