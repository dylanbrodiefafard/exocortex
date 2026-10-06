import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../src/records.ts";
import { summarize } from "../src/report.ts";
import { scoreWorkspace, validateTasks, validationPasses } from "../src/run.ts";
import { loadTasks, recordMinTests, type Task } from "../src/task.ts";
import { applyCheckGuard, prepareWorkspace } from "../src/workspace.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
let tmp: string | undefined;

afterEach(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = undefined;
});

function fixture(id: string, spec: Record<string, unknown>, withRepo = true): void {
	if (!tmp) tmp = mkdtempSync(join(tmpdir(), "exo-tasks-"));
	const dir = join(tmp, id);
	mkdirSync(withRepo ? join(dir, "repo") : dir, { recursive: true });
	writeFileSync(join(dir, "task.json"), JSON.stringify(spec));
}

describe("loadTasks", () => {
	it("loads every shipped fixture with defaults applied", () => {
		const tasks = loadTasks(join(REPO, "tasks"));
		expect(tasks.length).toBeGreaterThanOrEqual(5);
		for (const task of tasks) {
			expect(task.solutionPatch, task.spec.id).toBeDefined();
			expect(task.spec.tags).toBeInstanceOf(Array);
		}
		expect(new Set(tasks.map((t) => t.spec.language))).toEqual(new Set(["python", "go", "rust", "cpp"]));
	});

	it("filters by id globs", () => {
		const ids = loadTasks(join(REPO, "tasks"), ["py-*", "go-lru"]).map((t) => t.spec.id);
		expect(ids).toContain("go-lru");
		expect(ids.every((id) => id.startsWith("py-") || id === "go-lru")).toBe(true);
	});

	it("rejects invalid specs and missing repos", () => {
		fixture("bad", { id: "Bad Id", language: "python", prompt: "x", check: "true" });
		expect(() => loadTasks(tmp ?? "")).toThrow(/invalid task spec/);
		rmSync(join(tmp ?? "", "bad"), { recursive: true });
		fixture("norepo", { id: "norepo", language: "python", prompt: "x", check: "true" }, false);
		expect(() => loadTasks(tmp ?? "")).toThrow(/missing repo/);
	});

	it("skips directories that have no task.json yet (being authored)", () => {
		fixture("ok", { id: "ok", language: "python", prompt: "x", check: "true" });
		mkdirSync(join(tmp ?? "", "draft", "repo"), { recursive: true });
		expect(loadTasks(tmp ?? "").map((t) => t.spec.id)).toEqual(["ok"]);
	});
});

describe("summarize", () => {
	const base = {
		taskId: "t",
		repeat: 1,
		checkExitCode: 0,
		checkTimedOut: false,
		agentMs: 1,
		acceptedSuggestions: 0,
		metrics: null,
	} as const;
	it("computes success rate, median wall clock and abnormal count per config", () => {
		const records: RunRecord[] = [
			{ ...base, label: "a", config: "off", outcome: "settled", success: true, wallClockMs: 10_000 },
			{ ...base, label: "b", config: "off", outcome: "timeout", success: false, wallClockMs: 30_000 },
			{ ...base, label: "c", config: "off", outcome: "settled", success: true, wallClockMs: 20_000 },
			{ ...base, label: "d", config: "on", outcome: "settled", success: false, wallClockMs: 5_000 },
		];
		const [off, on] = summarize(records);
		expect(off).toMatchObject({ config: "off", runs: 3, successes: 2, medianWallClockSec: 20, abnormal: 1 });
		expect(off?.successRate).toBeCloseTo(2 / 3);
		expect(on).toMatchObject({ config: "on", runs: 1, successes: 0, meanTurns: null });
	});

	it("keeps invalid runs out of the rates, and orders configs as the run was given them", () => {
		const records: RunRecord[] = [
			{ ...base, label: "a", config: "on", outcome: "settled", success: true, wallClockMs: 10_000 },
			{ ...base, label: "b", config: "off", outcome: "settled", success: true, wallClockMs: 10_000 },
			{ ...base, label: "c", config: "off", outcome: "crashed", success: false, wallClockMs: 900_000 },
			{ ...base, label: "d", config: "off", outcome: "setup_failed", success: false, wallClockMs: 1 },
			{ ...base, label: "e", config: "off", outcome: "harness_error", success: false, wallClockMs: 1 },
		];
		// The shuffled run happened to start with `on`; `off` is still the baseline.
		expect(summarize(records).map((s) => s.config)).toEqual(["on", "off"]);
		const [off, on] = summarize(records, ["off", "on", "never-ran"]);
		expect(off).toMatchObject({
			config: "off",
			runs: 1,
			invalid: 3,
			successes: 1,
			successRate: 1,
			medianWallClockSec: 10,
		});
		expect(on).toMatchObject({ config: "on", runs: 1, invalid: 0 });
	});
});

describe("tags and hidden overlays", () => {
	it("filters by tag", () => {
		const smoke = loadTasks(join(REPO, "tasks"), [], ["smoke"]);
		expect(smoke.length).toBeGreaterThanOrEqual(6);
		expect(smoke.every((t) => t.spec.tags.includes("smoke"))).toBe(true);
		expect(loadTasks(join(REPO, "tasks"), [], ["no-such-tag"])).toEqual([]);
	});

	it("scores hidden acceptance tests the agent never saw", async () => {
		fixture("hid", { id: "hid", language: "other", prompt: "x", check: "test -f visible.txt && bash hidden_check.sh" });
		const dir = join(tmp ?? "", "hid");
		writeFileSync(join(dir, "repo", "visible.txt"), "v");
		writeFileSync(join(dir, "repo", "hidden_check.sh"), "exit 0\n");
		mkdirSync(join(dir, "hidden"));
		writeFileSync(join(dir, "hidden", "hidden_check.sh"), "grep -q fixed visible.txt\n");
		writeFileSync(
			join(dir, "solution.patch"),
			"diff --git a/visible.txt b/visible.txt\n--- a/visible.txt\n+++ b/visible.txt\n@@ -1 +1 @@\n-v\n\\ No newline at end of file\n+fixed\n",
		);
		const [task] = loadTasks(tmp ?? "");
		expect(task?.hiddenDir).toBe(join(dir, "hidden"));
		const [result] = await validateTasks(task ? [task] : [], join(tmp ?? "", "scratch"));
		// Without the overlay the pristine repo would pass (hidden_check.sh exits 0).
		expect(result).toMatchObject({ pristineFails: true, solutionPasses: true });
	});

	it("restores tampered fixture tests before the check, and flags solutions that edit them", async () => {
		fixture("tamper", { id: "tamper", language: "python", prompt: "x", check: "python3 tests/test_x.py" });
		const dir = join(tmp ?? "", "tamper");
		mkdirSync(join(dir, "repo", "tests"));
		writeFileSync(join(dir, "repo", "tests", "test_x.py"), "import sys; sys.exit(1)\n");
		writeFileSync(join(dir, "repo", "tests", "test_y.py"), "pass\n");
		writeFileSync(join(dir, "repo", "lib.py"), "x = 1\n");
		const [task] = loadTasks(tmp ?? "");
		if (!task) throw new Error("no task");
		expect(task.spec.protectTests).toBe(true);
		const work = mkdtempSync(join(tmpdir(), "exo-work-"));
		await prepareWorkspace(task, work);
		writeFileSync(join(work, "tests", "test_x.py"), "pass\n");
		rmSync(join(work, "tests", "test_y.py"));
		writeFileSync(join(work, "lib.py"), "x = 2\n");
		const guard = applyCheckGuard(task, work, `${work}.aside`);
		expect(guard.tamperedTests.sort()).toEqual(["tests/test_x.py", "tests/test_y.py"]);
		expect(readFileSync(join(work, "tests", "test_x.py"), "utf8")).toBe("import sys; sys.exit(1)\n");
		expect(readFileSync(join(work, "lib.py"), "utf8")).toBe("x = 2\n");
		expect(applyCheckGuard(task, work, `${work}.aside`)).toEqual({
			tamperedTests: [],
			tamperedFiles: [],
			setAsideTests: [],
		});
		rmSync(work, { recursive: true, force: true });

		writeFileSync(
			join(dir, "solution.patch"),
			"diff --git a/tests/test_x.py b/tests/test_x.py\n--- a/tests/test_x.py\n+++ b/tests/test_x.py\n@@ -1 +1 @@\n-import sys; sys.exit(1)\n+pass\n",
		);
		const [reloaded] = loadTasks(tmp ?? "");
		const [result] = await validateTasks(reloaded ? [reloaded] : [], join(tmp ?? "", "scratch"));
		expect(result?.solutionPasses).toBe(false);
		expect(result?.detail).toContain("solution.patch edits protected tests (tests/test_x.py)");
		expect(result && validationPasses(result)).toBe(false);
	});
});

describe("check guard (D-079)", () => {
	const work = () => mkdtempSync(join(tmpdir(), "exo-work-"));
	const write = (root: string, path: string, text: string) => {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	/** A make-driven fixture whose only test fails until `value.txt` says 2. */
	function makeTask(spec: Record<string, unknown> = {}, files: Record<string, string> = {}): Task {
		fixture("guard", { id: "guard", language: "other", prompt: "x", check: "make -s test", ...spec });
		const repo = join(tmp ?? "", "guard", "repo");
		write(repo, "Makefile", "test:\n\t@sh tests/run.sh\n");
		write(repo, "tests/run.sh", 'test "$(cat value.txt)" = 2 && echo "ok 1 - value"\n');
		write(repo, "value.txt", "1\n");
		for (const [path, text] of Object.entries(files)) write(repo, path, text);
		const [task] = loadTasks(tmp ?? "");
		if (!task) throw new Error("no task");
		return task;
	}
	const SOLUTION = "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-1\n+2\n";

	it("fails a run that rewrote the Makefile's test target instead of fixing the code", async () => {
		const task = makeTask();
		const dir = work();
		await prepareWorkspace(task, dir);
		// What D-048's guard let through: the tests are untouched, the target no longer runs them.
		writeFileSync(join(dir, "Makefile"), "test:\n\t@true\n");
		const score = await scoreWorkspace(task, dir, `${dir}.aside`);
		expect(score).toMatchObject({ success: false, guard: { tamperedFiles: ["Makefile"], tamperedTests: [] } });
		expect(readFileSync(join(dir, "Makefile"), "utf8")).toContain("tests/run.sh");
		rmSync(dir, { recursive: true, force: true });
	});

	it("restores a protected file that was deleted or replaced by a directory", async () => {
		const task = makeTask({}, { "sub/Cargo.toml": "[package]\n" });
		const dir = work();
		await prepareWorkspace(task, dir);
		rmSync(join(dir, "Makefile"));
		mkdirSync(join(dir, "Makefile"));
		rmSync(join(dir, "sub", "Cargo.toml"));
		// A test file swapped for a directory used to throw EISDIR and end the suite.
		rmSync(join(dir, "tests", "run.sh"));
		mkdirSync(join(dir, "tests", "run.sh"));
		const guard = applyCheckGuard(task, dir, `${dir}.aside`);
		expect(guard.tamperedFiles.sort()).toEqual(["Makefile", "sub/Cargo.toml"]);
		expect(guard.tamperedTests).toEqual(["tests/run.sh"]);
		expect(readFileSync(join(dir, "sub", "Cargo.toml"), "utf8")).toBe("[package]\n");
		expect(readFileSync(join(dir, "tests", "run.sh"), "utf8")).toContain("value.txt");
		rmSync(dir, { recursive: true, force: true });
	});

	it("sets aside tests and runner config the agent added, but not Rust modules or build output", async () => {
		const task = makeTask();
		const dir = work();
		await prepareWorkspace(task, dir);
		write(dir, "tests/test_extra.py", "assert False\n");
		write(dir, "pkg/main_test.go", "package pkg\nfunc TestMain(m *testing.M) { os.Exit(0) }\n");
		write(dir, "conftest.py", "collect_ignore = ['tests']\n");
		write(dir, "nested/go.mod", "module nested\n");
		write(dir, "GNUmakefile", "test:\n\t@true\n");
		write(dir, "src/tests.rs", "// declared with `mod tests;`: removing it breaks the crate\n");
		write(dir, "src/parser/tests/mod.rs", "// in-crate too\n");
		write(dir, "crate/tests/extra.rs", "// an integration test\n");
		write(dir, "build/tests/run.o", "object");
		write(dir, "target/debug/x_test.go", "stale");
		write(dir, "notes.md", "kept");
		const aside = `${dir}.aside`;
		const guard = applyCheckGuard(task, dir, aside);
		expect(guard.setAsideTests.sort()).toEqual(["crate/tests/extra.rs", "pkg/main_test.go", "tests/test_extra.py"]);
		expect(guard.tamperedFiles.sort()).toEqual(["GNUmakefile", "conftest.py", "nested/go.mod"]);
		for (const path of [...guard.setAsideTests, ...guard.tamperedFiles]) {
			expect(existsSync(join(dir, path)), path).toBe(false);
			expect(existsSync(join(aside, path)), path).toBe(true);
		}
		for (const path of ["src/tests.rs", "src/parser/tests/mod.rs", "build/tests/run.o", "notes.md"]) {
			expect(existsSync(join(dir, path)), path).toBe(true);
		}
		// A second pass finds nothing left to do, and overwrites nothing in the aside directory.
		expect(applyCheckGuard(task, dir, aside).setAsideTests).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
		rmSync(aside, { recursive: true, force: true });
	});

	it("leaves alone what the reference solution itself changes or adds, so the solution always passes", async () => {
		makeTask();
		const dir = join(tmp ?? "", "guard");
		// This solution legitimately edits the Makefile and adds a test-looking file.
		writeFileSync(
			join(dir, "solution.patch"),
			`${SOLUTION}diff --git a/Makefile b/Makefile\n--- a/Makefile\n+++ b/Makefile\n@@ -1,2 +1,2 @@\n test:\n-\t@sh tests/run.sh\n+\t@sh tests/run.sh && sh spec/extra.sh\ndiff --git a/spec/extra.sh b/spec/extra.sh\nnew file mode 100644\n--- /dev/null\n+++ b/spec/extra.sh\n@@ -0,0 +1 @@\n+echo "ok 2 - extra"\n`,
		);
		const [task] = loadTasks(tmp ?? "");
		expect([...(task?.solutionPaths ?? [])].sort()).toEqual(["Makefile", "spec/extra.sh", "value.txt"]);
		const [result] = await validateTasks(task ? [task] : [], join(tmp ?? "", "scratch"));
		expect(result).toMatchObject({ pristineFails: true, solutionPasses: true, solutionTests: 2 });
		expect(result?.detail).toBe("no minTests (the solution runs 2: --record-tests writes it);");
		expect(result && validationPasses(result)).toBe(true);
	});

	it("can be turned off per task: `protect: []` for build files, `protectTests: false` for tests", async () => {
		const task = makeTask({ protect: [], protectTests: false });
		const dir = work();
		await prepareWorkspace(task, dir);
		writeFileSync(join(dir, "Makefile"), "test:\n\t@true\n");
		writeFileSync(join(dir, "tests", "run.sh"), "true\n");
		write(dir, "tests/test_new.py", "pass\n");
		expect(applyCheckGuard(task, dir, `${dir}.aside`)).toEqual({
			tamperedTests: [],
			tamperedFiles: [],
			setAsideTests: [],
		});
		rmSync(dir, { recursive: true, force: true });
	});

	it("protects a file named by its path only there", async () => {
		const task = makeTask({ protect: ["ci/run.cfg"] }, { "ci/run.cfg": "a\n", "other/run.cfg": "a\n" });
		const dir = work();
		await prepareWorkspace(task, dir);
		writeFileSync(join(dir, "ci", "run.cfg"), "b\n");
		writeFileSync(join(dir, "other", "run.cfg"), "b\n");
		writeFileSync(join(dir, "Makefile"), "test:\n\t@true\n");
		expect(applyCheckGuard(task, dir, `${dir}.aside`).tamperedFiles).toEqual(["ci/run.cfg"]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("fails a check that exits 0 after running fewer tests than the solution does", async () => {
		const task = makeTask({ minTests: 2, protectTests: false });
		const dir = work();
		await prepareWorkspace(task, dir);
		writeFileSync(join(dir, "value.txt"), "2\n");
		// One test runs and passes; the task says the solution runs two.
		const few = await scoreWorkspace(task, dir, `${dir}.aside`);
		expect(few).toMatchObject({ success: false, checkExitCode: 0, checkTests: 1, tooFewTests: true });
		writeFileSync(join(dir, "tests", "run.sh"), 'echo "ok 1 - a"; echo "ok 2 - b"\n');
		const enough = await scoreWorkspace(task, dir, `${dir}.aside`);
		expect(enough).toMatchObject({ success: true, checkTests: 2, tooFewTests: false });
		// A check whose output has no count at all cannot meet a floor either.
		writeFileSync(join(dir, "tests", "run.sh"), "true\n");
		expect(await scoreWorkspace(task, dir, `${dir}.aside`)).toMatchObject({ success: false, checkTests: null });
		rmSync(dir, { recursive: true, force: true });
	});

	it("validation records the solution's test count, then holds the solution and the fixture to it", async () => {
		makeTask();
		const dir = join(tmp ?? "", "guard");
		writeFileSync(join(dir, "solution.patch"), SOLUTION);
		const load = () => loadTasks(tmp ?? "").slice(0, 1);
		const scratch = join(tmp ?? "", "scratch");
		const [recorded] = await validateTasks(load(), scratch, recordMinTests);
		expect(recorded).toMatchObject({ solutionPasses: true, solutionTests: 1, detail: "recorded minTests 1;" });
		expect(load()[0]?.spec.minTests).toBe(1);
		// The rest of task.json is untouched.
		expect(JSON.parse(readFileSync(join(dir, "task.json"), "utf8"))).toEqual({
			id: "guard",
			language: "other",
			prompt: "x",
			check: "make -s test",
			minTests: 1,
		});
		const [again] = await validateTasks(load(), scratch, recordMinTests);
		expect(again).toMatchObject({ solutionPasses: true, detail: "" });

		// A floor the solution does not reach is a fixture bug.
		recordMinTests(load()[0] as Task, 5);
		const [short] = await validateTasks(load(), scratch);
		expect(short?.solutionPasses).toBe(false);
		expect(short?.detail).toBe("solution runs 1 tests, fewer than minTests 5;");
		expect(short && validationPasses(short)).toBe(false);
	});

	it("says which way a fixture is broken when its check passes untouched", async () => {
		makeTask({ minTests: 3 }, { "value.txt": "2\n" });
		const [result] = await validateTasks(loadTasks(tmp ?? ""), join(tmp ?? "", "scratch"));
		expect(result).toMatchObject({ pristineFails: false, solutionPasses: null, solutionTests: null });
		expect(result?.detail).toBe("check passes without any change and only the test count fails it;");
	});

	it("runs a check that timed out once more, and fails a check that hangs twice", { timeout: 20_000 }, async () => {
		const slowOnce = makeTask({ check: "test -f seen || { touch seen; sleep 5; }", checkTimeoutSec: 1 });
		const dir = work();
		await prepareWorkspace(slowOnce, dir);
		expect(await scoreWorkspace(slowOnce, dir, `${dir}.aside`)).toMatchObject({ success: true, checkTimedOut: false });
		const hangs = { ...slowOnce, spec: { ...slowOnce.spec, check: "sleep 5" } };
		expect(await scoreWorkspace(hangs, dir, `${dir}.aside`)).toMatchObject({
			success: false,
			checkTimedOut: true,
			checkExitCode: null,
		});
		rmSync(dir, { recursive: true, force: true });
	});
});
