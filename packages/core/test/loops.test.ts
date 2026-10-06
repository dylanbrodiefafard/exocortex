import { describe, expect, it } from "vitest";
import {
	callKey,
	failureKey,
	failureLines,
	loopHistoryLength,
	MAX_LOOP_PERIOD,
	trailingLoop,
} from "../src/modules/loops.ts";

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

describe("failureKey", () => {
	const key = (output: string, command = "cargo test") => failureKey({ toolName: "bash", input: { command }, output });

	it("is the same when only line numbers, run times, addresses and thread ids differ", () => {
		const a =
			"error[E0502]: cannot borrow `x`\n  --> src/lib.rs:42:9\nthread 'main' (4242) panicked at src/lib.rs:9:5:\n--- FAIL: TestSteps (0.01s)";
		const b =
			"error[E0502]: cannot borrow `x`\n  --> src/lib.rs:57:3\nthread 'main' (97) panicked at src/lib.rs:14:5:\n--- FAIL: TestSteps (1.20s)";
		expect(key(a)).toBe(key(b));
		expect(key('  File "calc.py", line 2, in add\nTraceback (most recent call last):')).toBe(
			key('  File "calc.py", line 31, in add\nTraceback (most recent call last):'),
		);
		// Whatever was run to get it.
		expect(key(a, "cargo test")).toBe(key(a, "cargo test --offline 2>&1"));
	});

	it("changes when a failing test is fixed, a name or value differs, or one of two alike errors goes", () => {
		const three = "test a ... FAILED\ntest b ... FAILED\nerror: test failed, to rerun pass `--lib`";
		const two = "test a ... FAILED\nerror: test failed, to rerun pass `--lib`";
		expect(key(three)).not.toBe(key(two));
		expect(key("AssertionError: 1 != 2")).not.toBe(key("AssertionError: 3 != 2"));
		expect(key("error[E0425]: cannot find value `a`")).not.toBe(key("error[E0425]: cannot find value `b`"));
		const once = "error: mismatched types";
		expect(key(`${once}\n${once}`)).not.toBe(key(once));
	});

	it("does not depend on the order tests finished in", () => {
		expect(key("test a ... FAILED\ntest b ... FAILED")).toBe(key("test b ... FAILED\ntest a ... FAILED"));
	});

	it("reads the end of an output with no error line, and the call when nothing was printed", () => {
		expect(failureLines("nothing useful\n\nstill nothing")).toEqual(["nothing useful", "still nothing"]);
		expect(key("", "./one.sh")).not.toBe(key("", "./two.sh"));
		expect(key("", "./one.sh")).toBe(key("\n", "./one.sh"));
	});

	it("prefers toolchain errors to lines that only mention one", () => {
		expect(failureLines("warning: 2 errors were ignored\nsrc/a.c:3:1: error: expected ';'")).toEqual([
			"src/a.c:<n>: error: expected ';'",
		]);
	});
});
