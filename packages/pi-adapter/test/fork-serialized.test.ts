import { complete } from "@earendil-works/pi-ai/compat";
import { type JsonValue, withToolResult } from "@exocortex/core";
import { describe, expect, it } from "vitest";

/**
 * A fork is the main agent's context as pi serializes it (`fork.ts`, `serializeWithPi`). Taken
 * while the agent's tool calls run, pi-ai answers each with "No result provided"
 * (`pi-ai/dist/api/transform-messages.js:197-198`): this runs the real serializer, so a fork of
 * the shape triage gets is what `withToolResult` is tested on (D-099).
 */
async function serialize(messages: unknown[]): Promise<{ readonly [key: string]: JsonValue }> {
	const model = {
		id: "qwen",
		name: "qwen",
		api: "openai-completions",
		provider: "local",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1_000,
	};
	let captured: unknown;
	const stop = new AbortController();
	await complete(
		model as never,
		{ messages } as never,
		{
			apiKey: "x",
			signal: stop.signal,
			onPayload: (payload: unknown) => {
				captured = payload;
				stop.abort();
				throw new Error("captured");
			},
		} as never,
	).catch(() => undefined);
	return captured as { readonly [key: string]: JsonValue };
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("a fork pi serialized mid-batch (D-099)", () => {
	it("gets the failing call's result in place of pi's placeholder, the other call marked not ready", async () => {
		const body = await serialize([
			{ role: "user", content: "make the tests pass", timestamp: 1 },
			{
				role: "assistant",
				api: "openai-completions",
				provider: "local",
				model: "qwen",
				stopReason: "toolUse",
				timestamp: 2,
				usage,
				content: [
					{ type: "toolCall", id: "call_A", name: "bash", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "call_B", name: "read", arguments: { path: "x" } },
				],
			},
		]);
		const messages = body["messages"] as { role: string; tool_call_id?: string; content?: unknown }[];
		// What pi does: the calls are answered "No result provided" (the reason this exists).
		expect(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["call_A", "call_B"]);

		const fork = withToolResult({ body }, "call_A", "1 failing: expected 2, got 3");
		expect(fork).toBeDefined();
		const tools = ((fork?.body["messages"] ?? []) as typeof messages).filter((m) => m.role === "tool");
		expect(tools).toEqual([
			{ role: "tool", tool_call_id: "call_A", content: "1 failing: expected 2, got 3" },
			{ role: "tool", tool_call_id: "call_B", content: "(this tool's result is not available yet)" },
		]);
	});
});
