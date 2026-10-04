import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createOpenAIClient,
	createSidecarPool,
	type EngineFallback,
	moduleLimitsFrom,
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
 * - built at `session_start` (and on `model_select` when the engine follows the main model);
 * - marks the main agent active between `agent_start` and `agent_settled`, so background work waits;
 * - on user input, starts a new turn and cancels stale hot-path calls;
 * - closed at `session_shutdown`.
 *
 * Register this before the trace recorder so in-flight calls are still recorded at shutdown.
 */
export function registerSidecars(pi: ExtensionAPI, options: SidecarOptions): void {
	const { runtime, onError } = options;

	async function rebuild(ctx: ExtensionContext): Promise<void> {
		runtime.pool?.close();
		runtime.pool = undefined;
		const { config } = runtime.activate(ctx.cwd);
		if (!config.enabled) return;
		const target = resolveEngine(config.engine, await mainModelFallback(ctx), options.env);
		if (!target) {
			onError("sidecars", "no sidecar engine (set engine.baseUrl/model, or use an openai-completions main model)");
			return;
		}
		runtime.pool = createSidecarPool({
			client: createOpenAIClient(target),
			target,
			config: config.pool,
			moduleLimits: moduleLimitsFrom(config.modules),
			onRecord: (record) => runtime.traceSession?.recordSidecarCall(record),
		});
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
			runtime.pool?.beginTurn();
			// The user moved on: hot-path work for the previous turn is stale.
			runtime.pool?.cancel((call) => call.priority !== "background");
		}),
	);
	pi.on(
		"agent_start",
		guarded("sidecars.agent_start", () => runtime.pool?.setMainActive(true)),
	);
	pi.on(
		"agent_settled",
		guarded("sidecars.agent_settled", () => runtime.pool?.setMainActive(false)),
	);
	pi.on(
		"session_shutdown",
		guarded("sidecars.session_shutdown", () => {
			runtime.pool?.close();
			runtime.pool = undefined;
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
