import { describe, expect, it } from "vitest";
import { countPassedTests } from "../src/test-count.ts";

describe("countPassedTests", () => {
	it("sums cargo's per-binary results", () => {
		const output = [
			"     Running unittests src/lib.rs (target/debug/deps/chroma-42c6)",
			"test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
			"     Running tests/conversions.rs (target/debug/deps/conversions-5ac3)",
			"test result: ok. 25 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s",
			"   Doc-tests chroma",
			"test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
		].join("\n");
		expect(countPassedTests(output)).toBe(40);
		// `autotests = false` leaves only the unit tests: fewer than the solution's run.
		expect(countPassedTests(output.split("\n").slice(0, 2).join("\n"))).toBe(15);
	});

	it("reads unittest's count, less the skipped ones", () => {
		expect(countPassedTests("....\n-----\nRan 4 tests in 0.003s\n\nOK\n")).toBe(4);
		expect(countPassedTests("Ran 1 test in 0.001s\n\nOK\n")).toBe(1);
		expect(countPassedTests("Ran 12 tests in 0.2s\n\nOK (skipped=5)\n")).toBe(7);
		expect(countPassedTests("Ran 0 tests in 0.000s\n\nOK\n")).toBe(0);
	});

	it("reads pytest's summary", () => {
		expect(countPassedTests("===== 31 passed, 2 skipped in 0.41s =====\n")).toBe(31);
		expect(countPassedTests("============ 3 passed in 0.02s ============\n")).toBe(3);
	});

	it("counts Go's PASS lines with -v, and passing packages without", () => {
		const verbose =
			"=== RUN   TestA\n--- PASS: TestA (0.00s)\n    --- PASS: TestA/sub (0.00s)\n--- SKIP: TestB\nPASS\nok  \texample.com/x\t0.01s\n";
		expect(countPassedTests(verbose)).toBe(2);
		const quiet =
			"ok  \texample.com/x\t0.012s\nok  \texample.com/x/y\t(cached)\n?   \texample.com/x/z\t[no test files]\n";
		expect(countPassedTests(quiet)).toBe(2);
	});

	it("reads CTest, TAP and a plain count", () => {
		expect(countPassedTests("100% tests passed, 0 tests failed out of 12\n")).toBe(12);
		expect(countPassedTests("83% tests passed, 2 tests failed out of 12\n")).toBe(10);
		expect(
			countPassedTests("ok 1 - a\n    ok 2 - nested assertion\nok 2 - b # SKIP no network\nnot ok 3 - c\nok 4 - d\n"),
		).toBe(2);
		expect(countPassedTests("51 tests, 0 failures\n")).toBe(51);
	});

	it("is null when the output has no summary it knows", () => {
		expect(countPassedTests("all tests passed\n")).toBeNull();
		expect(countPassedTests("")).toBeNull();
	});
});
