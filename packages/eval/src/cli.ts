#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderMarkdown } from "./report.ts";
import { type RunRecord, runEval, validateTasks } from "./run.ts";
import { loadTasks, type Task } from "./task.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

const USAGE = `Usage: npm run eval -- [options]

Runs eval tasks through pi (RPC mode) with each Exocortex config and reports metrics.

Options:
  --config <a,b>     Exocortex configs from packages/eval/configs (default: all-off)
  --tasks <globs>    Comma-separated task id globs, e.g. "py-*,go-lru" (default: all)
  --tags <a,b>       Only tasks carrying any of these tags, e.g. "hard" or "smoke"
  --repeat <n>       Repeats per task × config (default: 1)
  --model <p/id>     pi model, e.g. ninfer/qwen3.8-27b (default: pi's default model)
  --pi-agent-dir <d> pi agent dir with models.json/auth (default: ~/.pi/agent)
  --pi-arg <arg>     Extra pi CLI argument (repeatable)
  --out <dir>        Output root (default: eval-runs/)
  --keep-workdirs    Keep each run's workspace (under the OS temp dir) for inspection
  --validate         Check fixtures only: pristine must fail, solution.patch must pass
  --report <dir>     Re-render <dir>/summary.md from a finished (or interrupted) run's results,
                     optionally restricted with --tasks/--tags (e.g. one failure-mode slice)
  -h, --help`;

type CliValues = ReturnType<typeof parseCli>;

function parseCli() {
	return parseArgs({
		options: {
			config: { type: "string", default: "all-off" },
			tasks: { type: "string" },
			tags: { type: "string" },
			repeat: { type: "string", default: "1" },
			model: { type: "string" },
			"pi-agent-dir": { type: "string" },
			"pi-arg": { type: "string", multiple: true },
			out: { type: "string", default: join(REPO_ROOT, "eval-runs") },
			"keep-workdirs": { type: "boolean", default: false },
			validate: { type: "boolean", default: false },
			report: { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: false,
	}).values;
}

async function main(): Promise<number> {
	const values = parseCli();
	if (values.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const tasks = loadTasks(join(REPO_ROOT, "tasks"), splitList(values.tasks), splitList(values.tags));
	if (tasks.length === 0) {
		process.stderr.write("No tasks matched.\n");
		return 2;
	}
	if (values.report) return report(resolve(values.report), tasks, values);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outRoot = resolve(values.out);
	return values.validate
		? validate(tasks, join(outRoot, `validate-${stamp}`))
		: run(tasks, values, join(outRoot, stamp), stamp);
}

async function validate(tasks: readonly Task[], scratchDir: string): Promise<number> {
	const results = await validateTasks(tasks, scratchDir);
	for (const r of results) {
		const solution =
			r.solutionPasses === null ? "no solution.patch" : r.solutionPasses ? "solution passes" : "SOLUTION FAILS";
		const pristine = r.pristineFails ? "pristine fails" : "PRISTINE PASSES";
		const mark = r.pristineFails && r.solutionPasses !== false ? "✓" : "✗";
		process.stdout.write(`${mark} ${r.taskId}: ${pristine}, ${solution}${r.detail ? ` — ${r.detail}` : ""}\n`);
	}
	return results.every((r) => r.pristineFails && r.solutionPasses !== false) ? 0 : 1;
}

async function run(tasks: readonly Task[], values: CliValues, runDir: string, stamp: string): Promise<number> {
	const repeats = Number.parseInt(values.repeat, 10);
	if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeat must be a positive integer");
	const configs = splitList(values.config);
	process.stdout.write(
		`Eval run ${stamp}: ${tasks.length} tasks × ${configs.length} configs × ${repeats} → ${runDir}\n`,
	);

	const records = await runEval({
		tasks,
		configs,
		configsDir: join(REPO_ROOT, "packages", "eval", "configs"),
		repeats,
		runDir,
		...(values.model ? { model: values.model } : {}),
		...(values["pi-agent-dir"] ? { piAgentDir: resolve(values["pi-agent-dir"]) } : {}),
		extraPiArgs: values["pi-arg"] ?? [],
		keepWorkdirs: values["keep-workdirs"],
		log: (line) => process.stdout.write(`${line}\n`),
	});

	const markdown = renderMarkdown(records, `Eval ${stamp}${values.model ? ` · ${values.model}` : ""}`);
	writeFileSync(join(runDir, "results.json"), JSON.stringify(records, null, 2));
	writeFileSync(join(runDir, "summary.md"), markdown);
	process.stdout.write(`\n${markdown}\nWrote ${join(runDir, "summary.md")}\n`);
	return 0;
}

/** Rebuilds the summary from results.json, or results.jsonl when the run was interrupted. */
function report(runDir: string, tasks: readonly Task[], values: CliValues): number {
	const json = join(runDir, "results.json");
	const jsonl = join(runDir, "results.jsonl");
	const all: RunRecord[] = existsSync(json)
		? (JSON.parse(readFileSync(json, "utf8")) as RunRecord[])
		: existsSync(jsonl)
			? readFileSync(jsonl, "utf8")
					.split("\n")
					.filter((line) => line.trim() !== "")
					.map((line) => JSON.parse(line) as RunRecord)
			: [];
	const ids = new Set(tasks.map((t) => t.spec.id));
	const records = all.filter((r) => ids.has(r.taskId));
	if (records.length === 0) {
		process.stderr.write(`No results for the selected tasks in ${runDir}\n`);
		return 1;
	}
	const slice = values.tags || values.tasks ? ` · ${[values.tags, values.tasks].filter(Boolean).join(" · ")}` : "";
	const markdown = renderMarkdown(records, `Eval ${runDir.split("/").at(-1) ?? runDir}${slice}`);
	const name = slice ? `summary-${(values.tags ?? values.tasks ?? "slice").replace(/[^\w-]+/g, "_")}.md` : "summary.md";
	writeFileSync(join(runDir, name), markdown);
	process.stdout.write(`${markdown}\nWrote ${join(runDir, name)}\n`);
	return 0;
}

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
