import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summarize } from "../src/report.ts";
import type { RunRecord } from "../src/run.ts";
import { loadTasks } from "../src/task.ts";

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
