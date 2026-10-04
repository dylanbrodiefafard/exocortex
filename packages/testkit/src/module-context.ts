import {
	type ChatRequest,
	createSidecarPool,
	ENGINE_PROFILES,
	type InferenceClient,
	InferenceError,
	type ModuleContext,
	runShellCommand,
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
}

/**
 * A {@link ModuleContext} for module unit tests: a real sidecar pool over a scripted client
 * (`reply` sees each request; omit it for "no engine configured"), real shell commands in `cwd`,
 * and captured records and logs.
 */
export function createTestModuleContext(options: {
	readonly cwd: string;
	readonly reply?: (request: ChatRequest, index: number) => SidecarReply | Promise<SidecarReply>;
}): TestModuleContext {
	const requests: ChatRequest[] = [];
	const records: Omit<TraceEventInput, "module" | "synthetic">[] = [];
	const logs: string[] = [];
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
			moduleLimits: () => ({ maxCallsPerTurn: 100, maxTokensPerCall: 2048 }),
		});
	return {
		requests,
		records,
		logs,
		context: {
			cwd: options.cwd,
			pool: () => pool,
			record: (event) => records.push(event),
			runCommand: (command, opts) => runShellCommand(command, { cwd: options.cwd, ...opts }),
			log: (message) => logs.push(message),
		},
	};
}
