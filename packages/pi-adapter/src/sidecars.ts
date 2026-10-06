import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createEmbedder,
	createOpenAIClient,
	createSidecarPool,
	type EngineFallback,
	moduleLimitsFrom,
	resolveEmbeddings,
	resolveEngine,
} from "@exocortex/core";
import type { Runtime } from "./runtime.ts";

export interface SidecarOptions {
	readonly runtime: Runtime;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly onError: (where: string, error: unknown) => void;
}

const API_KEY_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Owns the sidecar pool's lifecycle for each pi session (brief §5.2):
 * - built at `session_start` (and on `model_select` when the engine follows the main model): the
 *   new pool replaces the old one in one step, so modules never find the pool missing in between;
 * - marks the main agent active between `agent_start` and `agent_settled`, so background work waits;
 * - on a new prompt (not a message steered into the running turn), starts a new turn and cancels
 *   stale hot-path calls;
 * - closed at `session_shutdown`.
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
		guarded("sidecars.session_shutdown", () => {
			generation += 1;
			mainActive = false;
			const pool = runtime.pool;
			runtime.pool = undefined;
			runtime.embedder = undefined;
			pool?.close();
		}),
	);
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
