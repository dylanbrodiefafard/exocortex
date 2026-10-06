import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, openTraceStore } from "@exocortex/core";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { computeTraceMetrics, type TraceMetrics, type WorkspaceEdits, type WorkspaceFacts } from "./metrics.ts";
import { PiRpcProcess, type PromptResult } from "./pi-rpc.ts";
import { deriveSeed, mulberry32, shuffled } from "./random.ts";
import { invalidReason, type RunRecord, readResultLines } from "./records.ts";
import type { Task } from "./task.ts";
import { countPassedTests } from "./test-count.ts";
import {
	applyCheckGuard,
	applyHiddenOverlay,
	applyPatch,
	type GuardResult,
	prepareWorkspace,
	runCheck,
	runShell,
	workspaceEdits,
} from "./workspace.ts";

export interface EvalOptions {
	readonly tasks: readonly Task[];
	/** Exocortex config names, resolved as `<configsDir>/<name>.jsonc`. The first is the baseline. */
	readonly configs: readonly string[];
	readonly configsDir: string;
	readonly repeats: number;
	/** Directory for this run's artifacts (created). */
	readonly runDir: string;
	/**
	 * Parent for per-run workspaces. Defaults to a new directory under the OS temp dir, removed
	 * when the run ends: workspaces must live outside this repo so the agent can't wander up into
	 * `tasks/` and read solutions or hidden tests, and two runs must never share one.
	 */
	readonly workRoot?: string;
	readonly model?: string;
	/** pi agent dir (models.json, auth). Defaults to pi's own default (`~/.pi/agent`). */
	readonly piAgentDir?: string;
	readonly piCliPath?: string;
	readonly extraPiArgs?: readonly string[];
	readonly keepWorkdirs?: boolean;
	/**
	 * Decides the order the configs run in within each (task, repeat). Written to `run.json`; a
	 * resumed run reads it from there. Defaults to a fresh one.
	 */
	readonly seed?: number;
	/** Skip every (task, config, repeat) already in `runDir`'s `results.jsonl`. */
	readonly resume?: boolean;
	/**
	 * How long pi may wait at the end of a run for background sidecar calls before it cancels them
	 * (the adapter's `EXO_SHUTDOWN_DRAIN_MS`). Default {@link DEFAULT_DRAIN_MS}.
	 */
	readonly drainMs?: number;
	readonly log?: (line: string) => void;
}

/** What `run.json` records about a run: enough to replay its order and to report it. */
export interface RunMeta {
	readonly seed: number;
	/** In the order given on the command line: the first is the baseline the report pairs against. */
	readonly configs: readonly string[];
	readonly repeats: number;
	readonly tasks: readonly string[];
}

const DEFAULT_PI_CLI = join(
	dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"bundle",
	"cli.js",
);
const ADAPTER_ENTRY = fileURLToPath(import.meta.resolve("@exocortex/pi-adapter"));

/**
 * The harness closes pi the moment the agent settles, and memory's lesson-writing is a background
 * call that only starts then (D-086). An interactive session gives such calls 2 s at quit; a run
 * gives them 30 s, which is one call's own deadline (memory's `distillTimeoutMs`), so a call that
 * was free to start is never the one cut off. It costs nothing when nothing is in the background.
 */
const DEFAULT_DRAIN_MS = 30_000;
/**
 * What pi's shutdown may take on top of the drain before the harness kills it: disposing modules
 * (2 s at most, D-078), the trace's last flush (500 ms, D-080) and the process's own exit.
 */
const CLOSE_MARGIN_MS = 5_000;

/** `run.json` of a run directory, or undefined when it has none or it does not parse. */
export function readRunMeta(runDir: string): RunMeta | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as Partial<RunMeta>;
		return typeof parsed.seed === "number" && Array.isArray(parsed.configs) ? (parsed as RunMeta) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The order configs run in for one (task, repeat): shuffled, so no config always goes first on a
 * cold cache or last on a warm machine, and fixed by the run's seed so it can be replayed.
 */
export function configOrder(configs: readonly string[], seed: number, taskId: string, repeat: number): string[] {
	return shuffled(configs, mulberry32(deriveSeed(seed, taskId, String(repeat))));
}

/**
 * Runs every task × config × repeat sequentially (one main agent at a time, so runs don't
 * compete for the inference server), appending each result to `results.jsonl` as it finishes.
 * Returns the run's records, including those a resumed run found already done.
 */
export async function runEval(options: EvalOptions): Promise<RunRecord[]> {
	const log = options.log ?? (() => {});
	mkdirSync(options.runDir, { recursive: true });
	const seed = (options.resume ? readRunMeta(options.runDir)?.seed : undefined) ?? options.seed ?? freshSeed();
	const meta: RunMeta = {
		seed,
		configs: options.configs,
		repeats: options.repeats,
		tasks: options.tasks.map((t) => t.spec.id),
	};
	writeFileSync(join(options.runDir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);
	// A directory of this run's own (D-086): one named only after the run directory was shared by
	// every run whose directory had that name, and the first to finish removed the others' workspaces.
	const workRoot = options.workRoot ?? mkdtempSync(join(tmpdir(), `exo-eval-${basename(options.runDir)}-`));
	const results: RunRecord[] = [];
	try {
		const dbPath = join(options.runDir, "trace.db");
		const configPaths = new Map(
			options.configs.map((name) => [name, writeRunConfig(options, name, workRoot, dbPath, log)]),
		);
		const resultsPath = join(options.runDir, "results.jsonl");
		const done = options.resume ? finishedRuns(options.runDir, resultsPath, log) : new Map<string, RunRecord>();

		for (const slot of slots(options, seed)) {
			const earlier = done.get(slotKey(slot.task.spec.id, slot.config, slot.repeat));
			if (earlier) {
				results.push(earlier);
				continue;
			}
			const run: RunContext = { ...slot, options, workRoot, dbPath, configPath: configPaths.get(slot.config) ?? "" };
			const record = await runWithRetry(run, `${slot.task.spec.id}--${slot.config}--r${slot.repeat}`, log);
			results.push(record);
			appendFileSync(resultsPath, `${JSON.stringify(record)}\n`);
			log(`  ${resultLine(record)}`);
		}
	} finally {
		// A work root the caller named may hold other things; the default one is this run's to remove.
		const leftovers = options.workRoot === undefined ? workRoot : join(workRoot, TRIMMER_DIR);
		if (!options.keepWorkdirs) rmSync(leftovers, { recursive: true, force: true });
	}
	return results;
}

/** Every run of the suite in order: repeats outermost, then tasks, then the configs as shuffled for that pair. */
function* slots(options: EvalOptions, seed: number): Generator<{ task: Task; config: string; repeat: number }> {
	for (let repeat = 1; repeat <= options.repeats; repeat++) {
		for (const task of options.tasks) {
			for (const config of configOrder(options.configs, seed, task.spec.id, repeat)) yield { task, config, repeat };
		}
	}
}

function slotKey(taskId: string, config: string, repeat: number): string {
	return `${taskId}\u0000${config}\u0000${repeat}`;
}

/** The runs a resumed run directory already holds, by slot. */
function finishedRuns(runDir: string, resultsPath: string, log: (line: string) => void): Map<string, RunRecord> {
	const done = new Map(readResultLines(runDir, log).map((r) => [slotKey(r.taskId, r.config, r.repeat), r]));
	if (done.size > 0) log(`resuming: ${done.size} runs already recorded in ${runDir}`);
	// A run killed mid-write leaves a line without its newline: the next record must not join it.
	if (existsSync(resultsPath) && !readFileSync(resultsPath, "utf8").endsWith("\n")) appendFileSync(resultsPath, "\n");
	return done;
}

function resultLine(record: RunRecord): string {
	const invalid = invalidReason(record);
	const verdict = invalid ? `– invalid (${invalid})` : record.success ? "✓ pass" : "✗ fail";
	return `${verdict} · ${record.outcome} · ${record.metrics?.turns ?? "?"} turns · ${Math.round(record.wallClockMs / 1000)}s`;
}

function freshSeed(): number {
	return Math.floor(Math.random() * 4_294_967_296);
}

interface RunContext {
	readonly options: EvalOptions;
	readonly task: Task;
	readonly config: string;
	readonly repeat: number;
	readonly workRoot: string;
	readonly configPath: string;
	readonly dbPath: string;
}

/**
 * One run, repeated once when the first attempt was invalid (D-079): a crashed pi or a model
 * server that answered nothing says nothing about the agent, and a second failure of the same
 * kind is recorded as invalid rather than as the task failing. The workspace is removed only
 * here, after the record exists, so a failure while scoring leaves something to inspect.
 */
async function runWithRetry(run: RunContext, label: string, log: (line: string) => void): Promise<RunRecord> {
	const { options } = run;
	const cleanUp = (attemptLabel: string) => {
		const workdir = join(run.workRoot, attemptLabel);
		if (options.keepWorkdirs) log(`  workspace kept: ${workdir}`);
		else for (const dir of [workdir, asideDirOf(workdir)]) rmSync(dir, { recursive: true, force: true });
	};
	log(`▶ ${label}`);
	const first = await runOne(run, label);
	const reason = invalidReason(first);
	if (reason === null) {
		cleanUp(label);
		return first;
	}
	log(`  invalid (${reason}${first.error ? `: ${first.error.slice(0, 200)}` : ""}); retrying once`);
	appendFileSync(join(options.runDir, "invalid-attempts.jsonl"), `${JSON.stringify(first)}\n`);
	cleanUp(label);
	const retryLabel = `${label}--retry`;
	const second = { ...(await runOne(run, retryLabel)), attempts: 2 };
	cleanUp(retryLabel);
	return second;
}

function asideDirOf(workdir: string): string {
	return `${workdir}.aside`;
}

async function runOne(run: RunContext, label: string): Promise<RunRecord> {
	const { options, task } = run;
	const started = performance.now();
	const workdir = join(run.workRoot, label);
	const base = { label, taskId: task.spec.id, config: run.config, repeat: run.repeat };
	const fail = (outcome: RunRecord["outcome"], error: string, agent?: PromptResult): RunRecord => ({
		...base,
		outcome,
		success: false,
		checkExitCode: null,
		checkTimedOut: false,
		agentMs: agent?.durationMs ?? 0,
		acceptedSuggestions: agent?.acceptedSuggestions ?? 0,
		wallClockMs: Math.round(performance.now() - started),
		metrics: null,
		error,
	});

	let baseline: string;
	try {
		baseline = await prepareWorkspace(task, workdir);
		if (task.spec.setup) {
			const setup = await runShell(task.spec.setup, workdir, task.spec.checkTimeoutSec * 1000);
			if (setup.exitCode !== 0) return fail("setup_failed", `setup failed: ${setup.outputTail}`);
		}
	} catch (error) {
		return fail("setup_failed", String(error));
	}

	let driven: Driven;
	try {
		driven = await driveAgent(run, label, workdir);
	} catch (error) {
		return fail("harness_error", `driving pi failed: ${String(error)}`);
	}
	const { agent, closeMs, killedAtClose } = driven;

	// Everything after the agent can fail for reasons that are not the agent's (a full disk, a
	// locked trace): record that as a harness error and keep the suite going.
	try {
		// Before the guard: it restores files, and with them their times.
		const edits = await workspaceEdits(workdir, baseline);
		const score = await scoreWorkspace(task, workdir, asideDirOf(workdir));
		writeFileSync(join(options.runDir, "logs", `${label}.check.log`), score.output);
		for (const line of guardLines(score.guard)) options.log?.(`  ${line}`);
		if (score.tooFewTests) {
			options.log?.(`  check exited 0 but ran ${score.checkTests ?? "no"} tests; the task needs ${task.spec.minTests}`);
		}
		return {
			...base,
			outcome: agent.outcome,
			success: score.success,
			checkExitCode: score.checkExitCode,
			checkTimedOut: score.checkTimedOut,
			agentMs: agent.durationMs,
			acceptedSuggestions: agent.acceptedSuggestions,
			tamperedTests: score.guard.tamperedTests,
			tamperedFiles: score.guard.tamperedFiles,
			setAsideTests: score.guard.setAsideTests,
			checkTests: score.checkTests,
			...(score.tooFewTests ? { tooFewTests: true } : {}),
			...(edits ? { edits } : {}),
			closeMs,
			...(killedAtClose ? { killedAtClose: true } : {}),
			wallClockMs: Math.round(performance.now() - started) - closeMs,
			metrics: readMetrics(run.dbPath, label, workspaceFacts(task, edits)),
			...(agent.error === undefined ? {} : { error: agent.error }),
		};
	} catch (error) {
		return fail("harness_error", `scoring failed: ${String(error)}`, agent);
	}
}

interface Driven {
	readonly agent: PromptResult;
	/** How long pi took to exit after the agent settled. */
	readonly closeMs: number;
	/** Pi outlasted the close grace and was killed. */
	readonly killedAtClose: boolean;
}

/** Starts pi in the workspace, gives it the task's prompt, and closes it when the agent stops. */
async function driveAgent(run: RunContext, label: string, workdir: string): Promise<Driven> {
	const { options, task } = run;
	const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
	let pi: PiRpcProcess | undefined;
	let agent: PromptResult;
	let closeMs = 0;
	let killedAtClose = false;
	try {
		mkdirSync(join(options.runDir, "logs"), { recursive: true });
		pi = new PiRpcProcess({
			cliPath: options.piCliPath ?? DEFAULT_PI_CLI,
			cwd: workdir,
			args: [
				"-ne",
				"-ns",
				"-np",
				"-nc",
				"--no-themes",
				"--session-dir",
				join(options.runDir, "sessions", label),
				"-e",
				ADAPTER_ENTRY,
				...(options.model ? ["--model", options.model] : []),
				...(options.extraPiArgs ?? []),
			],
			env: {
				EXO_CONFIG: run.configPath,
				EXO_TRACE_LABEL: label,
				EXO_SHUTDOWN_DRAIN_MS: String(drainMs),
				...(options.piAgentDir ? { PI_CODING_AGENT_DIR: options.piAgentDir } : {}),
			},
			stderrPath: join(options.runDir, "logs", `${label}.stderr.log`),
			closeGraceMs: drainMs + CLOSE_MARGIN_MS,
		});
		agent = await pi.prompt(task.spec.prompt, {
			maxTurns: task.spec.maxTurns,
			timeoutMs: task.spec.timeoutSec * 1000,
			acceptSuggestions: true,
		});
	} finally {
		// The harness closes pi the moment the agent settles, which is when memory's background
		// calls may first run: the close waits for them (D-086), and that wait is not the run's time.
		const closing = performance.now();
		killedAtClose = (await pi?.close().catch(() => undefined))?.killed ?? false;
		closeMs = Math.round(performance.now() - closing);
	}
	if (killedAtClose) options.log?.(`  pi did not shut down within ${drainMs + CLOSE_MARGIN_MS} ms and was killed`);
	return { agent, closeMs, killedAtClose };
}

function guardLines(guard: GuardResult): string[] {
	return [
		guard.tamperedTests.length > 0 ? `restored tests the agent changed: ${guard.tamperedTests.join(", ")}` : "",
		guard.tamperedFiles.length > 0 ? `restored build files the agent changed: ${guard.tamperedFiles.join(", ")}` : "",
		guard.setAsideTests.length > 0 ? `set aside tests the agent added: ${guard.setAsideTests.join(", ")}` : "",
	].filter((line) => line !== "");
}

export interface Score {
	readonly success: boolean;
	readonly checkExitCode: number | null;
	readonly checkTimedOut: boolean;
	readonly checkTests: number | null;
	/** The check exited 0 but ran fewer tests than the task's `minTests`. */
	readonly tooFewTests: boolean;
	readonly guard: GuardResult;
	readonly output: string;
}

/**
 * Scores a finished workspace the same way for an agent's run and for the reference solution:
 * check guard, hidden overlay, the check, then the test-count floor. A check that times out is
 * run once more before it counts, so a slow machine does not fail a run; a second timeout is the
 * solution hanging, which is a failure of the task.
 */
export async function scoreWorkspace(task: Task, workdir: string, asideDir: string): Promise<Score> {
	const guard = applyCheckGuard(task, workdir, asideDir);
	applyHiddenOverlay(task, workdir);
	const timeoutMs = task.spec.checkTimeoutSec * 1000;
	let check = await runCheck(task.spec.check, workdir, timeoutMs);
	if (check.timedOut) check = await runCheck(task.spec.check, workdir, timeoutMs);
	const checkTests = countPassedTests(check.outputTail);
	const tooFewTests =
		check.exitCode === 0 && task.spec.minTests !== undefined && (checkTests ?? 0) < task.spec.minTests;
	return {
		success: check.exitCode === 0 && !tooFewTests,
		checkExitCode: check.exitCode,
		checkTimedOut: check.timedOut,
		checkTests,
		tooFewTests,
		guard,
		output: check.outputTail,
	};
}

/** What the harness knows about a run beyond its trace: the task's check and how the workspace ended up. */
export function workspaceFacts(task: Task | undefined, edits: WorkspaceEdits | undefined): WorkspaceFacts {
	return { ...(edits ? { edits } : {}), ...(task ? { checks: [task.spec.check] } : {}) };
}

/**
 * Metrics for one labelled run, computed from the run directory's trace; null when it left no
 * session. `workspace` is what the trace cannot say (see {@link workspaceFacts}).
 */
export function readMetrics(dbPath: string, label: string, workspace: WorkspaceFacts = {}): TraceMetrics | null {
	const store = openTraceStore({ path: dbPath });
	try {
		const sessions = store.sessions({ label });
		if (sessions.length === 0) return null;
		return computeTraceMetrics(
			sessions.flatMap((s) => store.events(s.id)),
			sessions.flatMap((s) => store.sidecarCalls(s.id)),
			workspace,
		);
	} finally {
		store.close();
	}
}

const TRIMMER_DIR = ".exo-trimmer";

/**
 * Writes `<runDir>/configs/<name>.json`: the named config with the trace redirected to this run's
 * DB and every module's on-disk state moved to a place only this config of this run uses.
 */
function writeRunConfig(
	options: EvalOptions,
	name: string,
	workRoot: string,
	dbPath: string,
	log: (line: string) => void,
): string {
	const source = join(options.configsDir, `${name}.jsonc`);
	const errors: ParseError[] = [];
	const parsed: unknown = parseJsonc(readFileSync(source, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0 || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${source}: invalid JSONC config`);
	}
	const config = parsed as Record<string, unknown>;
	// Machine-specific settings (which engine, how many slots) come from the user's global config,
	// so sidecars respect the real engine (D-038); the named config decides everything else.
	const machine = machineSettings(options.runDir, log);
	const merged = {
		...machine,
		...config,
		trace: { ...object(config["trace"]), enabled: true, dbPath },
		modules: isolatedModules(object(config["modules"]), options.runDir, workRoot, name),
	};
	const out = join(options.runDir, "configs", `${name}.json`);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(merged, null, 2));
	return out;
}

/**
 * No state shared between configs, or with the user's own (D-079). Set whether or not the config
 * names the module or its own path, so no arm can read what another wrote:
 * - memory learns across the repeats of one config (repeat 2 sees cards from repeat 1, brief §8
 *   Phase 5) in a card store under the run directory, never the user's real one;
 * - the trimmer saves full outputs per config under the work root. The agent is shown those
 *   paths, so they stay outside the repo like the workspaces do.
 */
function isolatedModules(
	modules: Record<string, unknown>,
	runDir: string,
	workRoot: string,
	name: string,
): Record<string, unknown> {
	return {
		...modules,
		memory: { ...object(modules["memory"]), dbPath: join(runDir, `memory-${name}.db`) },
		trimmer: { ...object(modules["trimmer"]), saveDir: join(workRoot, TRIMMER_DIR, name) },
	};
}

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function machineSettings(cwd: string, log: (line: string) => void): Record<string, unknown> {
	const loaded = loadConfig({ cwd, env: { ...process.env, EXO_CONFIG: undefined } });
	const global = loaded.sources[0];
	if (!global?.found) {
		log(`no global Exocortex config at ${global?.path ?? "~/.exocortex/config.jsonc"}: sidecars use the defaults`);
		return {};
	}
	if (loaded.problems.length > 0) {
		log(`global Exocortex config ignored (sidecars use the defaults): ${loaded.problems.join("; ")}`);
		return {};
	}
	return { engine: loaded.config.engine, pool: loaded.config.pool, embeddings: loaded.config.embeddings };
}

export interface ValidationResult {
	readonly taskId: string;
	readonly pristineFails: boolean;
	readonly solutionPasses: boolean | null;
	/** The reference solution changes test files the check guard protects: set `protectTests: false` or fix it. */
	readonly solutionEditsProtectedTests: boolean;
	/** Tests the solution's check ran and passed; null when its output has no count or there is no solution. */
	readonly solutionTests: number | null;
	readonly detail: string;
}

export function validationPasses(r: ValidationResult): boolean {
	return r.pristineFails && r.solutionPasses !== false && !r.solutionEditsProtectedTests;
}

/**
 * Fixture QA: the check must fail on the pristine repo and (when `solution.patch` exists) pass
 * once it is applied, both scored exactly as an agent's run is, check guard and test-count floor
 * included. With `record`, a task without `minTests` is handed the solution's count to write to
 * its `task.json`.
 */
export async function validateTasks(
	tasks: readonly Task[],
	scratchDir: string,
	record?: (task: Task, minTests: number) => void,
): Promise<ValidationResult[]> {
	const results: ValidationResult[] = [];
	for (const task of tasks) {
		const pristineDir = join(scratchDir, task.spec.id, "pristine");
		await prepareWorkspace(task, pristineDir);
		if (task.spec.setup) await runShell(task.spec.setup, pristineDir, task.spec.checkTimeoutSec * 1000);
		const pristine = await scoreWorkspace(task, pristineDir, asideDirOf(pristineDir));
		const pristineDetail =
			pristine.checkExitCode !== 0
				? ""
				: pristine.tooFewTests
					? "check passes without any change and only the test count fails it; "
					: "check passes without any change; ";
		const solution = task.solutionPatch
			? await validateSolution(task, task.solutionPatch, join(scratchDir, task.spec.id, "solved"), record)
			: { solutionPasses: null, solutionEditsProtectedTests: false, solutionTests: null, detail: "" };
		results.push({
			...solution,
			taskId: task.spec.id,
			// By its exit code: a fixture that only the test-count floor fails is not a failing fixture.
			pristineFails: pristine.checkExitCode !== 0,
			detail: (pristineDetail + solution.detail).trim(),
		});
	}
	rmSync(scratchDir, { recursive: true, force: true });
	return results;
}

/** Applies the reference solution and scores it under the same guard as the agent. */
async function validateSolution(
	task: Task,
	patch: string,
	solvedDir: string,
	record: ((task: Task, minTests: number) => void) | undefined,
): Promise<Pick<ValidationResult, "solutionPasses" | "solutionEditsProtectedTests" | "solutionTests" | "detail">> {
	await prepareWorkspace(task, solvedDir);
	await applyPatch(solvedDir, patch);
	if (task.spec.setup) await runShell(task.spec.setup, solvedDir, task.spec.checkTimeoutSec * 1000);
	const solved = await scoreWorkspace(task, solvedDir, asideDirOf(solvedDir));
	const edited = solved.guard.tamperedTests;
	const moved = [...solved.guard.tamperedFiles, ...solved.guard.setAsideTests];
	const details = [
		edited.length > 0 ? `solution.patch edits protected tests (${edited.join(", ")}); ` : "",
		moved.length > 0 ? `the check guard moved files the solution needs (${moved.join(", ")}); ` : "",
		solutionOutcome(task, solved, record),
	];
	return {
		solutionPasses: solved.success,
		solutionEditsProtectedTests: edited.length > 0,
		solutionTests: solved.checkTests,
		detail: details.join(""),
	};
}

/** What to say about the solution's check, recording its test count when the task has no floor yet. */
function solutionOutcome(
	task: Task,
	solved: Score,
	record: ((task: Task, minTests: number) => void) | undefined,
): string {
	if (solved.tooFewTests) {
		return `solution runs ${solved.checkTests ?? "no countable"} tests, fewer than minTests ${task.spec.minTests}; `;
	}
	if (!solved.success) return `solution fails: ${solved.output.slice(-600)}`;
	if (task.spec.minTests !== undefined || solved.checkTests === null || solved.checkTests === 0) return "";
	if (!record) return `no minTests (the solution runs ${solved.checkTests}: --record-tests writes it); `;
	record(task, solved.checkTests);
	return `recorded minTests ${solved.checkTests}; `;
}
