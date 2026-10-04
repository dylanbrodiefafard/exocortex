import type { ToolOutcome } from "@exocortex/core";
import { describe, expect, it } from "vitest";
import {
	extractClaims,
	isTestPath,
	madeNoChanges,
	narrowTestSignal,
	parseDiff,
	stubSignals,
	tamperSignals,
	unsupportedClaims,
} from "../src/signals.ts";

const DIFF = `diff --git a/tests/test_parse.py b/tests/test_parse.py
index 1..2 100644
--- a/tests/test_parse.py
+++ b/tests/test_parse.py
@@ -1,6 +1,6 @@
+@pytest.mark.skip(reason="flaky")
 def test_parse():
-    assert parse("1") == 1
-    assert parse("2") == 2
+    assert parse("1") == 1
diff --git a/src/limiter_test.go b/src/limiter_test.go
deleted file mode 100644
--- a/src/limiter_test.go
+++ /dev/null
@@ -1,3 +0,0 @@
-func TestBurst(t *testing.T) {
-	t.Fatal("x")
-}
diff --git a/src/lib.rs b/src/lib.rs
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,2 +1,3 @@
+fn eval() { todo!() }
+// TODO: handle nested words
 fn main() {}
`;

const bash = (command: string, exitCode = 0): ToolOutcome => ({
	toolName: "bash",
	input: { command },
	isError: exitCode !== 0,
	exitCode,
	output: "",
});
const edit: ToolOutcome = {
	toolName: "edit",
	input: { path: "src/lib.rs" },
	isError: false,
	exitCode: null,
	output: "",
};

describe("parseDiff", () => {
	it("splits files with added, removed and deleted state", () => {
		const files = parseDiff(DIFF);
		expect(files.map((f) => [f.path, f.deleted, f.added.length, f.removed.length])).toEqual([
			["tests/test_parse.py", false, 2, 2],
			["src/limiter_test.go", true, 0, 3],
			["src/lib.rs", false, 2, 0],
		]);
		expect(parseDiff("")).toEqual([]);
	});
});

describe("isTestPath", () => {
	it.each([
		["tests/test_x.py", true],
		["pkg/x_test.go", true],
		["src/a.test.ts", true],
		["tests/integration.rs", true],
		["test_page.py", true],
		["src/lib.rs", false],
		["src/testing_utils.go", false],
		["README.md", false],
	])("%s → %s", (path, expected) => {
		expect(isTestPath(path)).toBe(expected);
	});
});

describe("tamperSignals and stubSignals", () => {
	it("flags skipped, weakened and deleted tests, and stubs outside tests", () => {
		const files = parseDiff(DIFF);
		expect(tamperSignals(files)).toEqual([
			"1 skip/ignore marker(s) added in tests/test_parse.py",
			"1 assertion(s) removed from tests/test_parse.py",
			"test file deleted: src/limiter_test.go",
		]);
		expect(stubSignals(files)).toEqual(["2 stub marker(s) added in src/lib.rs: fn eval() { todo!() }"]);
	});

	it("says nothing about ordinary changes", () => {
		const files = parseDiff("diff --git a/tests/t.py b/tests/t.py\n+    assert f(3) == 9\n-    assert f(3) == 8\n");
		expect(tamperSignals(files)).toEqual([]);
		expect(stubSignals(files)).toEqual([]);
	});
});

describe("claims", () => {
	const message = "I fixed the parser. All tests pass now!\nThe build compiles cleanly. ```\ntests pass\n```";
	it("extracts one claim per kind, outside code fences", () => {
		expect(extractClaims(message)).toEqual([
			{ kind: "tests_pass", sentence: "All tests pass now!" },
			{ kind: "builds", sentence: "The build compiles cleanly." },
		]);
		expect(extractClaims("I have implemented everything.")).toEqual([
			{ kind: "done", sentence: "I have implemented everything." },
		]);
	});

	it("flags claims with no successful matching command after the last edit", () => {
		const claims = extractClaims(message);
		expect(unsupportedClaims(claims, [bash("pytest -q"), edit]).map((c) => c.kind)).toEqual(["tests_pass", "builds"]);
		expect(unsupportedClaims(claims, [edit, bash("pytest -q", 1)]).map((c) => c.kind)).toEqual([
			"tests_pass",
			"builds",
		]);
		expect(unsupportedClaims(claims, [edit, bash("cargo test")])).toEqual([]);
		expect(unsupportedClaims(claims, [edit, bash("cargo build")]).map((c) => c.kind)).toEqual(["tests_pass"]);
		expect(unsupportedClaims(extractClaims("All done."), [])).toEqual([]);
	});
});

describe("narrowTestSignal", () => {
	it("flags a last test run restricted to a subset", () => {
		expect(narrowTestSignal([bash("pytest -k parse")])).toContain("pytest -k parse");
		expect(narrowTestSignal([bash("go test ./... -run TestBurst")])).toContain("-run TestBurst");
		expect(narrowTestSignal([bash("cargo test parse_words")])).toContain("cargo test parse_words");
		expect(narrowTestSignal([bash("pytest tests/test_a.py::test_x")])).toBeDefined();
	});
	it("accepts full runs and no runs", () => {
		expect(narrowTestSignal([bash("pytest -k parse"), bash("pytest -q")])).toBeUndefined();
		expect(narrowTestSignal([bash("cargo test")])).toBeUndefined();
		expect(narrowTestSignal([bash("ls")])).toBeUndefined();
	});
});

describe("madeNoChanges", () => {
	it("is true only with an empty diff, nothing untracked, no writes, inside a repo", () => {
		expect(madeNoChanges("", [], [bash("ls")])).toBe(true);
		expect(madeNoChanges("", ["new.py"], [])).toBe(false);
		expect(madeNoChanges("", [], [edit])).toBe(false);
		expect(madeNoChanges("diff", [], [])).toBe(false);
		expect(madeNoChanges(undefined, [], [])).toBe(false);
	});
});
