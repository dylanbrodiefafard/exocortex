import {
	type Embedder,
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
	/** Set with the pool when an embeddings server is configured. */
	embedder: Embedder | undefined;
	/** Live `/exo` toggles layered over config (brief §5.3 kill switches). */
	readonly overrides: { allOff: boolean; readonly modules: Record<string, Record<string, unknown>> };
	/** Rebuilds module instances after a toggle (set by the module host). */
	rebuildModules: () => void;
	/** One status line per active module (set by the module host). */
	moduleStatus: () => string[];
	/** Every module id the host knows, enabled or not (set by the module host). */
	moduleIds: () => readonly string[];
	/** Passes `/exo <module> <args>` to an enabled module; undefined when it has no answer. */
	moduleCommand: (id: string, args: string) => string | undefined;
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
		embedder: undefined,
		overrides: { allOff: false, modules: {} },
		rebuildModules: () => {},
		moduleStatus: () => [],
		moduleIds: () => [],
		moduleCommand: () => undefined,
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
