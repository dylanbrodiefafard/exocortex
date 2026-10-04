import { type FakeOpenAIServer, type ScriptedReply, startFakeOpenAIServer } from "@exocortex/testkit";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { buildChatBody, createOpenAIClient, InferenceError } from "../src/inference/client.ts";
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
			usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 7 },
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
});

describe("extractJson", () => {
	it.each([
		['{"a":1}', { a: 1 }],
		['Sure! {"a":1} done', { a: 1 }],
		["```\n[1,2]\n```", [1, 2]],
		["<think>{nope}</think> [3]", [3]],
	])("%s", (text, expected) => {
		expect(extractJson(text)).toEqual({ ok: true, value: expected });
	});

	it("fails on prose", () => {
		expect(extractJson("nothing here").ok).toBe(false);
	});
});
