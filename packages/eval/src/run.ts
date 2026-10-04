import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, openTraceStore } from "@exocortex/core";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { computeTraceMetrics, type TraceMetrics } from "./metrics.ts";
import { PiRpcProcess, type RunOutcome } from "./pi-rpc.ts";
import type { Task } from "./task.ts";
import { applyHiddenOverlay, applyPatch, prepareWorkspace, runShell } from "./workspace.ts";

export interface EvalOptions {
	readonly tasks: readonly Task[];
	/** Exocortex config names, resolved as `<configsDir>/<name>.jsonc`. */
	readonly configs: readonly string[];
	readonly configsDir: string;
	readonly repeats: number;
	/** Directory for this run's artifacts (created). */
	readonly runDir: string;
	/**
	 * Parent for per-run workspaces. Defaults to the OS temp dir: workspaces must live outside
	 * this repo so the agent can't wander up into `tasks/` and read solutions or hidden tests.
	 */
	readonly workRoot?: string;
	readonly model?: string;
	/** pi agent dir (models.json, auth). Defaults to pi's own default (`~/.pi/agent`). */
	readonly piAgentDir?: string;
	readonly piCliPath?: string;
	readonly extraPiArgs?: readonly string[];
	readonly keepWorkdirs?: boolean;
	readonly log?: (line: string) => void;
}

export interface RunRecord {
	readonly label: string;
	readonly taskId: string;
	readonly config: string;
	readonly repeat: number;
	readonly outcome: RunOutcome | "setup_failed";
	readonly success: boolean;
	readonly checkExitCode: number | null;
	readonly checkTimedOut: boolean;
	readonly agentMs: number;
	/** Supervisor (or other) editor suggestions the harness accepted on the user's behalf. */
	readonly acceptedSuggestions: number;
	readonly wallClockMs: number;
	readonly metrics: TraceMetrics | null;
	readonly error?: string;
}

const DEFAULT_PI_CLI = join(
	dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"bundle",
	"cli.js",
);
const ADAPTER_ENTRY = fileURLToPath(import.meta.resolve("@exocortex/pi-adapter"));

/**
 * Runs every task × config × repeat sequentially (one main agent at a time, so runs don't
 * compete for the inference server), appending each result to `results.jsonl` as it finishes.
 */
export async function runEval(options: EvalOptions): Promise<RunRecord[]> {
	const log = options.log ?? (() => {});
	mkdirSync(options.runDir, { recursive: true });
	const dbPath = join(options.runDir, "trace.db");
	const configPaths = new Map(
		options.configs.map((name) => [name, writeRunConfig(options.configsDir, name, options.runDir, dbPath)]),
	);
	const results: RunRecord[] = [];
	for (let repeat = 1; repeat <= options.repeats; repeat++) {
		for (const task of options.tasks) {
			for (const config of options.configs) {
				const label = `${task.spec.id}--${config}--r${repeat}`;
				log(`▶ ${label}`);
				const record = await runOne(options, task, config, repeat, label, configPaths.get(config) ?? "", dbPath);
				results.push(record);
				appendFileSync(join(options.runDir, "results.jsonl"), `${JSON.stringify(record)}\n`);
				log(
					`  ${record.success ? "✓ pass" : "✗ fail"} · ${record.outcome} · ${record.metrics?.turns ?? "?"} turns · ${Math.round(record.wallClockMs / 1000)}s`,
				);
			}
		}
	}
	return results;
}

async function runOne(
	options: EvalOptions,
	task: Task,
	config: string,
	repeat: number,
	label: string,
	configPath: string,
	dbPath: string,
): Promise<RunRecord> {
	const started = performance.now();
	const workdir = join(options.workRoot ?? join(tmpdir(), `exo-eval-${basename(options.runDir)}`), label);
	const base = { label, taskId: task.spec.id, config, repeat };
	const fail = (outcome: RunRecord["outcome"], error: string): RunRecord => ({
		...base,
		outcome,
		success: false,
		checkExitCode: null,
		checkTimedOut: false,
		agentMs: 0,
		acceptedSuggestions: 0,
		wallClockMs: Math.round(performance.now() - started),
		metrics: null,
		error,
	});

	try {
		await prepareWorkspace(task, workdir);
		if (task.spec.setup) {
			const setup = await runShell(task.spec.setup, workdir, task.spec.checkTimeoutSec * 1000);
			if (setup.exitCode !== 0) return fail("setup_failed", `setup failed: ${setup.outputTail}`);
		}
	} catch (error) {
		return fail("setup_failed", String(error));
	}

	const sessionDir = join(options.runDir, "sessions", label);
	mkdirSync(join(options.runDir, "logs"), { recursive: true });
	const pi = new PiRpcProcess({
		cliPath: options.piCliPath ?? DEFAULT_PI_CLI,
		cwd: workdir,
		args: [
			"-ne",
			"-ns",
			"-np",
			"-nc",
			"--no-themes",
			"--session-dir",
			sessionDir,
			"-e",
			ADAPTER_ENTRY,
			...(options.model ? ["--model", options.model] : []),
			...(options.extraPiArgs ?? []),
		],
		env: {
			EXO_CONFIG: configPath,
			EXO_TRACE_LABEL: label,
			...(options.piAgentDir ? { PI_CODING_AGENT_DIR: options.piAgentDir } : {}),
		},
		stderrPath: join(options.runDir, "logs", `${label}.stderr.log`),
	});
	const agent = await pi.prompt(task.spec.prompt, {
		maxTurns: task.spec.maxTurns,
		timeoutMs: task.spec.timeoutSec * 1000,
		acceptSuggestions: true,
	});
	await pi.close();

	applyHiddenOverlay(task, workdir);
	const check = await runShell(task.spec.check, workdir, task.spec.checkTimeoutSec * 1000);
	writeFileSync(join(options.runDir, "logs", `${label}.check.log`), check.outputTail);
	const metrics = readMetrics(dbPath, label);
	if (options.keepWorkdirs) options.log?.(`  workspace kept: ${workdir}`);
	else rmSync(workdir, { recursive: true, force: true });

	return {
		...base,
		outcome: agent.outcome,
		success: check.exitCode === 0,
		checkExitCode: check.exitCode,
		checkTimedOut: check.timedOut,
		agentMs: agent.durationMs,
		acceptedSuggestions: agent.acceptedSuggestions,
		wallClockMs: Math.round(performance.now() - started),
		metrics,
		...(agent.error === undefined ? {} : { error: agent.error }),
	};
}

function readMetrics(dbPath: string, label: string): TraceMetrics | null {
	const store = openTraceStore({ path: dbPath });
	try {
		const sessions = store.sessions({ label });
		if (sessions.length === 0) return null;
		return computeTraceMetrics(
			sessions.flatMap((s) => store.events(s.id)),
			sessions.flatMap((s) => store.sidecarCalls(s.id)),
		);
	} finally {
		store.close();
	}
}

/** Writes `<runDir>/configs/<name>.json`: the named config with the trace redirected to this run's DB. */
function writeRunConfig(configsDir: string, name: string, runDir: string, dbPath: string): string {
	const source = join(configsDir, `${name}.jsonc`);
	const errors: ParseError[] = [];
	const parsed: unknown = parseJsonc(readFileSync(source, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0 || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${source}: invalid JSONC config`);
	}
	const config = parsed as Record<string, unknown>;
	const trace = typeof config["trace"] === "object" && config["trace"] !== null ? config["trace"] : {};
	// Machine-specific settings (which engine, how many slots) come from the user's global config,
	// so sidecars respect the real engine (D-038); the named config decides everything else.
	const machine = machineSettings(runDir);
	const merged = { ...machine, ...config, trace: { ...trace, enabled: true, dbPath } };
	const out = join(runDir, "configs", `${name}.json`);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(merged, null, 2));
	return out;
}

function machineSettings(cwd: string): Record<string, unknown> {
	const loaded = loadConfig({ cwd, env: { ...process.env, EXO_CONFIG: undefined } });
	if (!loaded.sources[0]?.found || loaded.problems.length > 0) return {};
	return { engine: loaded.config.engine, pool: loaded.config.pool };
}

export interface ValidationResult {
	readonly taskId: string;
	readonly pristineFails: boolean;
	readonly solutionPasses: boolean | null;
	readonly detail: string;
}

/**
 * Fixture QA: the check must fail on the pristine repo and (when `solution.patch` exists) pass
 * once it is applied.
 */
export async function validateTasks(tasks: readonly Task[], scratchDir: string): Promise<ValidationResult[]> {
	const results: ValidationResult[] = [];
	for (const task of tasks) {
		const pristineDir = join(scratchDir, task.spec.id, "pristine");
		const solvedDir = join(scratchDir, task.spec.id, "solved");
		let detail = "";
		await prepareWorkspace(task, pristineDir);
		if (task.spec.setup) await runShell(task.spec.setup, pristineDir, task.spec.checkTimeoutSec * 1000);
		applyHiddenOverlay(task, pristineDir);
		const pristine = await runShell(task.spec.check, pristineDir, task.spec.checkTimeoutSec * 1000);
		if (pristine.exitCode === 0) detail += "check passes without any change; ";
		let solutionPasses: boolean | null = null;
		if (task.solutionPatch) {
			await prepareWorkspace(task, solvedDir);
			await applyPatch(solvedDir, task.solutionPatch);
			if (task.spec.setup) await runShell(task.spec.setup, solvedDir, task.spec.checkTimeoutSec * 1000);
			applyHiddenOverlay(task, solvedDir);
			const solved = await runShell(task.spec.check, solvedDir, task.spec.checkTimeoutSec * 1000);
			solutionPasses = solved.exitCode === 0;
			if (!solutionPasses) detail += `solution fails: ${solved.outputTail.slice(-600)}`;
		}
		results.push({
			taskId: task.spec.id,
			pristineFails: pristine.exitCode !== 0,
			solutionPasses,
			detail: detail.trim(),
		});
	}
	rmSync(scratchDir, { recursive: true, force: true });
	return results;
}
