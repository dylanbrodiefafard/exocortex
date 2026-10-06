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

describe("callKey (D-077)", () => {
	const key = (output: string) => callKey("bash", { command: "make" }, output);

	it("reads a.c:12:34 as a place in a file, not a clock time", () => {
		expect(key("a.c:12:34: warning: unused")).not.toBe(key("a.c:13:35: warning: unused"));
		expect(key("src/lib.rs:9:5")).not.toBe(key("src/lib.rs:9:6"));
		expect(key("started 12:34:56 done")).toBe(key("started 12:35:01 done"));
	});

	it("keeps what a program printed in quotes", () => {
		expect(key("assert '10:30' == '10:45'")).not.toBe(key("assert '10:44' == '10:45'"));
		expect(key('got "2026-10-05", want "2026-10-06"')).not.toBe(key('got "2026-10-04", want "2026-10-06"'));
	});

	it("is the same across temporary directories, generated ids and ports", () => {
		expect(key("wrote '/tmp/pytest-of-u/pytest-12/test_a0/out.json' on 127.0.0.1:43211")).toBe(
			key("wrote '/tmp/pytest-of-u/pytest-13/test_a0/out.json' on 127.0.0.1:51876"),
		);
		expect(key("job 6f1c2a9e-3b4d-4c5e-8f70-123456789abc on localhost:8123")).toBe(
			key("job 0a0b0c0d-1111-4222-8333-444455556666 on localhost:9456"),
		);
		expect(key("cache /var/folders/ab/xyz123/T/tmp1/x and /home/u/tmp/keep")).toBe(
			key("cache /var/folders/ab/xyz123/T/tmp2/y and /home/u/tmp/keep"),
		);
		expect(key("see /home/u/tmp/a")).not.toBe(key("see /home/u/tmp/b"));
	});
});

describe("failureKey: what stays and what goes (D-077)", () => {
	const key = (output: string) => failureKey({ toolName: "bash", input: { command: "make test" }, output });

	it.each([
		// A value in the message is the failure; erasing it made a different wrong answer the same failure.
		["AssertionError: '10:30' != '10:45'", "AssertionError: '10:44' != '10:45'"],
		[
			"    cal_test.go:9: Easter(1981) = 1981-04-26, want 1981-04-19\n--- FAIL: TestEaster (0.00s)",
			"    cal_test.go:9: Easter(1981) = 1981-04-12, want 1981-04-19\n--- FAIL: TestEaster (0.00s)",
		],
		["E   AssertionError: expected 5 ms, got 6 ms", "E   AssertionError: expected 5 ms, got 7 ms"],
		["E   assert 10:30 == 10:45", "E   assert 10:44 == 10:45"],
		// The same rustc error in another file is another error.
		["error[E0308]: mismatched types\n  --> src/a.rs:3:5", "error[E0308]: mismatched types\n  --> src/b.rs:3:5"],
		["src/a.ts(12,5): error TS2322: Type 'x'", "src/b.ts(12,5): error TS2322: Type 'x'"],
	])("differs: %s / %s", (a, b) => {
		expect(key(a)).not.toBe(key(b));
	});

	it.each([
		// What moves between two runs of the same failure.
		["src/a.ts(12,5): error TS2322: Type 'x'", "src/a.ts(40,9): error TS2322: Type 'x'"],
		[
			"FileNotFoundError: [Errno 2] No such file or directory: '/tmp/pytest-of-u/pytest-12/test_a0/in.txt'",
			"FileNotFoundError: [Errno 2] No such file or directory: '/tmp/pytest-of-u/pytest-13/test_a0/in.txt'",
		],
		[
			"E   ConnectionRefusedError: 127.0.0.1:43211 (request 6f1c2a9e-3b4d-4c5e-8f70-123456789abc)",
			"E   ConnectionRefusedError: 127.0.0.1:51876 (request 0a0b0c0d-1111-4222-8333-444455556666)",
		],
		[
			"panic: dial tcp [::1]:5432: connect: connection refused",
			"panic: dial tcp [::1]:6543: connect: connection refused",
		],
		[
			"error[E0308]: mismatched types\n  --> src/a.rs:3:5\n   |\n3  | x",
			"error[E0308]: mismatched types\n  --> src/a.rs:90:1\n   |\n90 | x",
		],
		["2026-10-05 10:00:01,123 ERROR worker failed", "2026-10-06 11:30:10,456 ERROR worker failed"],
		["[12:00:01] FAIL\tpkg", "[12:07:44] FAIL\tpkg"],
		["FAIL\texample.com/rl\t0.004s", "FAIL\texample.com/rl\t1.204s"],
		["[  FAILED  ] RingTest.Wraps (0 ms)", "[  FAILED  ] RingTest.Wraps (12 ms)"],
		["1/2 Test #1: ring .....***Failed    0.01 sec", "1/2 Test #1: ring .....***Failed    0.31 sec"],
		["====== 1 failed, 2 passed in 0.52s ======", "====== 1 failed, 2 passed in 1.07s ======"],
		[
			"test result: FAILED. 2 passed; 1 failed; finished in 0.00s",
			"test result: FAILED. 2 passed; 1 failed; finished in 0.31s",
		],
	])("same: %s / %s", (a, b) => {
		expect(key(a)).toBe(key(b));
	});

	it("names the file under a rustc error, not its line, and stops at the next error", () => {
		expect(failureLines("error[E0308]: mismatched types\n  --> src/a.rs:3:5\nerror: aborting")).toEqual([
			"error: aborting",
			"error[E0308]: mismatched types --> src/a.rs",
		]);
		expect(failureLines("error: linking failed\nerror[E0308]: mismatched\n --> src/a.rs:1:1")).toEqual([
			"error: linking failed",
			"error[E0308]: mismatched --> src/a.rs",
		]);
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
