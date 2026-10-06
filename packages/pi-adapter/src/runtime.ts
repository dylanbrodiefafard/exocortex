import {
	type Dialog,
	type Embedder,
	type ExoConfig,
	type LoadedConfig,
	loadConfig,
	type ModuleSettingsSchemas,
	openTraceStore,
	type SidecarPool,
	type TraceEventInput,
	type TraceSession,
	type TraceStore,
} from "@exocortex/core";

export interface Runtime {
	/**
	 * Loads config for `cwd` (once) and opens the trace store if enabled, again if a session's end
	 * closed it. Never throws.
	 */
	activate(cwd: string): LoadedConfig;
	readonly config: ExoConfig | undefined;
	readonly store: TraceStore | undefined;
	/** The current pi session's trace, while one is open. */
	traceSession: TraceSession | undefined;
	/** The agent turn now running (pi's `turnIndex`), once the session has had one. */
	turn: number | undefined;
	/** Appends to the current session's trace, stamped with the current turn; a no-op without one. */
	record(event: Omit<TraceEventInput, "turn">): void;
	/** The sidecar pool for the current pi session, when an engine is configured. */
	pool: SidecarPool | undefined;
	/** Set with the pool when an embeddings server is configured. */
	embedder: Embedder | undefined;
	/** Live `/exo` toggles layered over config (brief §5.3 kill switches). */
	readonly overrides: { allOff: boolean; modules: Record<string, Record<string, unknown>> };
	/** Rebuilds the module instances whose settings a toggle changed (set by the module host). */
	rebuildModules: () => void;
	/** Disposes every module instance, within a short budget; never rejects (set by the module host). */
	disposeModules: () => Promise<void>;
	/** One status line per active module (set by the module host). */
	moduleStatus: () => string[];
	/** Every module id the host knows, enabled or not (set by the module host). */
	moduleIds: () => readonly string[];
	/**
	 * Passes `/exo <module> <args>` to an enabled module; undefined when it has no answer. `dialog`
	 * lets the module ask the user questions.
	 */
	moduleCommand: (id: string, args: string, dialog?: Dialog) => Promise<string | undefined>;
	/** Flushes and closes the store; `activate` opens it again. */
	shutdown(): void;
}

export interface RuntimeOptions {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly onError: (where: string, error: unknown) => void;
	/**
	 * The modules that exist, with their settings schemas: config naming another module, or a
	 * setting a module does not have, is then a problem (D-080). Left out, `modules` is not checked.
	 */
	readonly moduleSettings?: ModuleSettingsSchemas;
}

/** Process-wide Exocortex state shared by every hook in the pi adapter. */
export function createRuntime(options: RuntimeOptions): Runtime {
	let loaded: LoadedConfig | undefined;
	let store: TraceStore | undefined;
	/** The store could not be opened: reported once, not retried at every session start. */
	let storeFailed = false;

	function openStore(config: ExoConfig): void {
		if (store || storeFailed || !config.enabled || !config.trace.enabled) return;
		try {
			store = openTraceStore({
				path: config.trace.dbPath,
				retentionMs: config.trace.retentionDays * 86_400_000,
				onError: (error) => options.onError("trace write", error),
			});
		} catch (error) {
			storeFailed = true;
			options.onError("trace open", error);
		}
	}

	return {
		activate(cwd) {
			if (loaded) {
				// A session's end closed the store: one connection per session, none left behind.
				openStore(loaded.config);
				return loaded;
			}
			try {
				const modules = options.moduleSettings;
				loaded = loadConfig({ cwd, env: options.env, ...(modules ? { modules } : {}) });
			} catch (error) {
				options.onError("config", error);
				loaded = loadConfig({ cwd, env: options.env, readFile: () => undefined });
				loaded = { ...loaded, config: { ...loaded.config, enabled: false }, problems: [String(error)], ignored: [] };
			}
			openStore(loaded.config);
			return loaded;
		},
		get config() {
			return loaded?.config;
		},
		get store() {
			return store;
		},
		traceSession: undefined,
		turn: undefined,
		record(event) {
			this.traceSession?.append(this.turn === undefined ? event : { ...event, turn: this.turn });
		},
		pool: undefined,
		embedder: undefined,
		overrides: { allOff: false, modules: {} },
		rebuildModules: () => {},
		disposeModules: async () => {},
		moduleStatus: () => [],
		moduleIds: () => [],
		moduleCommand: async () => undefined,
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
