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
			stream: false,
			chat_template_kwargs: { enable_thinking: false },
		});
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
		});
		expect(server?.requests[0]).toMatchObject({ model: "m", max_tokens: 5, stream: false });
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
