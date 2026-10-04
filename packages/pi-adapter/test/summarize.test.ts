import { describe, expect, it } from "vitest";
import { resolveDebugLevel } from "../src/index.ts";
import { summarizePiEvent } from "../src/summarize.ts";

describe("summarizePiEvent", () => {
	it("keeps scalars, drops type, reduces arrays to lengths", () => {
		expect(
			summarizePiEvent({ type: "turn_end", turnIndex: 2, toolResults: [1, 2, 3], context: { deep: true } }),
		).toEqual({ turnIndex: 2, "toolResults.length": 3 });
	});

	it("summarizes messages by role and usage", () => {
		expect(
			summarizePiEvent({
				type: "message_end",
				message: { role: "assistant", stopReason: "toolUse", usage: { input: 900, cacheRead: 800, output: 12 } },
			}),
		).toEqual({
			role: "assistant",
			customType: undefined,
			toolName: undefined,
			stopReason: "toolUse",
			"usage.input": 900,
			"usage.cacheRead": 800,
			"usage.output": 12,
		});
	});

	it("summarizes provider payloads without dumping them", () => {
		expect(
			summarizePiEvent({
				type: "before_provider_request",
				payload: { model: "qwen", messages: [{}, {}], tools: [{}], stream: true },
			}),
		).toEqual({ "payload.model": "qwen", "payload.messages": 2, "payload.tools": 1, "payload.stream": true });
	});

	it("handles non-objects", () => {
		expect(summarizePiEvent(undefined)).toEqual({});
		expect(summarizePiEvent("x")).toEqual({});
	});
});

describe("resolveDebugLevel", () => {
	it.each([
		[undefined, undefined, "off"],
		[undefined, false, "off"],
		[undefined, true, "events"],
		["1", undefined, "events"],
		["true", false, "events"],
		["VERBOSE", undefined, "verbose"],
		["0", true, "events"],
		["nonsense", undefined, "off"],
	] as const)("env=%s flag=%s -> %s", (env, flag, expected) => {
		expect(resolveDebugLevel(env, flag)).toBe(expected);
	});
});
