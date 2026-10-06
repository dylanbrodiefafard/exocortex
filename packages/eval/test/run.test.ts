import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@exocortex/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invalidReason, type RunRecord, readResultLines, readResults } from "../src/records.ts";
import { renderMarkdown } from "../src/report.ts";
import { configOrder, type EvalOptions, readRunMeta, runEval } from "../src/run.ts";
import { loadTask, type Task } from "../src/task.ts";
import { type FakePiBehavior, fakePiEnv, writeFakePi } from "./fake-pi.ts";

let tmp = "";
const savedEnv = { HOME: process.env["HOME"], FAKE_PI: process.env["FAKE_PI"] };

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "exo-run-"));
	mkdirSync(join(tmp, "home"));
	// No global Exocortex config, whatever the machine running the tests has.
	process.env["HOME"] = join(tmp, "home");
	mkdirSync(join(tmp, "configs"));
	for (const name of ["a", "b", "c"]) writeFileSync(join(tmp, "configs", `${name}.jsonc`), '{ "modules": {} }');
});

afterEach(() => {
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(tmp, { recursive: true, force: true });
});

/** A task the fake agent solves by writing `fixed` into `visible.txt`. */
function task(id: string, spec: Record<string, unknown> = {}): Task {
	const dir = join(tmp, "tasks", id);
	mkdirSync(join(dir, "repo"), { recursive: true });
	writeFileSync(join(dir, "repo", "visible.txt"), "v\n");
	writeFileSync(
		join(dir, "task.json"),
		JSON.stringify({ id, language: "other", prompt: "fix it", check: "grep -q fixed visible.txt", ...spec }),
	);
	return loadTask(dir);
}

const SOLVE = "echo fixed > visible.txt";

async function evaluate(
	behavior: FakePiBehavior,
	options: Partial<EvalOptions> & { readonly tasks: readonly Task[] },
): Promise<{ records: RunRecord[]; log: string[]; runDir: string }> {
	Object.assign(process.env, fakePiEnv(behavior));
	const log: string[] = [];
	const runDir = options.runDir ?? join(tmp, "run");
	const records = await runEval({
		configs: ["a"],
		configsDir: join(tmp, "configs"),
		repeats: 1,
		runDir,
		workRoot: join(tmp, "work"),
		piCliPath: writeFakePi(tmp),
		log: (line) => log.push(line),
		...options,
	});
	return { records, log, runDir };
}

const started = (log: readonly string[]) => log.filter((l) => l.startsWith("▶ ")).map((l) => l.slice(2));

describe("runEval", { timeout: 30_000 }, () => {
	it("scores a solved task and cleans its workspace up", async () => {
		const { records, runDir } = await evaluate({ shell: SOLVE }, { tasks: [task("fix")] });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ label: "fix--a--r1", outcome: "settled", success: true, checkExitCode: 0 });
		expect(records[0]?.attempts).toBeUndefined();
		expect(readResultLines(runDir)).toHaveLength(1);
		expect(readdirSync(join(tmp, "work"))).toEqual([]);
	});

	it("gives each run its own workspaces, also when two run directories have the same name (E4)", async () => {
		// Every test names its run directory `run`, and so may two real runs started with the same
		// `--out`: with one work root per name, the first to finish removed the other's workspace.
		const name = `run-${process.pid}-${Date.now()}`;
		const fix = task("fix");
		Object.assign(process.env, fakePiEnv({ shell: `sleep 0.3; ${SOLVE}` }));
		const evaluateIn = (parent: string) =>
			runEval({
				tasks: [fix],
				configs: ["a"],
				configsDir: join(tmp, "configs"),
				repeats: 1,
				runDir: join(tmp, parent, name),
				piCliPath: writeFakePi(tmp),
			});
		const [one, two] = await Promise.all([evaluateIn("one"), evaluateIn("two")]);
		expect(one[0]).toMatchObject({ outcome: "settled", success: true });
		expect(two[0]).toMatchObject({ outcome: "settled", success: true });
		// The default work root is the harness's own to remove.
		expect(readdirSync(tmpdir()).filter((entry) => entry.includes(name))).toEqual([]);
	});

	it("runs the configs of each task and repeat in a seeded, recorded, replayable order", async () => {
		const configs = ["a", "b", "c"];
		const { log, runDir, records } = await evaluate(
			{ shell: SOLVE },
			{ tasks: [task("fix")], configs, repeats: 6, seed: 12 },
		);
		const order = started(log).map((label) => label.split("--")[1]);
		const expected = [1, 2, 3, 4, 5, 6].flatMap((repeat) => configOrder(configs, 12, "fix", repeat));
		expect(order).toEqual(expected);
		// Shuffled: not the same config first every time, as the fixed order was.
		const first = [0, 3, 6, 9, 12, 15].map((i) => order[i]);
		expect(new Set(first).size).toBeGreaterThan(1);
		expect(readRunMeta(runDir)).toEqual({ seed: 12, configs, repeats: 6, tasks: ["fix"] });
		// Another seed gives another order; the same seed the same one.
		expect([1, 2, 3, 4, 5, 6].flatMap((repeat) => configOrder(configs, 13, "fix", repeat))).not.toEqual(expected);
		// The report still pairs against the first config given, not the first one that happened to run.
		const shuffledFirst = records[0]?.config;
		expect(renderMarkdown(records, "t", configs)).toContain("## Paired by task vs `a`");
		expect(renderMarkdown(records, "t", ["b", "a", "c"])).toContain("## Paired by task vs `b`");
		expect(renderMarkdown(records, "t")).toContain(`## Paired by task vs \`${shuffledFirst}\``);
	});

	it("picks a seed when none is given and writes it down", async () => {
		const { runDir } = await evaluate({ shell: SOLVE }, { tasks: [task("fix")] });
		expect(readRunMeta(runDir)?.seed).toBeTypeOf("number");
		expect(readRunMeta(join(tmp, "nowhere"))).toBeUndefined();
	});

	it("gives every config its own module state, whatever the config file says", async () => {
		writeFileSync(
			join(tmp, "configs", "b.jsonc"),
			'{ "modules": { "memory": { "enabled": true, "dbPath": "/home/someone/.exocortex/memory.db" }, "trimmer": { "enabled": true } } }',
		);
		const { runDir, log } = await evaluate({ shell: SOLVE }, { tasks: [task("fix")], configs: ["a", "b"] });
		const read = (name: string) =>
			JSON.parse(readFileSync(join(runDir, "configs", `${name}.json`), "utf8")) as {
				modules: Record<string, Record<string, unknown>>;
				trace: Record<string, unknown>;
			};
		expect(read("a").modules).toEqual({
			memory: { dbPath: join(runDir, "memory-a.db") },
			trimmer: { saveDir: join(tmp, "work", ".exo-trimmer", "a") },
		});
		expect(read("b").modules).toEqual({
			memory: { enabled: true, dbPath: join(runDir, "memory-b.db") },
			trimmer: { enabled: true, saveDir: join(tmp, "work", ".exo-trimmer", "b") },
		});
		expect(read("b").trace).toEqual({ enabled: true, dbPath: join(runDir, "trace.db") });
		// What the eval writes must load without a problem: one problem turns the trace off.
		for (const name of ["a", "b"]) {
			const path = join(runDir, "configs", `${name}.json`);
			expect(loadConfig({ cwd: tmp, env: { EXO_CONFIG: path } }).problems, name).toEqual([]);
		}
		// With no global config the sidecars silently ran on defaults; now the run says so.
		expect(log.some((line) => line.includes("no global Exocortex config"))).toBe(true);
	});

	it("says so when the global config is ignored for its problems, and uses it when it is fine", async () => {
		mkdirSync(join(tmp, "home", ".exocortex"));
		const global = join(tmp, "home", ".exocortex", "config.jsonc");
		writeFileSync(global, '{ "pool": { "maxConcurrent": "many" } }');
		const bad = await evaluate({ shell: SOLVE }, { tasks: [task("fix")], runDir: join(tmp, "run-bad") });
		expect(bad.log.some((line) => line.includes("global Exocortex config ignored"))).toBe(true);
		writeFileSync(global, '{ "pool": { "maxConcurrent": 2, "reservedForMain": 1 } }');
		const good = await evaluate({ shell: SOLVE }, { tasks: [task("fix2")], runDir: join(tmp, "run-good") });
		expect(good.log.some((line) => line.includes("Exocortex config"))).toBe(false);
		const written = JSON.parse(readFileSync(join(good.runDir, "configs", "a.json"), "utf8")) as {
			pool: { maxConcurrent: number };
		};
		expect(written.pool.maxConcurrent).toBe(2);
	});

	it("rejects a config that is not a JSON object", async () => {
		writeFileSync(join(tmp, "configs", "a.jsonc"), "[1, 2");
		await expect(evaluate({}, { tasks: [task("fix")] })).rejects.toThrow(/invalid JSONC config/);
	});

	it("retries a run whose pi crashed, once, and keeps the invalid attempt on file", async () => {
		const { records, runDir, log } = await evaluate({ shell: SOLVE, crashUnlessRetry: true }, { tasks: [task("fix")] });
		expect(records[0]).toMatchObject({ label: "fix--a--r1--retry", outcome: "settled", success: true, attempts: 2 });
		expect(log.some((line) => line.includes("invalid (crashed"))).toBe(true);
		const attempts = readFileSync(join(runDir, "invalid-attempts.jsonl"), "utf8").trim().split("\n");
		expect(attempts).toHaveLength(1);
		expect(JSON.parse(attempts[0] ?? "{}")).toMatchObject({ label: "fix--a--r1", outcome: "crashed" });
	});

	it("records a run that stays broken as invalid, not as the task failing, and carries on", async () => {
		const { records, log } = await evaluate(
			{ shell: SOLVE, crashWhenLabelHas: "--b--" },
			{ tasks: [task("fix")], configs: ["a", "b"], seed: 1 },
		);
		const byConfig = new Map(records.map((r) => [r.config, r]));
		expect(byConfig.get("a")).toMatchObject({ outcome: "settled", success: true });
		expect(byConfig.get("b")).toMatchObject({ outcome: "crashed", success: false, attempts: 2 });
		expect(invalidReason(byConfig.get("b") as RunRecord)).toBe("crashed");
		expect(log.some((line) => line.includes("– invalid (crashed)"))).toBe(true);
		const markdown = renderMarkdown(records, "t", ["a", "b"]);
		// The crash is in its own column and out of the success rate: 0 of 0 valid runs, not 0 of 1.
		expect(markdown).toMatch(/\| b \| 0\/0 \| .* \| 0 \| 1 \| 0 \| 0 \|\n/);
		expect(markdown).toContain("| fix | 1/1 | 0/0 (+1 invalid) |");
		expect(markdown).toContain("`b`: 1 (task, repeat) block with an invalid run.");
	});

	it("records a failed setup as invalid", async () => {
		const { records } = await evaluate(
			{ shell: SOLVE },
			{ tasks: [task("fix", { setup: "echo no toolchain; exit 3" })] },
		);
		expect(records[0]).toMatchObject({ outcome: "setup_failed", success: false, attempts: 2 });
		expect(records[0]?.error).toContain("no toolchain");
	});

	it("turns a failure while scoring into a harness error instead of ending the suite", async () => {
		// The hidden overlay cannot be copied: before D-079 this exception ended the whole run.
		const broken = { ...task("broken"), hiddenDir: join(tmp, "no-such-dir") };
		const { records, runDir } = await evaluate({ shell: SOLVE }, { tasks: [broken, task("fix")] });
		expect(records.map((r) => r.outcome)).toEqual(["harness_error", "settled"]);
		expect(records[0]?.error).toContain("scoring failed");
		expect(records[0]).toMatchObject({ success: false, attempts: 2 });
		expect(invalidReason(records[0] as RunRecord)).toBe("harness_error");
		expect(readResultLines(runDir)).toHaveLength(2);
	});

	it("turns a failure to start pi into a harness error too", async () => {
		// `logs` is a file, so the stderr log cannot be opened.
		mkdirSync(join(tmp, "run"));
		writeFileSync(join(tmp, "run", "logs"), "");
		const { records } = await evaluate({ shell: SOLVE }, { tasks: [task("fix")] });
		expect(records[0]?.outcome).toBe("harness_error");
		expect(records[0]?.error).toContain("driving pi failed");
	});

	it("records how the workspace differs from the baseline, before the guard touches it (E1)", async () => {
		const edit = `${SOLVE}; echo scratch > notes.txt; mkdir build; echo o > build/out.o`;
		const before = Date.now();
		const { records } = await evaluate({ shell: edit }, { tasks: [task("fix")] });
		// No edit tool ran, and there is no trace at all: the diff is what says the agent edited.
		expect(records[0]?.edits?.files).toEqual(["notes.txt", "visible.txt"]);
		expect(records[0]?.edits?.lastEditMs).toBeGreaterThanOrEqual(before - 1_000);
		const untouched = await evaluate({ turns: 1 }, { tasks: [task("fix2")], runDir: join(tmp, "run2") });
		expect(untouched.records[0]?.edits).toEqual({ files: [], lastEditMs: null });
	});

	it("waits at close for pi's shutdown, asks it to drain for longer, and keeps that wait out of the run's time (E2)", async () => {
		const slowExit = { shell: SOLVE, shutdownMs: 600 };
		const { records } = await evaluate(slowExit, { tasks: [task("fix")], keepWorkdirs: true });
		const [record] = records;
		expect(record).toMatchObject({ outcome: "settled", success: true });
		expect(record?.killedAtClose).toBeUndefined();
		expect(record?.closeMs).toBeGreaterThanOrEqual(550);
		// The fake pi exited by itself, having been told the eval's drain time and not the 2 s default.
		expect(readFileSync(join(tmp, "work", "fix--a--r1", "shutdown-done"), "utf8")).toBe("30000");
		const asked = await evaluate(slowExit, {
			tasks: [task("fix2")],
			keepWorkdirs: true,
			drainMs: 1_234,
			runDir: join(tmp, "run2"),
		});
		expect(readFileSync(join(tmp, "work", "fix2--a--r1", "shutdown-done"), "utf8")).toBe("1234");
		// The wall clock is the run's, without the wait for background work.
		const total = (asked.records[0]?.wallClockMs ?? 0) + (asked.records[0]?.closeMs ?? 0);
		expect(asked.records[0]?.wallClockMs).toBeLessThan(total - 500);
	});

	it("kills a pi that never finishes shutting down, says so in the record and scores the run anyway", async () => {
		const stuck = { shell: SOLVE, shutdownMs: 600_000 };
		const { records, log } = await evaluate(stuck, { tasks: [task("fix")], drainMs: 0 });
		expect(records[0]).toMatchObject({ outcome: "settled", success: true, killedAtClose: true });
		expect(log.some((line) => line.includes("did not shut down within 5000 ms"))).toBe(true);
		expect(renderMarkdown(records, "t")).toContain("| a | 0 | 0 | 0 | 1 |");
	});

	it("keeps workspaces when asked", async () => {
		const { log } = await evaluate({ shell: SOLVE }, { tasks: [task("fix")], keepWorkdirs: true });
		expect(log.some((line) => line.includes("workspace kept"))).toBe(true);
		expect(readFileSync(join(tmp, "work", "fix--a--r1", "visible.txt"), "utf8")).toBe("fixed\n");
	});

	it("resumes an interrupted run: finished runs are kept, a torn line is skipped, the seed is reused", async () => {
		const tasks = [task("fix"), task("fix2")];
		const first = await evaluate({ shell: SOLVE }, { tasks, configs: ["a", "b"], seed: 5 });
		expect(first.records).toHaveLength(4);
		// The run was killed while writing the next record.
		appendFileSync(join(first.runDir, "results.jsonl"), '{"label":"fix--a--r2","taskId":"fi');
		const resumed = await evaluate(
			{ shell: SOLVE },
			{ tasks, configs: ["a", "b"], repeats: 2, seed: 999, resume: true },
		);
		expect(started(resumed.log)).toHaveLength(4);
		expect(started(resumed.log).every((label) => label.endsWith("--r2"))).toBe(true);
		expect(resumed.log.some((line) => line.includes("unparsable line skipped"))).toBe(true);
		expect(resumed.log.some((line) => line.includes("resuming: 4 runs already recorded"))).toBe(true);
		expect(resumed.records).toHaveLength(8);
		expect(readRunMeta(resumed.runDir)).toMatchObject({ seed: 5, repeats: 2 });
		// Without --resume the same directory would be run from the start.
		const warnings: string[] = [];
		expect(readResultLines(resumed.runDir, (w) => warnings.push(w))).toHaveLength(8);
		expect(warnings).toHaveLength(1);
	});
});

describe("readResults", () => {
	const record = (label: string): RunRecord => ({
		label,
		taskId: "t",
		config: "a",
		repeat: 1,
		outcome: "settled",
		success: true,
		checkExitCode: 0,
		checkTimedOut: false,
		agentMs: 1,
		acceptedSuggestions: 0,
		wallClockMs: 1,
		metrics: null,
	});

	it("prefers results.json, and falls back to the lines when it is missing or broken", () => {
		const warnings: string[] = [];
		const warn = (w: string) => warnings.push(w);
		expect(readResults(tmp, warn)).toEqual([]);
		writeFileSync(join(tmp, "results.jsonl"), `${JSON.stringify(record("x"))}\n\n{"not":"a record"}\n{oops\n`);
		expect(readResults(tmp, warn).map((r) => r.label)).toEqual(["x"]);
		expect(warnings).toEqual([
			`${join(tmp, "results.jsonl")}:3: not a run record, skipped`,
			`${join(tmp, "results.jsonl")}:4: unparsable line skipped`,
		]);
		writeFileSync(join(tmp, "results.json"), JSON.stringify([record("y"), record("z")]));
		expect(readResults(tmp).map((r) => r.label)).toEqual(["y", "z"]);
		writeFileSync(join(tmp, "results.json"), "{");
		expect(readResults(tmp).map((r) => r.label)).toEqual(["x"]);
		writeFileSync(join(tmp, "results.json"), '{"a":1}');
		warnings.length = 0;
		expect(readResults(tmp, warn).map((r) => r.label)).toEqual(["x"]);
		expect(warnings[0]).toContain("not a list of results");
		expect(existsSync(join(tmp, "results.json"))).toBe(true);
	});
});
