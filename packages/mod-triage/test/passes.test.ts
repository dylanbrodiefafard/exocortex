import { describe, expect, it } from "vitest";
import { isNarrowed, namesAll, ranNoTests } from "../src/passes.ts";

describe("isNarrowed (D-108 amendment)", () => {
	it("tells a run of some tests from a run of all of them", () => {
		for (const narrow of [
			"pytest tests/test_a.py::test_x",
			"pytest -k total",
			"python -m pytest tests/test_a.py",
			"python -m unittest tests.test_calc",
			"cargo test parse",
			"cargo test -p forth",
			"cargo nextest run parse",
			"go test -run TestX ./...",
			"go test ./pkg/parser",
			"npx vitest run src/a.test.ts",
			"npm test -- src/a.test.ts",
			"ctest -R order",
		])
			expect([narrow, isNarrowed(narrow)]).toEqual([narrow, true]);
		for (const whole of [
			"pytest",
			"pytest -q tests/",
			"python -m pytest -x",
			"python -m unittest discover",
			"cargo test",
			"cargo test -- --nocapture",
			"go test ./...",
			"npm test",
			"make test",
			"./run_tests.sh",
		])
			expect([whole, isNarrowed(whole)]).toEqual([whole, false]);
	});
});

describe("ranNoTests", () => {
	it("is a pass whose output says no test ran", () => {
		expect(ranNoTests("running 0 tests\ntest result: ok. 0 passed; 0 failed; 5 filtered out")).toBe(true);
		expect(ranNoTests("ok  \tpkg\t0.01s [no tests to run]")).toBe(true);
		expect(ranNoTests("Ran 0 tests in 0.000s\n\nOK")).toBe(true);
		expect(ranNoTests("collected 0 items\n\n== no tests ran in 0.01s ==")).toBe(true);
		// A whole cargo run prints `running 0 tests` for its doc-tests too.
		expect(ranNoTests("running 5 tests\ntest result: ok. 5 passed\nrunning 0 tests\ntest result: ok. 0 passed")).toBe(
			false,
		);
		expect(ranNoTests("ok  \tpkg\t0.21s")).toBe(false);
		expect(ranNoTests("")).toBe(false);
	});
});

describe("namesAll", () => {
	it("needs every failing test named, by its id or its last part", () => {
		expect(namesAll(["tests/a.py::test_total"], "pytest tests/a.py::test_total")).toBe(true);
		expect(namesAll(["tests/a.py::test_total", "tests/a.py::test_days"], "test_total PASSED")).toBe(false);
		expect(namesAll(["parse::ipv6"], "cargo test ipv6\ntest parse::ipv6 ... ok")).toBe(true);
		expect(namesAll([], "anything")).toBe(false);
	});
});
