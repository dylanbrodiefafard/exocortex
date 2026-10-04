import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summarize } from "../src/report.ts";
import type { RunRecord } from "../src/run.ts";
import { validateTasks } from "../src/run.ts";
import { loadTasks } from "../src/task.ts";
import { prepareWorkspace, restoreProtectedTests } from "../src/workspace.ts";

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
		writeFileSync(join(work, "tests", "test_new.py"), "pass\n");
		writeFileSync(join(work, "lib.py"), "x = 2\n");
		expect(restoreProtectedTests(task, work).sort()).toEqual(["tests/test_x.py", "tests/test_y.py"]);
		expect(readFileSync(join(work, "tests", "test_x.py"), "utf8")).toBe("import sys; sys.exit(1)\n");
		expect(existsSync(join(work, "tests", "test_new.py"))).toBe(true);
		expect(readFileSync(join(work, "lib.py"), "utf8")).toBe("x = 2\n");
		expect(restoreProtectedTests(task, work)).toEqual([]);
		rmSync(work, { recursive: true, force: true });

		writeFileSync(
			join(dir, "solution.patch"),
			"diff --git a/tests/test_x.py b/tests/test_x.py\n--- a/tests/test_x.py\n+++ b/tests/test_x.py\n@@ -1 +1 @@\n-import sys; sys.exit(1)\n+pass\n",
		);
		const [reloaded] = loadTasks(tmp ?? "");
		const [result] = await validateTasks(reloaded ? [reloaded] : [], join(tmp ?? "", "scratch"));
		expect(result?.solutionPasses).toBe(false);
		expect(result?.detail).toContain("solution.patch edits protected tests (tests/test_x.py)");
	});
});
