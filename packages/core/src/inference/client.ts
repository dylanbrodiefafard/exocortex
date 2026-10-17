import type { JsonValue } from "../trace/store.ts";
import type { EngineTarget } from "./engine.ts";

export type JsonObject = { readonly [key: string]: JsonValue };

/** An OpenAI chat message. Kept loose so fork-prefix calls can reuse the main agent's messages verbatim. */
export type ChatMessage = JsonObject & { readonly role: string };

/**
 * The main agent's context as a request body (D-093): its last request, with the conversation
 * since then appended to `messages`. A call that carries one sends its own messages after these,
 * so the engine's prefix cache serves everything the main agent has already paid for.
 */
export interface ForkPrefix {
	readonly body: JsonObject;
}

export interface ChatRequest {
	/** With `fork`, the messages that follow the main agent's. */
	readonly messages: readonly ChatMessage[];
	readonly maxTokens: number;
	readonly temperature?: number;
	/** `false` sends `chat_template_kwargs.enable_thinking = false` (Qwen-style templates). */
	readonly thinking?: boolean;
	/** Engine scheduling priority (vLLM semantics, lower first); sent only when the engine supports it. */
	readonly priority?: number;
	/** Grammar-constrained JSON output; sent only when the engine supports `json_schema`. */
	readonly jsonSchema?: { readonly name: string; readonly schema: JsonValue };
	/**
	 * `false` asks the engine to read its prefix cache and leave it as it was (F10); sent only when
	 * the engine supports it.
	 */
	readonly cacheWrite?: false;
	/**
	 * Continue from the main agent's context. The tools, sampling and thinking settings are the
	 * main agent's, since changing them changes the prompt before the fork; `thinking` applies
	 * only on an engine where it changes the generation suffix alone (F4).
	 */
	readonly fork?: ForkPrefix;
}

export interface ChatUsage {
	/** All prompt tokens, including cached ones. */
	readonly promptTokens: number;
	/** Prompt tokens served from the engine's prefix cache, when reported. */
	readonly cachedTokens: number | null;
	readonly completionTokens: number;
}

export interface ChatResponse {
	readonly text: string;
	readonly finishReason: string | null;
	readonly usage: ChatUsage | null;
}

export interface InferenceClient {
	/** One non-streaming chat completion. Rejects with {@link InferenceError}. */
	chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

export class InferenceError extends Error {
	readonly kind: "http" | "network" | "aborted" | "bad_response";
	readonly status: number | undefined;

	constructor(kind: InferenceError["kind"], message: string, status?: number) {
		super(message);
		this.name = "InferenceError";
		this.kind = kind;
		this.status = status;
	}
}

/** Builds the request body, using only fields the engine profile says it supports (D-032). */
export function buildChatBody(target: EngineTarget, request: ChatRequest): JsonObject {
	const base = request.fork ? forkBase(target, request, request.fork) : undefined;
	return {
		...(base ?? { model: target.model, messages: request.messages }),
		max_tokens: request.maxTokens,
		stream: false,
		...(request.temperature === undefined ? {} : { temperature: request.temperature }),
		...(request.thinking === undefined || base ? {} : { chat_template_kwargs: { enable_thinking: request.thinking } }),
		...(request.priority !== undefined && target.features.priority ? { priority: request.priority } : {}),
		...(request.cacheWrite === false && target.features.cacheReadOnly ? { ninfer: { cache_write: false } } : {}),
		...(request.jsonSchema && target.features.jsonSchema
			? {
					response_format: {
						type: "json_schema",
						json_schema: { name: request.jsonSchema.name, schema: request.jsonSchema.schema, strict: true },
					},
				}
			: {}),
	};
}

/** Fields of the main agent's request that belong to how it is answered, not to its prompt. */
const NOT_FORKED = new Set([
	"stream",
	"stream_options",
	"max_tokens",
	"max_completion_tokens",
	"n",
	"logprobs",
	"top_logprobs",
	"response_format",
]);

/** The main agent's request with this call's messages after its own. */
function forkBase(target: EngineTarget, request: ChatRequest, fork: ForkPrefix): JsonObject {
	const kept = Object.fromEntries(Object.entries(fork.body).filter(([key]) => !NOT_FORKED.has(key)));
	const messages = Array.isArray(kept["messages"]) ? kept["messages"] : [];
	const kwargs = record(kept["chat_template_kwargs"]) as JsonObject;
	return {
		...kept,
		messages: [...messages, ...request.messages],
		...(request.thinking !== undefined && target.features.thinkingToggle
			? { chat_template_kwargs: { ...kwargs, enable_thinking: request.thinking } }
			: {}),
	};
}

/** Client for any OpenAI-compatible `/chat/completions` endpoint. */
export function createOpenAIClient(target: EngineTarget, fetchImpl: typeof fetch = fetch): InferenceClient {
	return {
		async chat(request, signal) {
			let response: Response;
			try {
				response = await fetchImpl(`${target.baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
					},
					body: JSON.stringify(buildChatBody(target, request)),
					...(signal ? { signal } : {}),
				});
			} catch (error) {
				if (signal?.aborted) throw new InferenceError("aborted", "request aborted");
				throw new InferenceError("network", String(error));
			}
			const text = await response.text().catch((error: unknown) => {
				throw signal?.aborted
					? new InferenceError("aborted", "request aborted")
					: new InferenceError("network", String(error));
			});
			if (!response.ok) {
				throw new InferenceError("http", `HTTP ${response.status}: ${text.slice(0, 500)}`, response.status);
			}
			return parseChatResponse(text);
		},
	};
}

function parseChatResponse(body: string): ChatResponse {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		throw new InferenceError("bad_response", `response is not JSON: ${body.slice(0, 200)}`);
	}
	const choice = record(array(record(json)["choices"])[0]);
	const message = record(choice["message"]);
	const content = message["content"];
	if (typeof content !== "string") {
		throw new InferenceError("bad_response", "response has no choices[0].message.content string");
	}
	const usage = record(record(json)["usage"]);
	const promptTokens = usage["prompt_tokens"];
	const completionTokens = usage["completion_tokens"];
	const cached = record(usage["prompt_tokens_details"])["cached_tokens"];
	return {
		text: content,
		finishReason: typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : null,
		usage:
			typeof promptTokens === "number" && typeof completionTokens === "number"
				? { promptTokens, completionTokens, cachedTokens: typeof cached === "number" ? cached : null }
				: null,
	};
}

function record(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}
