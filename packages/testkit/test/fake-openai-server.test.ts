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

	it("streams SSE chunks ending with usage and [DONE]", async () => {
		server = await startFakeOpenAIServer([{ kind: "text", text: "hello" }]);
		const text = await (await post({ stream: true, messages: [] })).text();
		const events = text
			.split("\n\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.slice("data: ".length));

		expect(events.at(-1)).toBe("[DONE]");
		const parsed = events.slice(0, -1).map((e) => JSON.parse(e) as { choices: { delta: { content?: string } }[] });
		expect(parsed.flatMap((c) => c.choices.map((ch) => ch.delta.content ?? "")).join("")).toBe("hello");
		expect(parsed.at(-1)).toHaveProperty("usage.total_tokens", 15);
	});

	it("records request bodies and serves /models", async () => {
		server = await startFakeOpenAIServer([], { model: "m1" });
		await post({ model: "m1", messages: [{ role: "user", content: "hi" }] });
		expect(server.requests).toEqual([{ model: "m1", messages: [{ role: "user", content: "hi" }] }]);

		const models = (await (await fetch(`${server.baseUrl}/models`)).json()) as { data: { id: string }[] };
		expect(models.data.map((m) => m.id)).toEqual(["m1"]);
	});
});
