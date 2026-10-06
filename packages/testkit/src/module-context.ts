import {
	type ChatRequest,
	createSidecarPool,
	type Embedder,
	ENGINE_PROFILES,
	type InferenceClient,
	InferenceError,
	type JsonValue,
	type ModuleContext,
	runShellCommand,
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
}): TestModuleContext {
	const requests: ChatRequest[] = [];
	const records: Omit<TraceEventInput, "module" | "synthetic">[] = [];
	const logs: string[] = [];
	const progress: string[] = [];
	const states: JsonValue[] = [];
	const { reply } = options;
	const client: InferenceClient | undefined = reply && {
		async chat(request) {
			requests.push(request);
			const value = await reply(request, requests.length - 1);
			if (value instanceof Error) throw new InferenceError("http", value.message);
			return {
				text: typeof value === "string" ? value : JSON.stringify(value),
				finishReason: "stop",
				usage: { promptTokens: 100, completionTokens: 20, cachedTokens: null },
			};
		},
	};
	const pool =
		client &&
		createSidecarPool({
			client,
			target: { baseUrl: "http://sidecar.test/v1", model: "m", apiKey: undefined, features: ENGINE_PROFILES.generic },
			config: {
				maxConcurrent: 3,
				reservedForMain: 1,
				timeoutMs: 5_000,
				sessionTokenBudget: 0,
				backgroundWhenIdleOnly: true,
			},
			moduleLimits: () => ({ maxCallsPerTurn: 100, maxTokensPerCall: SIDECAR_MAX_TOKENS }),
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
	return {
		requests,
		records,
		logs,
		progress,
		states,
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
		},
	};
}
