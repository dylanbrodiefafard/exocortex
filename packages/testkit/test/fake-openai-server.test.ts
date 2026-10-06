import { afterEach, describe, expect, it } from "vitest";
import { type FakeOpenAIServer, startFakeOpenAIServer } from "../src/index.ts";

let server: FakeOpenAIServer | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

async function post(body: object): Promise<Response> {
	if (!server) throw new Error("server not started");
	return fetch(`${server.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

interface Chunk {
	readonly choices?: {
		readonly finish_reason: string | null;
		readonly delta: { content?: string; reasoning_content?: string; tool_calls?: { id: string }[] };
	}[];
}

/** Posts a streaming request and parses its server-sent events. */
async function events(body: object) {
	const raw = (await (await post(body)).text())
		.split("\n\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice("data: ".length));
	const chunks = raw.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e) as Chunk);
	const choices = chunks.flatMap((c) => c.choices ?? []);
	return {
		done: raw.at(-1) === "[DONE]",
		chunks,
		text: choices.map((c) => c.delta.content ?? "").join(""),
		finishReasons: choices.flatMap((c) => (c.finish_reason ? [c.finish_reason] : [])),
	};
}

describe("fake OpenAI server", () => {
	it("replies to non-streaming requests in script order, then falls back", async () => {
		server = await startFakeOpenAIServer([
			{ kind: "tool_calls", calls: [{ name: "bash", arguments: { command: "ls" } }] },
			{ kind: "text", text: "done" },
		]);

		const first = (await (await post({ messages: [] })).json()) as {
			choices: { message: { tool_calls: { function: { name: string; arguments: string } }[] } }[];
		};
		expect(first.choices[0]?.message.tool_calls[0]?.function).toEqual({
			name: "bash",
			arguments: '{"command":"ls"}',
		});

		const second = (await (await post({ messages: [] })).json()) as {
			choices: { message: { content: string } }[];
		};
		expect(second.choices[0]?.message.content).toBe("done");

		const third = (await (await post({ messages: [] })).json()) as {
			choices: { message: { content: string } }[];
		};
		expect(third.choices[0]?.message.content).toBe("(script exhausted)");
		expect(server.requests).toHaveLength(3);
	});

	it("streams SSE chunks ending with [DONE], and with usage only when the request asks for it", async () => {
		server = await startFakeOpenAIServer([
			{ kind: "text", text: "hello" },
			{ kind: "text", text: "hello" },
		]);
		const asked = await events({ stream: true, stream_options: { include_usage: true }, messages: [] });
		expect(asked.done).toBe(true);
		expect(asked.text).toBe("hello");
		expect(asked.chunks.at(-1)).toHaveProperty("usage.completion_tokens", 2);
		expect(asked.chunks.at(-1)).toHaveProperty("choices", []);

		// A real engine sends no usage chunk unless asked: a client that forgets to ask sees none.
		const notAsked = await events({ stream: true, messages: [] });
		expect(notAsked.done).toBe(true);
		expect(notAsked.chunks.some((chunk) => "usage" in chunk)).toBe(false);
		expect(notAsked.finishReasons).toEqual(["stop"]);
	});

	it("reports usage that grows with the request and the reply", async () => {
		server = await startFakeOpenAIServer([], { fallback: { kind: "text", text: "x".repeat(40), cachedTokens: 7 } });
		const usage = async (body: object) =>
			((await (await post(body)).json()) as { usage: Record<string, unknown> & { prompt_tokens: number } }).usage;
		const small = await usage({ messages: [{ role: "user", content: "hi" }] });
		const large = await usage({ messages: [{ role: "user", content: "hi ".repeat(400) }] });
		const withTools = await usage({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "bash" }] });
		expect(large.prompt_tokens).toBeGreaterThan(small.prompt_tokens + 250);
		expect(withTools.prompt_tokens).toBeGreaterThan(small.prompt_tokens);
		expect(small).toMatchObject({
			completion_tokens: 10,
			total_tokens: small.prompt_tokens + 10,
			prompt_tokens_details: { cached_tokens: 7 },
		});
	});

	it("gives every tool call its own id, across calls and requests", async () => {
		const calls = [
			{ name: "bash", arguments: { command: "ls" } },
			{ name: "read", arguments: { path: "a" } },
		];
		server = await startFakeOpenAIServer([], { fallback: { kind: "tool_calls", calls } });
		const ids: string[] = [];
		for (const stream of [false, true, false]) {
			if (stream) {
				const streamed = await events({ stream, messages: [] });
				ids.push(
					...streamed.chunks
						.flatMap((c) => c.choices?.flatMap((ch) => ch.delta.tool_calls ?? []) ?? [])
						.map((t) => t.id),
				);
				expect(streamed.finishReasons).toEqual(["tool_calls"]);
			} else {
				const body = (await (await post({ messages: [] })).json()) as {
					choices: { message: { tool_calls: { id: string }[] } }[];
				};
				ids.push(...(body.choices[0]?.message.tool_calls.map((t) => t.id) ?? []));
			}
		}
		// Before D-079 every request's first call was `call_0`: a harness keyed by id mixed them up.
		expect(ids).toHaveLength(6);
		expect(new Set(ids).size).toBe(6);
	});

	it("can cut a reply at the output limit", async () => {
		server = await startFakeOpenAIServer([], { fallback: { kind: "length", text: '{"verdict": "comp' } });
		const body = (await (await post({ messages: [] })).json()) as {
			choices: { finish_reason: string; message: { content: string } }[];
		};
		expect(body.choices[0]).toMatchObject({ finish_reason: "length", message: { content: '{"verdict": "comp' } });
		expect((await events({ stream: true, messages: [] })).finishReasons).toEqual(["length"]);
	});

	it("can send reasoning apart from the answer", async () => {
		server = await startFakeOpenAIServer([], {
			fallback: { kind: "reasoning", reasoning: '{"draft": 1} let me think', text: '{"final": 2}' },
		});
		const body = (await (await post({ messages: [] })).json()) as {
			choices: { message: { content: string; reasoning_content: string } }[];
			usage: { completion_tokens: number; completion_tokens_details: { reasoning_tokens: number } };
		};
		expect(body.choices[0]?.message).toMatchObject({
			content: '{"final": 2}',
			reasoning_content: '{"draft": 1} let me think',
		});
		expect(body.usage.completion_tokens_details.reasoning_tokens).toBe(7);
		expect(body.usage.completion_tokens).toBe(10);
		const streamed = await events({ stream: true, messages: [] });
		expect(streamed.text).toBe('{"final": 2}');
		expect(
			streamed.chunks.flatMap((c) => c.choices?.map((ch) => ch.delta.reasoning_content ?? "") ?? []).join(""),
		).toBe('{"draft": 1} let me think');
	});

	it("can refuse a request as too long for the context window, the way OpenAI-style servers word it", async () => {
		server = await startFakeOpenAIServer([{ kind: "overflow" }]);
		const response = await post({ messages: [{ role: "user", content: "x".repeat(4_000) }] });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { message: string; code: string } };
		expect(body.error.code).toBe("context_length_exceeded");
		expect(body.error.message).toMatch(
			/maximum context length is 32768 tokens\. However, your messages resulted in \d+ tokens/,
		);
	});

	it("can drop the connection part-way through a reply", async () => {
		server = await startFakeOpenAIServer([], { fallback: { kind: "drop_midstream", text: "half of this arrives" } });
		// Streaming: the first chunks arrive, then the body errors; there is no [DONE].
		const response = await post({ stream: true, messages: [] });
		let received = "";
		await expect(
			(async () => {
				for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
					received += new TextDecoder().decode(chunk);
				}
			})(),
		).rejects.toThrow();
		expect(received).toContain("half of th");
		expect(received).not.toContain("[DONE]");
		expect(received).not.toContain('finish_reason":"stop');
		// Non-streaming: no response at all.
		await expect(post({ messages: [] })).rejects.toThrow();
		expect(server.inFlight).toBe(0);
	});

	it("strict mode refuses message sequences a chat template would not accept", async () => {
		server = await startFakeOpenAIServer([], { strict: true });
		const call = { id: "call_9", type: "function", function: { name: "bash", arguments: "{}" } };
		const status = async (messages: unknown) => (await post({ messages })).status;
		const user = { role: "user", content: "hi" };
		const assistant = { role: "assistant", content: "hello" };
		const calling = { role: "assistant", content: null, tool_calls: [call] };
		const answer = { role: "tool", tool_call_id: "call_9", content: "ok" };

		expect(await status([{ role: "system", content: "s" }, user])).toBe(200);
		expect(await status([user, assistant, user])).toBe(200);
		expect(await status([user, calling, answer])).toBe(200);
		expect(await status([user, calling, answer, user])).toBe(200);
		expect(server.rejected).toEqual([]);

		expect(await status([])).toBe(400);
		expect(await status("nope")).toBe(400);
		expect(await status([user, { role: "system", content: "late" }, user])).toBe(400);
		expect(await status([user, answer])).toBe(400);
		expect(await status([user, calling, user])).toBe(400);
		expect(await status([user, calling])).toBe(400);
		expect(await status([user, assistant])).toBe(400);
		expect(await status([user, { role: "narrator", content: "x" }])).toBe(400);
		expect(server.rejected).toEqual([
			"messages must be a non-empty array",
			"messages must be a non-empty array",
			"messages[1]: system message after the conversation started",
			"messages[1]: tool message answers no pending tool call (call_9)",
			"messages[2]: user message while tool calls are unanswered (call_9)",
			"tool calls left unanswered (call_9)",
			"the conversation ends with a assistant message",
			'messages[1]: unknown role "narrator"',
		]);
		// A refused request does not use up a scripted reply.
		expect(server.requests).toHaveLength(12);
	});

	it("is not strict unless asked", async () => {
		server = await startFakeOpenAIServer([]);
		expect((await post({ messages: [] })).status).toBe(200);
		expect(server.rejected).toEqual([]);
	});

	it("records request bodies and serves /models", async () => {
		server = await startFakeOpenAIServer([], { model: "m1" });
		await post({ model: "m1", messages: [{ role: "user", content: "hi" }] });
		expect(server.requests).toEqual([{ model: "m1", messages: [{ role: "user", content: "hi" }] }]);

		const models = (await (await fetch(`${server.baseUrl}/models`)).json()) as { data: { id: string }[] };
		expect(models.data.map((m) => m.id)).toEqual(["m1"]);
	});
});
