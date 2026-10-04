import {
	type ExoConfig,
	type LoadedConfig,
	loadConfig,
	openTraceStore,
	type SidecarPool,
	type TraceSession,
	type TraceStore,
} from "@exocortex/core";

export interface Runtime {
	/** Loads config for `cwd` (once) and opens the trace store if enabled. Never throws. */
	activate(cwd: string): LoadedConfig;
	readonly config: ExoConfig | undefined;
	readonly store: TraceStore | undefined;
	/** The current pi session's trace, while one is open. */
	traceSession: TraceSession | undefined;
	/** The sidecar pool for the current pi session, when an engine is configured. */
	pool: SidecarPool | undefined;
	/** Flushes and closes the store. */
	shutdown(): void;
}

export interface RuntimeOptions {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly onError: (where: string, error: unknown) => void;
}

/** Process-wide Exocortex state shared by every hook in the pi adapter. */
export function createRuntime(options: RuntimeOptions): Runtime {
	let loaded: LoadedConfig | undefined;
	let store: TraceStore | undefined;

	return {
		activate(cwd) {
			if (loaded) return loaded;
			try {
				loaded = loadConfig({ cwd, env: options.env });
			} catch (error) {
				options.onError("config", error);
				loaded = loadConfig({ cwd, env: options.env, readFile: () => undefined });
				loaded = { ...loaded, config: { ...loaded.config, enabled: false }, problems: [String(error)] };
			}
			const { config } = loaded;
			if (config.enabled && config.trace.enabled) {
				try {
					store = openTraceStore({
						path: config.trace.dbPath,
						onError: (error) => options.onError("trace write", error),
					});
				} catch (error) {
					options.onError("trace open", error);
				}
			}
			return loaded;
		},
		get config() {
			return loaded?.config;
		},
		get store() {
			return store;
		},
		traceSession: undefined,
		pool: undefined,
		shutdown() {
			try {
				store?.close();
			} catch (error) {
				options.onError("trace close", error);
			}
			store = undefined;
		},
	};
}
