import { type FakeOpenAIServer, type ScriptedReply, startFakeOpenAIServer } from "@exocortex/testkit";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildChatBody,
	type ChatRequest,
	type ChatResponse,
	createOpenAIClient,
	type InferenceClient,
	InferenceError,
	withToolResult,
} from "../src/inference/client.ts";
import { ENGINE_PROFILES, type EngineTarget, resolveEngine } from "../src/inference/engine.ts";
import { completeStructured, extractJson, StructuredOutputError } from "../src/inference/structured.ts";

let server: FakeOpenAIServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

function target(overrides: Partial<EngineTarget["features"]> = {}, baseUrl = "http://x/v1"): EngineTarget {
	return { baseUrl, model: "m", apiKey: "k", features: { ...ENGINE_PROFILES.generic, ...overrides } };
}

async function serve(script: readonly ScriptedReply[]): Promise<EngineTarget> {
	server = await startFakeOpenAIServer(script);
	return { ...target(), baseUrl: server.baseUrl };
}

describe("resolveEngine", () => {
	const engine = { profile: "vllm" as const };

	it("prefers config, falls back to the main model, and merges feature overrides", () => {
		const resolved = resolveEngine(
			{ ...engine, baseUrl: "http://e/v1/", features: { priority: true } },
			{ baseUrl: "http://main/v1", model: "qwen", apiKey: "main-key" },
		);
		expect(resolved).toEqual({
			baseUrl: "http://e/v1",
			model: "qwen",
			apiKey: "main-key",
			features: { ...ENGINE_PROFILES.vllm, priority: true },
		});
	});

	it("expands $ENV api keys and disables sidecars when nothing is known", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal ${NAME} expansion
		expect(resolveEngine({ ...engine, baseUrl: "u", model: "m", apiKey: "${KEY}" }, {}, { KEY: "s3" })?.apiKey).toBe(
			"s3",
		);
		expect(resolveEngine({ ...engine, baseUrl: "u", model: "m", apiKey: "$MISSING" }, {}, {})?.apiKey).toBeUndefined();
		expect(resolveEngine(engine, { model: "m" })).toBeUndefined();
	});
});

describe("buildChatBody", () => {
	const request = {
		messages: [{ role: "user", content: "hi" }],
		maxTokens: 64,
		thinking: false,
		priority: 2,
		jsonSchema: { name: "v", schema: { type: "object" } },
	};

	it("omits unsupported features (generic engine)", () => {
		expect(buildChatBody(target(), request)).toEqual({
			model: "m",
			messages: request.messages,
			max_tokens: 64,
			stream: true,
			stream_options: { include_usage: true },
			chat_template_kwargs: { enable_thinking: false },
		});
	});

	it("asks for a read-only cache only where the engine has it", () => {
		const readOnly = { ...request, cacheWrite: false as const };
		expect(buildChatBody(target(), readOnly)).not.toHaveProperty("ninfer");
		expect(buildChatBody(target({ cacheReadOnly: true }), readOnly)).toMatchObject({ ninfer: { cache_write: false } });
		expect(buildChatBody(target({ cacheReadOnly: true }), request)).not.toHaveProperty("ninfer");
	});

	it("reads the cache without writing it on the owner's ninfer fork, unless overridden (D-093)", () => {
		const readOnly = { ...request, cacheWrite: false as const };
		const fork = (engine: Parameters<typeof resolveEngine>[0]) =>
			resolveEngine({ ...engine, baseUrl: "u", model: "m" }, {}) as EngineTarget;
		const profile = "dylanbrodiefafard/ninfer" as const;
		expect(buildChatBody(fork({ profile }), readOnly)).toMatchObject({ ninfer: { cache_write: false } });
		expect(buildChatBody(fork({ profile, features: { cacheReadOnly: false } }), readOnly)).not.toHaveProperty("ninfer");
		expect(buildChatBody(fork({ profile: "generic" }), readOnly)).not.toHaveProperty("ninfer");
	});

	it("continues the main agent's request: its prompt fields kept, its answer fields replaced", () => {
		const main = {
			model: "m",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "task" },
			],
			tools: [{ type: "function", function: { name: "bash" } }],
			chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
			temperature: 0.6,
			stream: true,
			stream_options: { include_usage: true },
			max_completion_tokens: 32_000,
			response_format: { type: "text" },
		};
		const fork = { ...request, fork: { body: main }, cacheWrite: false as const };
		expect(buildChatBody(target({ cacheReadOnly: true }), fork)).toEqual({
			model: "m",
			messages: [...main.messages, ...request.messages],
			tools: main.tools,
			// Turning thinking off would change the prompt before the fork on this engine.
			chat_template_kwargs: main.chat_template_kwargs,
			temperature: 0.6,
			max_tokens: 64,
			stream: true,
			stream_options: { include_usage: true },
			ninfer: { cache_write: false },
		});
		expect(buildChatBody(target({ thinkingToggle: true }), { ...fork, temperature: 0 })).toMatchObject({
			chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
			temperature: 0,
		});
	});

	it("turns a fork's thinking off in every place the agent's request says it, so they agree (D-100)", () => {
		const fork = (extra: object) => ({ body: { model: "m", messages: [{ role: "user", content: "x" }], ...extra } });
		const off = { ...request, thinking: false };
		const toggles = target({ thinkingToggle: true });
		// pi's "qwen" format: a top-level enable_thinking, with reasoning_effort when the model has effort.
		const qwen = buildChatBody(toggles, { ...off, fork: fork({ enable_thinking: true, reasoning_effort: "medium" }) });
		expect(qwen).toMatchObject({ enable_thinking: false, reasoning_effort: "none" });
		expect(qwen).not.toHaveProperty("chat_template_kwargs");
		const both = buildChatBody(toggles, {
			...off,
			fork: fork({ enable_thinking: true, chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } }),
		});
		expect(both).toMatchObject({
			enable_thinking: false,
			chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
		});
		// Nothing said: the switch goes where ninfer reads it.
		expect(buildChatBody(toggles, { ...off, fork: fork({}) })["chat_template_kwargs"]).toEqual({
			enable_thinking: false,
		});
		// Already what the fork wants: the body is the agent's, untouched.
		const already = fork({ reasoning_effort: "none" });
		expect(buildChatBody(toggles, { ...off, fork: already })).not.toHaveProperty("chat_template_kwargs");
		expect(buildChatBody(toggles, { ...request, thinking: true, fork: already })["reasoning_effort"]).toBe("none");
		// Without F4 the fork keeps the agent's thinking: changing it would change the cached prompt.
		expect(buildChatBody(target(), { ...off, fork: fork({ reasoning_effort: "medium" }) })["reasoning_effort"]).toBe(
			"medium",
		);
	});

	it("asks a fork for JSON in its prompt, not of the engine (D-099)", () => {
		const fork = { body: { model: "m", tools: [{ type: "function" }], messages: [{ role: "user", content: "x" }] } };
		const withSchema = { ...request, fork, jsonSchema: { name: "v", schema: { type: "object" } } };
		expect(buildChatBody(target({ jsonSchema: true, cacheReadOnly: true }), withSchema)).not.toHaveProperty(
			"response_format",
		);
	});

	it("puts one call's result in a fork pi serialized mid-batch, in place of pi's placeholder (D-099)", () => {
		const call = (id: string) => ({ id, type: "function", function: { name: "bash", arguments: "{}" } });
		const before = [
			{ role: "user", content: "fix it" },
			{ role: "assistant", content: null, tool_calls: [call("a"), call("b"), call("c")] },
		];
		// As pi-ai serializes it: every call answered, the unanswered ones with "No result provided".
		const fork = {
			body: {
				model: "m",
				messages: [
					...before,
					{ role: "tool", tool_call_id: "a", content: "No result provided" },
					{ role: "tool", tool_call_id: "b", content: "real output of b" },
					{ role: "tool", tool_call_id: "c", content: [{ type: "text", text: "No result provided" }] },
				],
			},
		};
		expect(withToolResult(fork, "a", "the failing output")?.body["messages"]).toEqual([
			...before,
			{ role: "tool", tool_call_id: "a", content: "the failing output" },
			{ role: "tool", tool_call_id: "b", content: "real output of b" },
			{ role: "tool", tool_call_id: "c", content: "(this tool's result is not available yet)" },
		]);
		// A fork that ends in the calls themselves gets their answers too.
		expect(withToolResult({ body: { messages: before } }, "c", "out")?.body["messages"]).toHaveLength(5);
		expect(withToolResult(fork, "zzz", "out")).toBeUndefined();
		expect(withToolResult({ body: { messages: [{ role: "user", content: "x" }] } }, "a", "out")).toBeUndefined();
		expect(withToolResult({ body: {} }, "a", "out")).toBeUndefined();
	});

	it("sends priority and json_schema when supported", () => {
		const body = buildChatBody(target({ priority: true, jsonSchema: true }), request);
		expect(body["priority"]).toBe(2);
		expect(body["response_format"]).toEqual({
			type: "json_schema",
			json_schema: { name: "v", schema: { type: "object" }, strict: true },
		});
	});
});

describe("createOpenAIClient", () => {
	it("returns text and usage including cached tokens", async () => {
		const t = await serve([{ kind: "text", text: "hello", cachedTokens: 7 }]);
		const response = await createOpenAIClient(t).chat({ messages: [{ role: "user", content: "x" }], maxTokens: 5 });
		expect(response).toEqual({
			text: "hello",
			finishReason: "stop",
			// The fake reports usage in proportion to the request and the reply (about 4 characters a token).
			usage: { promptTokens: 8, completionTokens: 2, cachedTokens: 7 },
			streamed: true,
		});
		expect(server?.requests[0]).toMatchObject({
			model: "m",
			max_tokens: 5,
			stream: true,
			stream_options: { include_usage: true },
		});
	});

	it("maps HTTP errors and aborts to InferenceError kinds", async () => {
		const t = await serve([
			{ kind: "error", status: 429, message: "overloaded" },
			{ kind: "text", text: "slow", delayMs: 2000 },
		]);
		const client = createOpenAIClient(t);
		const request = { messages: [{ role: "user", content: "x" }], maxTokens: 5 };
		await expect(client.chat(request)).rejects.toMatchObject({ kind: "http", status: 429 });

		const controller = new AbortController();
		const pending = client.chat(request, controller.signal);
		setTimeout(() => controller.abort(), 20);
		await expect(pending).rejects.toBeInstanceOf(InferenceError);
		await expect(pending).rejects.toMatchObject({ kind: "aborted" });
	});

	it("streams the reply: reasoning counts as progress, not text (D-098)", async () => {
		const t = await serve([{ kind: "reasoning", reasoning: "let me think", text: "done", cachedTokens: 3 }]);
		const progress: number[] = [];
		const response = await createOpenAIClient(t).chat(
			{ messages: [{ role: "user", content: "x" }], maxTokens: 50 },
			undefined,
			{ onProgress: (chars) => progress.push(chars), liveness: { firstTokenMs: 5_000, stallMs: 5_000 } },
		);
		expect(response.text).toBe("done");
		expect(response.usage?.cachedTokens).toBe(3);
		expect(progress).toEqual(["let me think".length, "let me think".length + 4, "let me think".length + 4]);
	});

	it("gives up on an engine that stops answering, not on one that is slow (D-098)", async () => {
		const t = await serve([
			{ kind: "stall", text: "half of it" },
			{ kind: "text", text: "slow but alive", delayMs: 300 },
			{ kind: "text", text: "never starts", delayMs: 5_000 },
		]);
		const client = createOpenAIClient(t);
		const request = { messages: [{ role: "user", content: "x" }], maxTokens: 5 };
		await expect(
			client.chat(request, undefined, { liveness: { firstTokenMs: 5_000, stallMs: 150 } }),
		).rejects.toMatchObject({
			kind: "stalled",
			message: expect.stringContaining("no token for 150 ms"),
		});
		// Slower than the stall window before its first token, which is the first-token window's to judge.
		expect((await client.chat(request, undefined, { liveness: { firstTokenMs: 2_000, stallMs: 150 } })).text).toBe(
			"slow but alive",
		);
		await expect(
			client.chat(request, undefined, { liveness: { firstTokenMs: 200, stallMs: 150 } }),
		).rejects.toMatchObject({
			kind: "stalled",
			message: expect.stringContaining("no token within"),
		});
	});

	it("reads a whole reply from a server that does not stream, and reports a stream's error event", async () => {
		const json = (body: unknown, type = "application/json") =>
			new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { "content-type": type } });
		const whole = createOpenAIClient(target(), async () =>
			json({ choices: [{ message: { content: "whole" }, finish_reason: "stop" }] }),
		);
		const request = { messages: [{ role: "user", content: "x" }], maxTokens: 5 };
		expect((await whole.chat(request)).text).toBe("whole");

		const failing = createOpenAIClient(target(), async () =>
			json('data: {"error":{"message":"generation_recovery_exhausted"}}\n\n', "text/event-stream"),
		);
		await expect(failing.chat(request)).rejects.toMatchObject({
			kind: "http",
			message: expect.stringContaining("recovery"),
		});
		const empty = createOpenAIClient(target(), async () => json("data: [DONE]\n\n", "text/event-stream"));
		await expect(empty.chat(request)).rejects.toMatchObject({ kind: "bad_response" });
		const garbled = createOpenAIClient(target(), async () => json("data: {not json\n\n", "text/event-stream"));
		await expect(garbled.chat(request)).rejects.toMatchObject({ kind: "bad_response" });
		// A last line with no newline after it is read, not dropped.
		const unterminated = createOpenAIClient(target(), async () =>
			json('data: {"choices":[{"delta":{"content":"tail"},"finish_reason":"stop"}]}', "text/event-stream"),
		);
		expect((await unterminated.chat(request)).text).toBe("tail");
	});

	it("closes the request when the stream goes wrong or says it is done, so the engine stops (D-098)", async () => {
		const opened: { cancelled: boolean }[] = [];
		const streaming = (lines: string[], keepOpen: boolean) => async () => {
			const state = { cancelled: false };
			opened.push(state);
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`));
					if (!keepOpen) controller.close();
				},
				cancel() {
					state.cancelled = true;
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		};
		const chunk = '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}';
		const request = { messages: [{ role: "user", content: "x" }], maxTokens: 5 };
		const liveness = { firstTokenMs: 5_000, stallMs: 200 };
		const bad = createOpenAIClient(target(), streaming([`data: ${chunk}`, "data: not json"], true));
		await expect(bad.chat(request, undefined, { liveness })).rejects.toMatchObject({ kind: "bad_response" });
		// `[DONE]` with the connection left open is the end, not a stall.
		const done = createOpenAIClient(target(), streaming([`data: ${chunk}`, "data: [DONE]"], true));
		expect((await done.chat(request, undefined, { liveness })).text).toBe("ok");
		expect(opened.map((o) => o.cancelled)).toEqual([true, true]);
	});

	it("reports unreachable servers as network errors", async () => {
		const client = createOpenAIClient(target({}, "http://127.0.0.1:1/v1"));
		await expect(client.chat({ messages: [], maxTokens: 1 })).rejects.toMatchObject({ kind: "network" });
	});
});

describe("completeStructured", () => {
	const Verdict = Type.Object({ verdict: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]) });
	const request = { messages: [{ role: "user", content: "judge" }], maxTokens: 50 };

	it("adds a JSON instruction on engines without json_schema and parses fenced output", async () => {
		const t = await serve([{ kind: "text", text: '<think>hmm</think>\n```json\n{"verdict":"complete"}\n```' }]);
		const result = await completeStructured(createOpenAIClient(t), t, request, Verdict, "verdict");
		expect(result.value).toEqual({ verdict: "complete" });
		const sent = server?.requests[0] as { messages: { content: string }[]; response_format?: unknown };
		expect(sent.messages.at(-1)?.content).toMatch(/JSON Schema/);
		expect(sent.response_format).toBeUndefined();
	});

	it("repairs once with the validation error, then succeeds", async () => {
		const t = await serve([
			{ kind: "text", text: '{"verdict":"maybe"}' },
			{ kind: "text", text: '{"verdict":"incomplete"}' },
		]);
		const result = await completeStructured(createOpenAIClient(t), t, request, Verdict, "verdict");
		expect(result.value).toEqual({ verdict: "incomplete" });
		expect(result.responses).toHaveLength(2);
		const repair = server?.requests[1] as { messages: { role: string; content: string }[] };
		expect(repair.messages.at(-1)?.content).toMatch(/not valid: \/verdict/);
	});

	it("gives up after one repair", async () => {
		const t = await serve([
			{ kind: "text", text: "no idea" },
			{ kind: "text", text: "still prose" },
		]);
		await expect(completeStructured(createOpenAIClient(t), t, request, Verdict, "verdict")).rejects.toBeInstanceOf(
			StructuredOutputError,
		);
	});

	it("uses response_format and no instruction on json_schema engines", async () => {
		server = await startFakeOpenAIServer([{ kind: "text", text: '{"verdict":"complete"}' }]);
		const t = { ...target({ jsonSchema: true }), baseUrl: server.baseUrl };
		await completeStructured(createOpenAIClient(t), t, request, Verdict, "verdict");
		const sent = server.requests[0] as { messages: unknown[]; response_format: { type: string } };
		expect(sent.messages).toHaveLength(1);
		expect(sent.response_format.type).toBe("json_schema");
	});

	/** A client that answers from a list, recording what it was asked. */
	function scripted(...replies: (Partial<ChatResponse> | Error)[]) {
		const asked: ChatRequest[] = [];
		const client: InferenceClient = {
			async chat(chatRequest) {
				asked.push(chatRequest);
				const reply = replies[asked.length - 1] ?? new Error("no reply scripted");
				if (reply instanceof Error) throw reply;
				return {
					text: "",
					finishReason: "stop",
					usage: { promptTokens: 10, completionTokens: 5, cachedTokens: null },
					...reply,
				};
			},
		};
		return { client, asked };
	}

	it("does not take a draft from the reasoning for the answer (D2)", async () => {
		// The template opened the thinking block in the prompt, so the reply has only the closing tag.
		const { client, asked } = scripted({
			text: 'Maybe {"verdict":"complete"}? No, the tests fail.\n</think>\n\n{"verdict":"incomplete"}',
		});
		const result = await completeStructured(client, target(), request, Verdict, "verdict");
		expect(result.value).toEqual({ verdict: "incomplete" });
		expect(asked).toHaveLength(1);
	});

	it("takes the candidate that fits the schema, not the first that parses (D2)", async () => {
		const { client, asked } = scripted({
			text: 'The schema is {"type":"object"}, so my answer is {"verdict":"incomplete"} (see [1]).',
		});
		const result = await completeStructured(client, target(), request, Verdict, "verdict");
		expect(result.value).toEqual({ verdict: "incomplete" });
		expect(asked).toHaveLength(1);
	});

	it("reports each response as it arrives, so a failed repair turn still shows the first one's usage (D9)", async () => {
		const { client } = scripted({ text: "prose" }, new InferenceError("aborted", "request aborted"));
		const seen: ChatResponse[] = [];
		await expect(
			completeStructured(client, target(), request, Verdict, "verdict", undefined, (r) => seen.push(r)),
		).rejects.toBeInstanceOf(InferenceError);
		expect(seen.map((r) => r.usage?.promptTokens)).toEqual([10]);
	});

	it("makes no repair turn for a reply cut off at max_tokens (D9)", async () => {
		const { client, asked } = scripted({ text: '<think>Let me look at {"verdict":"compl', finishReason: "length" });
		const error = await completeStructured(client, target(), request, Verdict, "verdict").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(StructuredOutputError);
		expect(error).toMatchObject({ reason: "truncated", responses: [{ finishReason: "length" }] });
		expect(String(error)).toMatch(/cut off at max_tokens \(50\)/);
		expect(asked).toHaveLength(1);

		// A reply that hit the limit but holds a whole, valid answer is still an answer.
		const whole = scripted({ text: '{"verdict":"complete"}', finishReason: "length" });
		expect((await completeStructured(whole.client, target(), request, Verdict, "verdict")).value).toEqual({
			verdict: "complete",
		});
	});
});

describe("extractJson", () => {
	it.each([
		['{"a":1}', { a: 1 }],
		['Sure! {"a":1} done', { a: 1 }],
		["```\n[1,2]\n```", [1, 2]],
		["<think>{nope}</think> [3]", [3]],
		['```json\n"yes"\n```', "yes"],
		["  42 ", 42],
		// Reasoning, closed with or without its opening tag, is not the answer (D2).
		['draft {"a":0}\n</think>\n{"a":1}', { a: 1 }],
		['<think>one {"a":0}</think> text <think>two {"a":2}</think>{"a":1}', { a: 1 }],
		// The last value a reply states is the one it settled on.
		['First {"a":0}. On reflection: {"a":1}', { a: 1 }],
		// Braces and brackets inside strings do not end a value.
		['Answer: {"a":"} ] <think> {","b":[1,"]"]} trailing }', { a: "} ] <think> {", b: [1, "]"] }],
		['{"a":"say \\"hi\\" }"}!', { a: 'say "hi" }' }],
		// A JSON value inside something that is not JSON.
		['{note: the answer is {"a":1}}', { a: 1 }],
		['{ [ {"a":1}', { a: 1 }],
	])("%s", (text, expected) => {
		expect(extractJson(text)).toEqual({ ok: true, value: expected });
	});

	it("fails on prose", () => {
		expect(extractJson("nothing here")).toEqual({ ok: false, error: "no parseable JSON found" });
		expect(extractJson("")).toEqual({ ok: false, error: "no parseable JSON found" });
		expect(extractJson("{ unbalanced [ } ]").ok).toBe(false);
	});

	it("treats an unclosed thinking block as no answer (D2)", () => {
		for (const text of ['<think>Let me draft: {"a":0}', '<think>{"a":0}', 'Hm. <think> so {"a":0} and then']) {
			expect(extractJson(text)).toEqual({
				ok: false,
				error: "the reply ended inside its reasoning, before any answer",
			});
		}
		// What came before the block is still an answer.
		expect(extractJson('{"a":1}\n<think>did I get that right? {"a":0}')).toEqual({ ok: true, value: { a: 1 } });
	});

	it("prefers the candidate the caller accepts, and otherwise returns the last one (D2)", () => {
		const text = 'Like {"a":1} or {"b":2} or {"c":3}.';
		const has = (key: string) => (value: unknown) => typeof value === "object" && value !== null && key in value;
		expect(extractJson(text, has("a"))).toEqual({ ok: true, value: { a: 1 } });
		expect(extractJson(text, has("b"))).toEqual({ ok: true, value: { b: 2 } });
		expect(extractJson(text, has("z"))).toEqual({ ok: true, value: { c: 3 } });
		// A reply that is one JSON value is the answer as a whole: no part of it is taken instead.
		expect(extractJson('{"z":{"a":1}}', has("a"))).toEqual({ ok: true, value: { z: { a: 1 } } });
	});

	it("stays fast on a reply full of unbalanced or deeply nested brackets", () => {
		const started = performance.now();
		expect(extractJson("{[".repeat(50_000)).ok).toBe(false);
		expect(extractJson(`${"{".repeat(20_000)}${"}".repeat(20_000)}`).ok).toBe(false);
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});
