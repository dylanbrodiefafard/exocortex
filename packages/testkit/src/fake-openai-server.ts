import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One scripted assistant reply. Replies are consumed in order, one per chat-completions request.
 *
 * Beyond the plain kinds, these stand in for what a real engine does when things go wrong:
 * - `length`: the reply is cut off at the output limit (`finish_reason: "length"`);
 * - `reasoning`: thinking arrives as `reasoning_content`, the answer as `content`;
 * - `overflow`: HTTP 400 with an OpenAI-style context-length error;
 * - `drop_midstream`: the connection is cut after part of the reply (a streaming request gets the
 *   first chunks and no `[DONE]`; a non-streaming one gets no response at all).
 */
export type ScriptedReply = (
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "tool_calls"; readonly calls: readonly ScriptedToolCall[] }
	| { readonly kind: "error"; readonly status: number; readonly message: string }
	| { readonly kind: "length"; readonly text: string }
	| { readonly kind: "reasoning"; readonly reasoning: string; readonly text: string }
	| { readonly kind: "overflow" }
	| { readonly kind: "drop_midstream"; readonly text: string }
) & {
	/** Delay before responding, to simulate generation time. */
	readonly delayMs?: number;
	/** Reported as usage.prompt_tokens_details.cached_tokens. */
	readonly cachedTokens?: number;
};

export interface ScriptedToolCall {
	readonly name: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

export interface FakeOpenAIServer {
	/** Base URL including the `/v1` suffix, e.g. `http://127.0.0.1:41234/v1`. */
	readonly baseUrl: string;
	/** Parsed JSON bodies of every chat-completions request received, in arrival order. */
	readonly requests: readonly unknown[];
	/** Chat-completions requests currently being answered. */
	readonly inFlight: number;
	/** Highest {@link inFlight} observed. */
	readonly maxInFlight: number;
	/** Requests strict mode refused, with the reason. Empty unless `strict` is on. */
	readonly rejected: readonly string[];
	close(): Promise<void>;
}

export interface FakeOpenAIServerOptions {
	readonly model?: string;
	/** Reply used once the script is exhausted. */
	readonly fallback?: ScriptedReply;
	/** Computes replies dynamically; takes precedence over the script. */
	readonly respond?: (body: unknown, index: number) => ScriptedReply;
	/**
	 * Refuse, with HTTP 400, a request whose messages a real chat template would not accept: a
	 * `tool` message that answers no pending call, a message while calls are unanswered, a `system`
	 * message mid-conversation, or a conversation that ends with an `assistant` message. Off by
	 * default: most tests post arbitrary bodies.
	 */
	readonly strict?: boolean;
}

const DEFAULT_MODEL = "fake-model";
/** The usual rough rate; what matters is that a longer request costs more. */
const CHARS_PER_TOKEN = 4;

/**
 * Minimal OpenAI-compatible server for tests. Speaks `/v1/chat/completions` (streaming SSE and
 * non-streaming) and `/v1/models`, replying from a fixed script. Listens on an ephemeral
 * loopback port.
 *
 * It behaves like a real engine where a forgiving fake would hide bugs: usage grows with the
 * request, a stream carries its usage chunk only when `stream_options.include_usage` asks for it,
 * and every tool call has its own id.
 */
export async function startFakeOpenAIServer(
	script: readonly ScriptedReply[],
	options: FakeOpenAIServerOptions = {},
): Promise<FakeOpenAIServer> {
	const model = options.model ?? DEFAULT_MODEL;
	const fallback = options.fallback ?? { kind: "text", text: "(script exhausted)" };
	const requests: unknown[] = [];
	const rejected: string[] = [];
	let next = 0;
	let inFlight = 0;
	let maxInFlight = 0;
	let toolCalls = 0;

	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: String(error) } }));
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "";
		if (req.method === "GET" && url.endsWith("/models")) {
			sendJson(res, { object: "list", data: [{ id: model, object: "model", owned_by: "fake" }] });
			return;
		}
		if (req.method !== "POST" || !url.endsWith("/chat/completions")) {
			res.writeHead(404).end();
			return;
		}
		const body: unknown = JSON.parse(await readBody(req));
		requests.push(body);
		const problem = options.strict ? roleSequenceProblem(body) : undefined;
		if (problem) {
			rejected.push(problem);
			sendError(res, 400, problem, "invalid_request_error");
			return;
		}
		const index = next;
		next += 1;
		const reply = options.respond?.(body, index) ?? script[index] ?? fallback;
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			if (reply.delayMs) await delay(reply.delayMs, res);
			if (!res.destroyed) answer(res, reply, body, `chatcmpl-fake-${next}`);
		} finally {
			inFlight -= 1;
		}
	}

	function answer(res: ServerResponse, reply: ScriptedReply, body: unknown, id: string): void {
		if (reply.kind === "error") {
			sendError(res, reply.status, reply.message);
			return;
		}
		if (reply.kind === "overflow") {
			sendError(
				res,
				400,
				`This model's maximum context length is 32768 tokens. However, your messages resulted in ${promptTokens(body) + 32768} tokens. Please reduce the length of the messages.`,
				"invalid_request_error",
				"context_length_exceeded",
			);
			return;
		}
		const content: Content = { reply, toolCalls: toolCallsPayload(reply, () => ++toolCalls) };
		if (isStreaming(body)) streamReply(res, id, model, content, body);
		else if (reply.kind === "drop_midstream") res.destroy();
		else sendJson(res, completionObject(id, model, content, body));
	}

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		rejected,
		get inFlight() {
			return inFlight;
		},
		get maxInFlight() {
			return maxInFlight;
		},
		close: () => closeServer(server),
	};
}

/**
 * Why a chat template would refuse these messages, or undefined when it would not:
 * - `messages` must be a non-empty list of objects with a known role;
 * - a `system` or `developer` message may only open the conversation;
 * - a `tool` message must answer a tool call of the assistant message before it;
 * - nothing else may come while tool calls are unanswered;
 * - the conversation must end with a `user` or `tool` message.
 */
function roleSequenceProblem(body: unknown): string | undefined {
	const messages = (body as { messages?: unknown } | null)?.messages;
	if (!Array.isArray(messages) || messages.length === 0) return "messages must be a non-empty array";
	const state = { pending: new Set<string>(), started: false };
	for (const [index, message] of messages.entries()) {
		const problem = messageProblem(message as ChatMessageShape | null, state);
		if (problem) return `messages[${index}]: ${problem}`;
	}
	if (state.pending.size > 0) return `tool calls left unanswered (${[...state.pending].join(", ")})`;
	const last = (messages.at(-1) as ChatMessageShape | null)?.role;
	return last === "user" || last === "tool" ? undefined : `the conversation ends with a ${String(last)} message`;
}

interface ChatMessageShape {
	readonly role?: unknown;
	readonly tool_calls?: unknown;
	readonly tool_call_id?: unknown;
}

/** Checks one message against the calls still unanswered, and updates them. */
function messageProblem(
	message: ChatMessageShape | null,
	state: { readonly pending: Set<string>; started: boolean },
): string | undefined {
	const role = message?.role;
	if (role === "tool") {
		const id = String(message?.tool_call_id);
		return state.pending.delete(id) ? undefined : `tool message answers no pending tool call (${id})`;
	}
	if (state.pending.size > 0) {
		return `${String(role)} message while tool calls are unanswered (${[...state.pending].join(", ")})`;
	}
	if (role === "system" || role === "developer") {
		return state.started ? `${role} message after the conversation started` : undefined;
	}
	if (role !== "user" && role !== "assistant") return `unknown role ${JSON.stringify(role)}`;
	state.started = true;
	const calls = role === "assistant" && Array.isArray(message?.tool_calls) ? message.tool_calls : [];
	for (const call of calls) state.pending.add(String((call as { id?: unknown } | null)?.id));
	return undefined;
}

function isStreaming(body: unknown): boolean {
	return typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true;
}

/** A real engine sends the final usage chunk of a stream only when the request asks for it. */
function wantsStreamUsage(body: unknown): boolean {
	const options = (body as { stream_options?: { include_usage?: unknown } } | null)?.stream_options;
	return options?.include_usage === true;
}

/** Waits `ms`, ending early if the client disconnects (as a real engine cancels on disconnect). */
function delay(ms: number, res: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		res.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, value: unknown): void {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

function sendError(res: ServerResponse, status: number, message: string, type?: string, code?: string): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message, ...(type ? { type } : {}), ...(code ? { code } : {}) } }));
}

type ContentReply = Exclude<ScriptedReply, { kind: "error" } | { kind: "overflow" }>;

interface Content {
	readonly reply: ContentReply;
	readonly toolCalls: readonly object[];
}

function tokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function promptTokens(body: unknown): number {
	const request = body as { messages?: unknown; tools?: unknown } | null;
	return tokens(JSON.stringify(request?.messages ?? "")) + (request?.tools ? tokens(JSON.stringify(request.tools)) : 0);
}

/** Usage that grows with what was sent and what was generated, as a real engine's does. */
function usageOf({ reply, toolCalls }: Content, body: unknown) {
	const prompt = promptTokens(body);
	const reasoning = reply.kind === "reasoning" ? tokens(reply.reasoning) : 0;
	const completion =
		(reply.kind === "tool_calls" ? tokens(JSON.stringify(toolCalls)) : tokens(textOf(reply))) + reasoning;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
		...(reply.cachedTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: reply.cachedTokens } }),
		...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
	};
}

function textOf(reply: ContentReply): string {
	return reply.kind === "tool_calls" ? "" : reply.text;
}

function finishReasonOf(reply: ContentReply): string {
	return reply.kind === "tool_calls" ? "tool_calls" : reply.kind === "length" ? "length" : "stop";
}

/** Tool calls with ids unique across the server's lifetime: a harness keys results by them. */
function toolCallsPayload(reply: ContentReply, nextId: () => number): object[] {
	if (reply.kind !== "tool_calls") return [];
	return reply.calls.map((call, index) => ({
		index,
		id: `call_${nextId()}`,
		type: "function",
		function: { name: call.name, arguments: JSON.stringify(call.arguments) },
	}));
}

function completionObject(id: string, model: string, content: Content, body: unknown) {
	const { reply } = content;
	const message =
		reply.kind === "tool_calls"
			? { role: "assistant", content: null, tool_calls: content.toolCalls }
			: {
					role: "assistant",
					content: reply.text,
					...(reply.kind === "reasoning" ? { reasoning_content: reply.reasoning } : {}),
				};
	return {
		id,
		object: "chat.completion",
		created: 0,
		model,
		choices: [{ index: 0, message, finish_reason: finishReasonOf(reply) }],
		usage: usageOf(content, body),
	};
}

function streamReply(res: ServerResponse, id: string, model: string, content: Content, body: unknown): void {
	const { reply } = content;
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (delta: object, finishReason: string | null, usage?: object) => {
		const payload = {
			id,
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: usage ? [] : [{ index: 0, delta, finish_reason: finishReason }],
			...(usage ? { usage } : {}),
		};
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
	};
	chunk({ role: "assistant" }, null);
	if (reply.kind === "drop_midstream") {
		// Half the text, then the socket closes: no finish reason, no usage, no [DONE].
		chunk({ content: reply.text.slice(0, Math.ceil(reply.text.length / 2)) }, null);
		// An empty write's callback runs once the chunks above have been handed to the socket.
		res.write("", () => res.destroy());
		return;
	}
	if (reply.kind === "tool_calls") {
		chunk({ tool_calls: content.toolCalls }, null);
	} else {
		if (reply.kind === "reasoning") chunk({ reasoning_content: reply.reasoning }, null);
		chunk({ content: reply.text }, null);
	}
	chunk({}, finishReasonOf(reply));
	if (wantsStreamUsage(body)) chunk({}, null, usageOf(content, body));
	res.write("data: [DONE]\n\n");
	res.end();
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.closeAllConnections();
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
