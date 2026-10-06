import { isTestPath, type ToolOutcome } from "@exocortex/core";
import { describe, expect, it } from "vitest";
import {
	extractClaims,
	madeNoChanges,
	narrowTestSignal,
	parseDiff,
	runnerConfigSignals,
	stubSignals,
	tamperSignals,
	testRunNotes,
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
		["test_ring_buffer.cpp", true],
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
		const files = parseDiff("diff --git a/tests/t.py b/tests/t.py\n+    assert f(4) == 16\n+x = todo_list()\n");
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

describe("testRunNotes", () => {
	const bash = (command: string): ToolOutcome => ({
		toolName: "bash",
		input: { command },
		isError: false,
		exitCode: 0,
		output: "",
	});
	const edit: ToolOutcome = { toolName: "edit", input: { path: "a.rs" }, isError: false, exitCode: null, output: "" };

	it("is silent when the last full test run came after the last edit, with its own exit code", () => {
		expect(testRunNotes([edit, bash("cargo test --offline -q"), bash("git status")])).toEqual([]);
		expect(testRunNotes([edit, bash("set -o pipefail && go test ./... | tail -20")])).toEqual([]);
		expect(testRunNotes([edit, bash("grep -rn pytest .")])).toEqual([]);
	});

	it("notes edits made after the last full test run", () => {
		const notes = testRunNotes([bash("cd core && make -s test"), edit, edit]);
		expect(notes).toEqual([
			"files changed after the agent's last full test run (`cd core && make -s test`), so that result does not cover the finished work",
		]);
		// When the workspace was compared, that decides: a shell edit counts, a reverted edit does not.
		expect(testRunNotes([bash("go test ./..."), bash("sed -i s/a/b/ a.go")], true)).toHaveLength(1);
		expect(testRunNotes([bash("go test ./..."), edit], false)).toEqual([]);
		// A later run of one test does not stand in for the full run.
		expect(testRunNotes([bash("go test ./..."), edit, bash("go test -run TestParse ./...")])).toHaveLength(1);
	});

	it("notes a run whose exit code was a pipe's, and falls back to the build when no tests ran", () => {
		expect(testRunNotes([edit, bash("python3 -m unittest discover -q -s tests -t . 2>&1 | tail -5")])[0]).toContain(
			"is another command's (a pipe, `;` or `||`), not the test run's, and its output does not say how it ended",
		);
		expect(testRunNotes([bash("cargo build"), edit])[0]).toContain("last full build (`cargo build`)");
	});
});

describe("one reading of 'is this a test run' (D-084, S6 and S7)", () => {
	const piped = (command: string, output: string): ToolOutcome => ({ ...bash(command), output });
	const claims = extractClaims("All tests pass now.");

	it("does not take a command that only mentions the tests for a test run", () => {
		expect(unsupportedClaims(claims, [edit, bash("git commit -m 'make pytest pass'")])).toHaveLength(1);
		expect(unsupportedClaims(claims, [edit, bash("echo cargo test")])).toHaveLength(1);
		expect(narrowTestSignal([bash("grep -rn 'pytest -k parse' docs")])).toBeUndefined();
		expect(unsupportedClaims(claims, [edit, bash("cd core && uv run pytest -q")])).toEqual([]);
	});

	it("does not take a piped run whose output shows a failure for a passing one", () => {
		const failed = piped(
			"pytest -q 2>&1 | tail -3",
			"FAILED tests/test_a.py::test_x - assert 1 == 2\n1 failed in 0.1s",
		);
		expect(unsupportedClaims(claims, [edit, failed])).toHaveLength(1);
		const passed = piped("pytest -q 2>&1 | tail -3", "===== 12 passed in 0.31s =====");
		expect(unsupportedClaims(claims, [edit, passed])).toEqual([]);
	});

	it.each([
		"pytest tests/test_one.py",
		"python3 -m pytest -q tests/test_one.py",
		"python -m unittest tests.test_one",
		"npx vitest run src/parser.test.ts",
		"npm test -- src/parser.test.ts",
		"ctest -R parser",
		"go test ./pkg/parser",
		"cargo test -p core",
		"cargo test -- parse_words",
		"pytest -k parse",
		"go test ./... -run TestBurst",
		"cargo test parse_words",
		"pytest tests/test_a.py::test_x",
		"./build/tests --gtest_filter=Ring.*",
	])("a run of some of the tests is not the full run: %s", (command) => {
		expect(narrowTestSignal([bash(command)])).toContain(command);
		// It does not stand in for the full run made before the edit.
		expect(testRunNotes([bash("make test"), edit, bash(command)])).toHaveLength(1);
	});

	it.each([
		"pytest -q -x",
		"pytest tests/",
		"python3 -m pytest",
		"python3 -m unittest discover -q -s tests -t .",
		"go test ./...",
		"go test",
		"cargo test --offline -q",
		"npm test",
		"npx vitest run",
		"ctest --output-on-failure",
		"./run_tests.sh",
		"make -j 8 check",
	])("a run of all the tests is the full run: %s", (command) => {
		expect(narrowTestSignal([bash(command)])).toBeUndefined();
		expect(testRunNotes([bash("make test"), edit, bash(command)])).toEqual([]);
	});

	it("counts the user's own check commands as full test runs", () => {
		const tests = ["./verify-all", "pytest -k smoke"];
		expect(testRunNotes([bash("./verify-all"), edit])).toEqual([]);
		expect(testRunNotes([bash("./verify-all"), edit], undefined, { tests })[0]).toContain(
			"last full test run (`./verify-all`)",
		);
		// The user's definition of "the tests", whatever it selects.
		expect(narrowTestSignal([bash("pytest -k smoke")], { tests })).toBeUndefined();
		expect(unsupportedClaims(claims, [edit, bash("./verify-all")], { tests })).toEqual([]);
		expect(unsupportedClaims(claims, [edit, bash("./verify-all")])).toHaveLength(1);
	});
});

describe("warning signals that fire for the right lines (D-084, S9)", () => {
	const diffOf = (path: string, lines: readonly string[], header = "index 1..2 100644") =>
		parseDiff(
			`diff --git a/${path} b/${path}\n${header}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`,
		);

	it("takes TODO for a stub only in a comment, in capitals", () => {
		const code = diffOf("src/todos.py", [
			"+todos.append(todo)",
			"+const todo = fetchTodo();",
			"+    # nothing to do here",
			"+xxx = 3",
			"+TODO_LIMIT = 3",
		]);
		expect(stubSignals(code)).toEqual([]);
		const stubs = diffOf("src/lib.rs", ["+// TODO: handle nested words", "+    # FIXME later", "+/* XXX hack */"]);
		expect(stubSignals(stubs)).toEqual(["3 stub marker(s) added in src/lib.rs: // TODO: handle nested words"]);
	});

	it("does not take a commented-out placeholder for a stub", () => {
		expect(stubSignals(diffOf("src/lib.rs", ["+// unimplemented!()", "+    # raise NotImplementedError"]))).toEqual([]);
		expect(stubSignals(diffOf("src/lib.py", ["+    raise NotImplementedError"]))).toHaveLength(1);
	});

	it("reports an assertion whose expected value changed in an existing test", () => {
		const changed = diffOf("tests/test_calc.py", [
			"-    assert total(3) == 8",
			"+    assert total(3) == 9",
			" def other():",
		]);
		expect(tamperSignals(changed)).toEqual([
			"1 assertion(s) changed in tests/test_calc.py: `assert total(3) == 8` became `assert total(3) == 9`",
		]);
		// Moved or re-indented, not changed.
		const moved = diffOf("tests/test_calc.py", ["-    assert total(3) == 8", "+        assert total(3) == 8"]);
		expect(tamperSignals(moved)).toEqual([]);
		// A new test file has nothing to change.
		const created = diffOf("tests/test_new.py", ["+    assert total(3) == 9"], "new file mode 100644");
		expect(tamperSignals(created)).toEqual([]);
	});

	it("counts an assertion that was commented out as removed, and ignores a commented-out skip", () => {
		const commented = diffOf("tests/test_calc.py", ["-    assert total(3) == 8", "+    # assert total(3) == 8"]);
		expect(tamperSignals(commented)).toEqual(["1 assertion(s) removed from tests/test_calc.py"]);
		const skip = diffOf("tests/test_calc.py", ['+# @pytest.mark.skip(reason="x")', "+// it.skip('later', () => {})"]);
		expect(tamperSignals(skip)).toEqual([]);
	});

	it("reports a change to how the tests are run", () => {
		const signals = (path: string, lines: readonly string[], header?: string) =>
			runnerConfigSignals(diffOf(path, lines, header));
		expect(signals("package.json", ['-    "test": "vitest run",', '+    "test": "echo ok",'])).toEqual([
			'test runner configuration changed in package.json: "test": "echo ok",',
		]);
		expect(signals("pytest.ini", ["+addopts = --deselect tests/test_hard.py"])).toHaveLength(1);
		expect(signals("sub/conftest.py", ["+collect_ignore = ['test_hard.py']"])).toHaveLength(1);
		expect(signals("Makefile", ["-test:", "-\tpytest", "+test:", "+\ttrue"])).toHaveLength(1);
		expect(signals("pyproject.toml", ['+addopts = "-k smoke"'])).toHaveLength(1);
		expect(signals("Cargo.toml", ["+test = false"])).toHaveLength(1);
		// Not about the tests, or new with the work.
		expect(signals("package.json", ['+    "lodash": "4.17.21",'])).toEqual([]);
		expect(signals("pyproject.toml", ['+version = "1.2.0"'])).toEqual([]);
		expect(signals("Makefile", ["+build:", "+\tcc main.c"])).toEqual([]);
		expect(signals("vitest.config.ts", ["+export default {}"], "new file mode 100644")).toEqual([]);
		expect(signals("src/app.py", ["+addopts = 1"])).toEqual([]);
	});

	it("reads a diff header that git quoted", () => {
		const files = parseDiff(
			'diff --git "a/we\\"ird\\tname.py" "b/we\\"ird\\tname.py"\n+x = 1\ndiff --git a/my file.py b/my file.py\n+y = 2\n',
		);
		expect(files.map((f) => f.path)).toEqual(['we"ird\tname.py', "my file.py"]);
	});
});
