import type { ExoConfig } from "../config.ts";

/** Engine capabilities Exocortex can use (docs/INFERENCE_ENGINES.md F1–F7, F10). */
export interface EngineFeatures {
	/** F1: automatic prefix caching shared across concurrent requests. */
	readonly prefixCaching: boolean;
	/** F2: `usage.prompt_tokens_details.cached_tokens` is reported. */
	readonly cachedTokens: boolean;
	/** F3: `response_format: json_schema` is grammar-enforced. */
	readonly jsonSchema: boolean;
	/** F4: `chat_template_kwargs.enable_thinking` changes only the generation suffix. */
	readonly thinkingToggle: boolean;
	/** F5: request-level `priority` (vLLM semantics: lower runs first). */
	readonly priority: boolean;
	/** F6: `logprobs` / `top_logprobs`. */
	readonly logprobs: boolean;
	/** F7: `n > 1` sharing one prefill. */
	readonly n: boolean;
	/**
	 * F10: a request can read the prefix cache without writing to it (`ninfer.cache_write: false`),
	 * and the entry it read is left as it was (D-093).
	 */
	readonly cacheReadOnly: boolean;
}

export type EngineProfile = ExoConfig["engine"]["profile"];

/**
 * What each engine supports out of the box, per docs/INFERENCE_ENGINES.md. Conservative where
 * support depends on server flags; override per feature in config (`engine.features`).
 */
export const ENGINE_PROFILES: Readonly<Record<EngineProfile, EngineFeatures>> = {
	generic: {
		prefixCaching: false,
		cachedTokens: false,
		jsonSchema: false,
		thinkingToggle: false,
		priority: false,
		logprobs: false,
		n: false,
		cacheReadOnly: false,
	},
	vllm: {
		prefixCaching: true,
		cachedTokens: false, // needs --enable-prompt-tokens-details
		jsonSchema: true,
		thinkingToggle: true,
		priority: false, // needs --scheduling-policy priority
		logprobs: true,
		n: true,
		cacheReadOnly: false,
	},
	sglang: {
		prefixCaching: true,
		cachedTokens: true,
		jsonSchema: true,
		thinkingToggle: true,
		priority: false, // needs priority scheduling enabled
		logprobs: true,
		n: true,
		cacheReadOnly: false,
	},
	llamacpp: {
		prefixCaching: false, // per-slot cache; no concurrent sharing
		cachedTokens: false,
		jsonSchema: true,
		thinkingToggle: true,
		priority: false,
		logprobs: true,
		n: false,
		cacheReadOnly: false,
	},
	// The owner's fork at its `experimental` branch; upstream ninfer has none of these beyond
	// `cachedTokens` and rejects the `ninfer.cache_write` field: use `generic` for it.
	"dylanbrodiefafard/ninfer": {
		prefixCaching: false, // one owner per cached prefix: no concurrent sharing
		cachedTokens: true,
		jsonSchema: true,
		thinkingToggle: false,
		priority: false,
		logprobs: true,
		n: false,
		cacheReadOnly: true, // `ninfer.cache_write`, on the fork's `experimental` branch since 17c504c
	},
};

export interface EngineTarget {
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey: string | undefined;
	readonly features: EngineFeatures;
}

/** What the harness knows about its main model, used when `engine` leaves fields unset. */
export interface EngineFallback {
	readonly baseUrl?: string;
	readonly model?: string;
	readonly apiKey?: string;
}

/**
 * Resolves the sidecar endpoint: explicit config first, then the main model's endpoint.
 * Returns undefined when no base URL or model is known; sidecars are then disabled.
 */
export function resolveEngine(
	engine: ExoConfig["engine"],
	fallback: EngineFallback = {},
	env: Readonly<Record<string, string | undefined>> = process.env,
): EngineTarget | undefined {
	const baseUrl = engine.baseUrl ?? fallback.baseUrl;
	const model = engine.model ?? fallback.model;
	if (!baseUrl || !model) return undefined;
	const apiKey = engine.apiKey === undefined ? fallback.apiKey : expandEnv(engine.apiKey, env);
	const overrides = Object.fromEntries(Object.entries(engine.features ?? {}).filter(([, v]) => v !== undefined));
	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		model,
		apiKey: apiKey === "" ? undefined : apiKey,
		features: { ...ENGINE_PROFILES[engine.profile], ...overrides },
	};
}

export function expandEnv(value: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
	const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value);
	return match ? env[match[1] ?? ""] : value;
}
