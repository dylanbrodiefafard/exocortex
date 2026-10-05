import { describe, expect, it } from "vitest";
import { callKey, loopHistoryLength, MAX_LOOP_PERIOD, trailingLoop } from "../src/modules/loops.ts";

describe("callKey", () => {
	it("is the same for the same call and result, whatever the key order, timings or colours", () => {
		const a = callKey("bash", { command: "cargo test", timeout: 5 }, "\u001b[32mok\u001b[0m in 0.52s at 12:01:07\n");
		const b = callKey("bash", { timeout: 5, command: "cargo test" }, "ok in 1.3 s at 12:04:55");
		expect(a).toBe(b);
		expect(callKey("bash", {}, "built 2026-10-05T10:00:00Z at 0x7ffe12")).toBe(
			callKey("bash", {}, "built 2026-10-06T11:30:10Z at 0x55d0aa"),
		);
	});

	it("differs when the tool, the input or what the result says differs", () => {
		const key = callKey("bash", { command: "cargo test" }, "3 failed");
		expect(callKey("bash", { command: "cargo test" }, "2 failed")).not.toBe(key);
		expect(callKey("bash", { command: "cargo test -q" }, "3 failed")).not.toBe(key);
		expect(callKey("read", { command: "cargo test" }, "3 failed")).not.toBe(key);
		expect(callKey("read", { path: "a" }, "x")).not.toBe(callKey("read", { path: ["a"] }, "x"));
		expect(callKey("read", undefined, "x")).toBe(callKey("read", null, "x"));
	});
});

describe("trailingLoop", () => {
	const keys = (text: string) => text.split("");

	it("finds one call repeated, and the shortest cycle the history ends in", () => {
		expect(trailingLoop(keys("xAAA"), 3)).toEqual({ period: 1, repeats: 3 });
		expect(trailingLoop(keys("xABABAB"), 3)).toEqual({ period: 2, repeats: 3 });
		// One call later the same loop is still seen, a step out of phase.
		expect(trailingLoop(keys("xABABABA"), 3)).toEqual({ period: 2, repeats: 3 });
		expect(trailingLoop(keys("ABCDABCDABCD"), 3)).toEqual({ period: 4, repeats: 3 });
		expect(trailingLoop(keys("AAAAAA"), 3)).toEqual({ period: 1, repeats: 6 });
	});

	it("finds nothing when the repeats are too few, interrupted, or the cycle too long", () => {
		expect(trailingLoop([], 3)).toBeUndefined();
		expect(trailingLoop(keys("AA"), 3)).toBeUndefined();
		expect(trailingLoop(keys("AAxA"), 3)).toBeUndefined();
		expect(trailingLoop(keys("ABABxB"), 3)).toBeUndefined();
		expect(trailingLoop(keys("AAAB"), 3)).toBeUndefined();
		const long = "ABCDEF";
		expect(long.length).toBeGreaterThan(MAX_LOOP_PERIOD);
		expect(trailingLoop(keys(long.repeat(3)), 3)).toBeUndefined();
	});

	it("needs no more history than loopHistoryLength keeps", () => {
		const cycle = "ABCDE".slice(0, MAX_LOOP_PERIOD);
		const history = keys(`xyz${cycle.repeat(6)}`).slice(-loopHistoryLength(6));
		expect(trailingLoop(history, 3)).toEqual({ period: MAX_LOOP_PERIOD, repeats: 6 });
	});
});
