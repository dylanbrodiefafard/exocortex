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

/**
 * When an engine counts as stopped (D-098): no first token within `firstTokenMs` plus the time a
 * slow prefill of the prompt takes, or no token for `stallMs` after that. A slow reply is not
 * stopped; only one that stops arriving is.
 */
export interface Liveness {
	readonly firstTokenMs: number;
	readonly stallMs: number;
}

export interface ChatOptions {
	readonly liveness?: Liveness;
	/** Called as the reply arrives, with the characters so far (reasoning included). */
	readonly onProgress?: (chars: number) => void;
}

export interface InferenceClient {
	/**
	 * One chat completion, streamed and returned whole. Rejects with {@link InferenceError}; kind
	 * `stalled` when the engine stopped answering by `options.liveness`.
	 */
	chat(request: ChatRequest, signal?: AbortSignal, options?: ChatOptions): Promise<ChatResponse>;
}

export class InferenceError extends Error {
	readonly kind: "http" | "network" | "aborted" | "bad_response" | "stalled";
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
		// Streamed so a stalled engine can be told from a slow one (D-098); usage comes in the last chunk.
		stream: true,
		stream_options: { include_usage: true },
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
		async chat(request, signal, options = {}) {
			const body = JSON.stringify(buildChatBody(target, request));
			const watch = watchLiveness(options.liveness, body.length, signal);
			try {
				let response: Response;
				try {
					response = await fetchImpl(`${target.baseUrl}/chat/completions`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
						},
						body,
						signal: watch.signal,
					});
				} catch (error) {
					throw watch.failure(error);
				}
				if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
					// An error, or a server that answers whole: nothing arrives in pieces to watch.
					watch.pause();
					const text = await response.text().catch((error: unknown) => {
						throw watch.failure(error);
					});
					if (!response.ok) {
						throw new InferenceError("http", `HTTP ${response.status}: ${text.slice(0, 500)}`, response.status);
					}
					return parseChatResponse(text);
				}
				return await readStream(response, watch, options.onProgress);
			} finally {
				watch.stop();
			}
		},
	};
}

/**
 * Prompt tokens per second a prefill is assumed to reach at the least: it widens the first-token
 * window for long prompts so a slow prefill is not taken for a stopped engine. Loose on purpose:
 * this tells a dead engine from a slow one, nothing finer.
 */
const MIN_PREFILL_TOKENS_PER_S = 500;
/** Characters of request body per prompt token, roughly. */
const CHARS_PER_TOKEN = 4;

interface Watch {
	readonly signal: AbortSignal;
	/** Something arrived that the engine generated: the stall window starts over. */
	alive(): void;
	/** No more liveness to watch: the reply is being read whole. The caller's signal still aborts it. */
	pause(): void;
	stop(): void;
	/** Ends the request: the engine stops generating for it. */
	abort(): void;
	/** The error to throw for a failed read: stalled, aborted by the caller, or the network's. */
	failure(error: unknown): InferenceError;
}

function watchLiveness(liveness: Liveness | undefined, bodyChars: number, signal: AbortSignal | undefined): Watch {
	const inner = new AbortController();
	const onAbort = () => inner.abort();
	if (signal?.aborted) inner.abort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	let stalled: string | undefined;
	let timer: NodeJS.Timeout | undefined;
	const arm = (ms: number, why: string) => {
		clearTimeout(timer);
		if (!liveness) return;
		timer = setTimeout(() => {
			stalled = why;
			inner.abort();
		}, ms);
		timer.unref?.();
	};
	if (liveness) {
		const prefillMs = Math.round((bodyChars / CHARS_PER_TOKEN / MIN_PREFILL_TOKENS_PER_S) * 1000);
		const firstMs = liveness.firstTokenMs + prefillMs;
		arm(firstMs, `no token within ${firstMs} ms`);
	}
	return {
		signal: inner.signal,
		alive: () => liveness && arm(liveness.stallMs, `no token for ${liveness.stallMs} ms`),
		pause: () => clearTimeout(timer),
		stop: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
		abort: () => inner.abort(),
		failure: (error) => {
			if (stalled !== undefined) return new InferenceError("stalled", `engine stopped answering: ${stalled}`);
			if (signal?.aborted) return new InferenceError("aborted", "request aborted");
			return error instanceof InferenceError ? error : new InferenceError("network", String(error));
		},
	};
}

/**
 * A server-sent event stream of chat completion chunks, put together: the reply's content, its
 * finish reason, and the usage the last chunk carries. Reasoning deltas count as the engine being
 * alive but are not part of the text, as in a whole reply.
 */
async function readStream(
	response: Response,
	watch: Watch,
	onProgress: ((chars: number) => void) | undefined,
): Promise<ChatResponse> {
	const reader = response.body?.getReader();
	if (!reader) throw new InferenceError("bad_response", "streamed response has no body");
	const decoder = new TextDecoder();
	const reply = { text: "", chars: 0, finishReason: null as string | null, usage: null as ChatUsage | null, chunks: 0 };
	/** One line of the stream; true once it said the stream is done. */
	const take = (raw: string): boolean => {
		const line = raw.replace(/\r$/, "");
		if (!line.startsWith("data:")) return false;
		const data = line.slice(5).trim();
		if (data === "[DONE]") return true;
		if (data !== "" && applyChunk(reply, data)) {
			watch.alive();
			onProgress?.(reply.chars);
		}
		return false;
	};
	let buffer = "";
	let complete = false;
	try {
		while (!complete) {
			let read: Awaited<ReturnType<typeof reader.read>>;
			try {
				read = await reader.read();
			} catch (error) {
				throw watch.failure(error);
			}
			if (read.done) {
				// A last line with no newline after it, and what the decoder still holds.
				buffer += decoder.decode();
				if (buffer !== "") take(buffer);
				complete = true;
				break;
			}
			buffer += decoder.decode(read.value, { stream: true });
			let end = buffer.indexOf("\n");
			while (end !== -1 && !complete) {
				complete = take(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				end = buffer.indexOf("\n");
			}
		}
	} finally {
		// Ended early (a bad chunk, an error event, a throwing callback) or at `[DONE]` with the
		// connection still open: close it, so the engine stops generating for a call that is over.
		watch.abort();
		reader.cancel().catch(() => undefined);
	}
	if (reply.chunks === 0) throw new InferenceError("bad_response", "stream carried no completion chunks");
	return { text: reply.text, finishReason: reply.finishReason, usage: reply.usage };
}

/** Adds one chunk to the reply; true when it carried something the engine generated. */
function applyChunk(
	reply: { text: string; chars: number; finishReason: string | null; usage: ChatUsage | null; chunks: number },
	data: string,
): boolean {
	let json: Readonly<Record<string, unknown>>;
	try {
		json = record(JSON.parse(data));
	} catch {
		throw new InferenceError("bad_response", `stream chunk is not JSON: ${data.slice(0, 200)}`);
	}
	const error = record(json["error"]);
	if (Object.keys(error).length > 0) {
		throw new InferenceError(
			"http",
			`stream error: ${String(error["message"] ?? JSON.stringify(error)).slice(0, 500)}`,
		);
	}
	reply.chunks += 1;
	const usage = usageOf(json["usage"]);
	if (usage) reply.usage = usage;
	const choice = record(array(json["choices"])[0]);
	const delta = record(choice["delta"]);
	const content = typeof delta["content"] === "string" ? delta["content"] : "";
	const reasoning = [delta["reasoning_content"], delta["reasoning"]].find((r) => typeof r === "string") as
		| string
		| undefined;
	reply.text += content;
	reply.chars += content.length + (reasoning?.length ?? 0);
	if (typeof choice["finish_reason"] === "string") reply.finishReason = choice["finish_reason"];
	return content !== "" || (reasoning ?? "") !== "" || typeof choice["finish_reason"] === "string";
}

function usageOf(value: unknown): ChatUsage | null {
	const usage = record(value);
	const promptTokens = usage["prompt_tokens"];
	const completionTokens = usage["completion_tokens"];
	const cached = record(usage["prompt_tokens_details"])["cached_tokens"];
	return typeof promptTokens === "number" && typeof completionTokens === "number"
		? { promptTokens, completionTokens, cachedTokens: typeof cached === "number" ? cached : null }
		: null;
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
	return {
		text: content,
		finishReason: typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : null,
		usage: usageOf(record(json)["usage"]),
	};
}

function record(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}
