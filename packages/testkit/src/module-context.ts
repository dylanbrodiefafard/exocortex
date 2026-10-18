import {
	type ChatRequest,
	createSidecarPool,
	type Embedder,
	ENGINE_PROFILES,
	type EngineFeatures,
	type ForkPrefix,
	type InferenceClient,
	InferenceError,
	type JsonValue,
	type ModuleContext,
	runShellCommand,
	type SettleAction,
	SIDECAR_MAX_TOKENS,
	type TraceEventInput,
} from "@exocortex/core";

/** A sidecar reply: an object (sent as JSON), raw text, or an error to throw. */
export type SidecarReply = object | string | Error;

export interface TestModuleContext {
	readonly context: ModuleContext;
	/** Every sidecar request, in order. */
	readonly requests: ChatRequest[];
	/** Every trace event the module recorded. */
	readonly records: Omit<TraceEventInput, "module" | "synthetic">[];
	readonly logs: string[];
	/** Every progress message the module showed the user. */
	readonly progress: string[];
	/**
	 * Every value the module passed to `saveState`, in order. To test a restore, build the next
	 * context with `savedState: first.states.at(-1)` (and the same `sessionId`).
	 */
	readonly states: JsonValue[];
	/** Every background job the module started (D-097), run at once: `stop` aborts it, `done` is its action. */
	readonly jobs: TestJob[];
	/** Late help the module sent while the agent was working (D-098), in order. */
	readonly late: string[];
	/** Whether the agent counts as idle: late help is then refused. Settable. */
	idle: boolean;
}

interface TestJob {
	readonly label: string;
	readonly stop: AbortController;
	readonly done: Promise<SettleAction | undefined>;
}

/**
 * A {@link ModuleContext} for module unit tests: a real sidecar pool over a scripted client
 * (`reply` sees each request; omit it for "no engine configured"), real shell commands in `cwd`,
 * and captured records and logs.
 */
export function createTestModuleContext(options: {
	readonly cwd: string;
	readonly reply?: (request: ChatRequest, index: number) => SidecarReply | Promise<SidecarReply>;
	/** A scripted embeddings model: one vector per text, or undefined for "the server failed". */
	readonly embed?: (texts: readonly string[]) => number[][] | undefined;
	/** The harness session the module serves; defaults to "test-session". */
	readonly sessionId?: string;
	/** What an earlier instance of the module saved in this session (`ModuleContext.savedState`). */
	readonly savedState?: JsonValue;
	/** What the engine supports beyond the `generic` profile. */
	readonly features?: Partial<EngineFeatures>;
	/** Cached prompt tokens each reply reports, of 100; not reported when left out. */
	readonly cachedTokens?: number;
	/**
	 * Run background jobs (D-097), as an interactive session does. Off by default: a module then
	 * does its work in the hook, as without a UI, and a test reads the hook's result.
	 */
	readonly background?: boolean;
	/** The main agent's context a module may continue from (`ModuleContext.forkPrefix`); none when left out. */
	readonly forkPrefix?: ForkPrefix;
}): TestModuleContext {
	const requests: ChatRequest[] = [];
	const records: Omit<TraceEventInput, "module" | "synthetic">[] = [];
	const logs: string[] = [];
	const progress: string[] = [];
	const states: JsonValue[] = [];
	const jobs: TestJob[] = [];
	const late: string[] = [];
	const { reply } = options;
	const client: InferenceClient | undefined = reply && {
		async chat(request, signal, chatOptions) {
			requests.push(request);
			// A real client stops waiting when its signal fires; a fake that does not would let a
			// module's timeout and cancellation paths go untested.
			const aborted = new Promise<never>((_, reject) => {
				const fail = () => reject(new InferenceError("aborted", "request aborted"));
				if (signal?.aborted) fail();
				else signal?.addEventListener("abort", fail, { once: true });
			});
			const value = await Promise.race([reply(request, requests.length - 1), aborted]);
			if (value instanceof Error) throw new InferenceError("http", value.message);
			const text = typeof value === "string" ? value : JSON.stringify(value);
			// The whole reply arrives as one piece, as from an engine that streams it in one chunk.
			chatOptions?.onProgress?.(text.length);
			return {
				text,
				finishReason: "stop",
				usage: { promptTokens: 100, completionTokens: 20, cachedTokens: options.cachedTokens ?? null },
			};
		},
	};
	const pool =
		client &&
		createSidecarPool({
			client,
			target: {
				baseUrl: "http://sidecar.test/v1",
				model: "m",
				apiKey: undefined,
				features: { ...ENGINE_PROFILES.generic, ...options.features },
			},
			config: {
				maxConcurrent: 3,
				reservedForMain: 1,
				timeoutMs: 5_000,
				sessionTokenBudget: 0,
				backgroundWhenIdleOnly: true,
			},
			moduleLimits: () => ({ maxTokensPerCall: SIDECAR_MAX_TOKENS }),
		});
	const { embed } = options;
	const embedder: Embedder | undefined = embed && {
		model: "test-embed",
		// Unit length, as the real embedder returns them.
		embed: async (texts) =>
			embed(texts)?.map((v) => {
				const length = Math.hypot(...v) || 1;
				return Float32Array.from(v.map((x) => x / length));
			}),
	};
	const result: TestModuleContext = {
		requests,
		records,
		logs,
		progress,
		states,
		jobs,
		late,
		idle: false,
		context: {
			cwd: options.cwd,
			sessionId: options.sessionId ?? "test-session",
			savedState: options.savedState,
			// As the real host does: what is kept is the JSON, not the module's live object.
			saveState: (value) => states.push(JSON.parse(JSON.stringify(value)) as JsonValue),
			pool: () => pool,
			embedder: () => embedder,
			record: (event) => records.push(event),
			runCommand: (command, opts) => runShellCommand(command, { cwd: options.cwd, ...opts }),
			progress: (message) => progress.push(message),
			log: (message) => logs.push(message),
			background: (label, job) => {
				if (!options.background) return false;
				// As the real host does: one job per module, a new one stops the last.
				jobs.at(-1)?.stop.abort();
				const stop = new AbortController();
				jobs.push({ label, stop, done: job(stop.signal) });
				return true;
			},
			forkPrefix: async () => options.forkPrefix,
			deliverLate: (text) => {
				if (result.idle) return false;
				late.push(text);
				return true;
			},
		},
	};
	return result;
}
