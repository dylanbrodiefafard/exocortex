import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted assistant reply. Replies are consumed in order, one per chat-completions request. */
export type ScriptedReply = (
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "tool_calls"; readonly calls: readonly ScriptedToolCall[] }
	| { readonly kind: "error"; readonly status: number; readonly message: string }
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
	close(): Promise<void>;
}

export interface FakeOpenAIServerOptions {
	readonly model?: string;
	/** Reply used once the script is exhausted. */
	readonly fallback?: ScriptedReply;
	/** Computes replies dynamically; takes precedence over the script. */
	readonly respond?: (body: unknown, index: number) => ScriptedReply;
}

const DEFAULT_MODEL = "fake-model";

/**
 * Minimal OpenAI-compatible server for tests. Speaks `/v1/chat/completions` (streaming SSE and
 * non-streaming) and `/v1/models`, replying from a fixed script. Listens on an ephemeral
 * loopback port.
 */
export async function startFakeOpenAIServer(
	script: readonly ScriptedReply[],
	options: FakeOpenAIServerOptions = {},
): Promise<FakeOpenAIServer> {
	const model = options.model ?? DEFAULT_MODEL;
	const fallback = options.fallback ?? { kind: "text", text: "(script exhausted)" };
	const requests: unknown[] = [];
	let next = 0;
	let inFlight = 0;
	let maxInFlight = 0;

	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
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
		const index = next;
		next += 1;
		const reply = options.respond?.(body, index) ?? script[index] ?? fallback;
		const id = `chatcmpl-fake-${next}`;
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			if (reply.delayMs) await delay(reply.delayMs, res);
			if (res.destroyed) return;
			if (reply.kind === "error") {
				res.writeHead(reply.status, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: reply.message } }));
			} else if (isStreaming(body)) {
				streamReply(res, id, model, reply);
			} else {
				sendJson(res, completionObject(id, model, reply));
			}
		} finally {
			inFlight -= 1;
		}
	}

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		get inFlight() {
			return inFlight;
		},
		get maxInFlight() {
			return maxInFlight;
		},
		close: () => closeServer(server),
	};
}

function isStreaming(body: unknown): boolean {
	return typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true;
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

function usageOf(reply: ScriptedReply) {
	return {
		prompt_tokens: 10,
		completion_tokens: 5,
		total_tokens: 15,
		...(reply.cachedTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: reply.cachedTokens } }),
	};
}

function toolCallsPayload(calls: readonly ScriptedToolCall[]) {
	return calls.map((call, index) => ({
		index,
		id: `call_${index}`,
		type: "function",
		function: { name: call.name, arguments: JSON.stringify(call.arguments) },
	}));
}

type ContentReply = Exclude<ScriptedReply, { kind: "error" }>;

function completionObject(id: string, model: string, reply: ContentReply) {
	const message =
		reply.kind === "text"
			? { role: "assistant", content: reply.text }
			: { role: "assistant", content: null, tool_calls: toolCallsPayload(reply.calls) };
	return {
		id,
		object: "chat.completion",
		created: 0,
		model,
		choices: [{ index: 0, message, finish_reason: reply.kind === "text" ? "stop" : "tool_calls" }],
		usage: usageOf(reply),
	};
}

function streamReply(res: ServerResponse, id: string, model: string, reply: ContentReply): void {
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
	if (reply.kind === "text") {
		chunk({ content: reply.text }, null);
		chunk({}, "stop");
	} else {
		chunk({ tool_calls: toolCallsPayload(reply.calls) }, null);
		chunk({}, "tool_calls");
	}
	chunk({}, null, usageOf(reply));
	res.write("data: [DONE]\n\n");
	res.end();
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.closeAllConnections();
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
