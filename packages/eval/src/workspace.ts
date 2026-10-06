import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { type CommandOutput, isTestPath, runProcess, runShellCommand } from "@exocortex/core";
import type { WorkspaceEdits } from "./metrics.ts";
import type { Task } from "./task.ts";

export type CommandResult = CommandOutput;
const GIT_ENV = {
	GIT_AUTHOR_NAME: "exo-eval",
	GIT_AUTHOR_EMAIL: "exo-eval@localhost",
	GIT_COMMITTER_NAME: "exo-eval",
	GIT_COMMITTER_EMAIL: "exo-eval@localhost",
};
/**
 * How much of a check's output is kept. The test count is read from it, so it has to hold the
 * whole output, not a tail: the largest fixture check (`go test -v` over 6000 subtests) prints
 * half a megabyte, and a count taken from a cut-off output would change with every extra line.
 */
const CHECK_TAIL_CHARS = 8_000_000;

/**
 * Copies the task's fixture repo into `workdir` and commits it as the baseline, so the agent's
 * changes are visible as a git diff. Fixtures are tiny; this is the only "isolation" eval needs
 * (D-013, D-014). Returns the baseline commit's id, for {@link workspaceEdits}.
 */
export async function prepareWorkspace(task: Task, workdir: string): Promise<string> {
	// A run that was killed leaves its workspace behind. Copying over it would keep the old run's
	// work, and an unchanged one fails the commit ("nothing to commit") for every run after it.
	rmSync(workdir, { recursive: true, force: true });
	mkdirSync(workdir, { recursive: true });
	cpSync(task.repoDir, workdir, { recursive: true });
	let output = "";
	for (const args of [
		["init", "-q", "-b", "main"],
		["add", "-A"],
		["commit", "-q", "--no-gpg-sign", "-m", "fixture baseline"],
		["rev-parse", "HEAD"],
	]) {
		const result = await runCommand("git", args, { cwd: workdir, timeoutMs: 30_000, env: GIT_ENV });
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.outputTail}`);
		output = result.outputTail;
	}
	return output.trim();
}

/** A list of paths can be long (an agent that vendored a dependency); a cut-off one would be a wrong one. */
const PATHS_TAIL_CHARS = 4_000_000;

/**
 * How the workspace now differs from its baseline commit (D-086): every file changed, added or
 * deleted since, by whatever means, and when the newest of them was written. Commits the agent
 * made are looked through (the comparison is against the baseline, not `HEAD`), files the
 * fixture's `.gitignore` names and build output are left out, and a file put back as it was is
 * not a change. Undefined when the repository cannot answer (the agent removed `.git`): the
 * caller then knows only what the trace says.
 *
 * Call it before the check guard, which restores files and so rewrites their times.
 */
export async function workspaceEdits(workdir: string, baseline: string): Promise<WorkspaceEdits | undefined> {
	const git = async (args: readonly string[]) => {
		const result = await runProcess("git", args, { cwd: workdir, timeoutMs: 30_000, tailChars: PATHS_TAIL_CHARS });
		return result.exitCode === 0 ? result.outputTail : undefined;
	};
	const changed = await git(["diff", "--name-only", "--no-renames", "-z", baseline, "--"]);
	const added = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
	if (changed === undefined || added === undefined) return undefined;
	const files = [...new Set(`${changed}\0${added}`.split("\0"))]
		.filter((path) => path !== "" && !path.split("/").some((part) => SKIPPED_DIRS.has(part)))
		.sort();
	let lastEditMs: number | null = null;
	for (const path of files) {
		try {
			lastEditMs = Math.max(lastEditMs ?? 0, lstatSync(join(workdir, path)).mtimeMs);
		} catch {
			// Deleted: a change with no time of its own.
		}
	}
	return { files, lastEditMs };
}

/** Copies the task's hidden acceptance files over the workspace (overwriting same-named files). */
export function applyHiddenOverlay(task: Task, workdir: string): void {
	if (task.hiddenDir) cpSync(task.hiddenDir, workdir, { recursive: true, force: true });
}

export interface GuardResult {
	/** Fixture test files the agent had changed or removed, now restored. */
	readonly tamperedTests: string[];
	/** Protected build and runner files the agent had changed, removed or added, now restored or set aside. */
	readonly tamperedFiles: string[];
	/** Test files the agent added, moved to the aside directory. */
	readonly setAsideTests: string[];
}

/** Directories the agent's tools fill and no check reads tests from. */
const SKIPPED_DIRS = new Set([
	".git",
	"target",
	"build",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	".pytest_cache",
	".mypy_cache",
]);

/**
 * Check guard (research R7.4, D-048, D-079): makes the check test the agent's work and nothing
 * else. Before the hidden overlay and the check it
 * - restores the fixture's test files (unless `protectTests` is off), so editing, skipping or
 *   deleting a test cannot pass;
 * - restores the task's `protect` files (build and runner configuration), so a rewritten `test`
 *   target or `autotests = false` cannot pass, and sets aside ones the agent added (a new
 *   `conftest.py`, a nested `go.mod`);
 * - moves test files the agent added into `asideDir`, so a wrong one cannot fail a correct
 *   solution, one that collides with a hidden test cannot break the build, and a `TestMain` that
 *   exits 0 cannot stand in for the tests.
 *
 * A path the reference solution itself touches is left alone (tests excepted: a solution that
 * edits protected tests is a fixture bug `--validate` reports), so the guard can never fail the
 * solution. Rust files under `src/` are left too: they are modules of the crate, and removing one
 * breaks the build.
 */
export function applyCheckGuard(task: Task, workdir: string, asideDir: string): GuardResult {
	const result: GuardResult = { tamperedTests: [], tamperedFiles: [], setAsideTests: [] };
	const names = new Set(task.spec.protect.filter((entry) => !entry.includes("/")));
	const paths = new Set(task.spec.protect.filter((entry) => entry.includes("/")));
	const protectedFile = (path: string) =>
		(names.has(basename(path)) || paths.has(path)) && !task.solutionPaths.has(path);
	const protectedTest = (path: string) => task.spec.protectTests && isTestPath(path);

	const fixture = new Set<string>();
	for (const file of listFiles(task.repoDir, new Set())) {
		const path = relative(task.repoDir, file);
		fixture.add(path);
		const test = protectedTest(path);
		if (!test && !protectedFile(path)) continue;
		const target = join(workdir, path);
		if (sameFile(target, readFileSync(file))) continue;
		(test ? result.tamperedTests : result.tamperedFiles).push(path);
		rmSync(target, { recursive: true, force: true });
		mkdirSync(dirname(target), { recursive: true });
		cpSync(file, target, { force: true });
	}

	for (const file of listFiles(workdir, SKIPPED_DIRS)) {
		const path = relative(workdir, file);
		if (fixture.has(path) || task.solutionPaths.has(path)) continue;
		const test = protectedTest(path) && !inCrateRust(path);
		if (!test && !protectedFile(path)) continue;
		(test ? result.setAsideTests : result.tamperedFiles).push(path);
		const target = join(asideDir, path);
		mkdirSync(dirname(target), { recursive: true });
		rmSync(target, { recursive: true, force: true });
		renameSync(file, target);
	}
	return result;
}

/** A Rust file compiled into the crate (`mod tests;`), as opposed to an integration test under `tests/`. */
function inCrateRust(path: string): boolean {
	return path.endsWith(".rs") && /(^|\/)src\//.test(path);
}

/** Whether `path` is a regular file (or a link to one) with exactly these bytes. */
function sameFile(path: string, expected: Buffer): boolean {
	try {
		return readFileSync(path).equals(expected);
	} catch {
		// Missing, a directory, or a dangling link: not the fixture's file.
		return false;
	}
}

/** Every file under `dir`, not following links, and not entering directories named in `skip`. */
function listFiles(dir: string, skip: ReadonlySet<string>): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (!lstatSync(path).isDirectory()) return [path];
		return skip.has(name) ? [] : listFiles(path, skip);
	});
}

export async function applyPatch(workdir: string, patchPath: string): Promise<void> {
	const result = await runCommand("git", ["apply", "--whitespace=nowarn", patchPath], {
		cwd: workdir,
		timeoutMs: 30_000,
	});
	if (result.exitCode !== 0) throw new Error(`git apply ${patchPath} failed: ${result.outputTail}`);
}

export function runShell(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
	return runShellCommand(command, { cwd, timeoutMs });
}

/** Runs a task's check, keeping enough output to count the tests it ran. */
export function runCheck(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
	return runShellCommand(command, { cwd, timeoutMs, tailChars: CHECK_TAIL_CHARS });
}

function runCommand(
	command: string,
	args: readonly string[],
	options: { readonly cwd: string; readonly timeoutMs: number; readonly env?: Readonly<Record<string, string>> },
): Promise<CommandResult> {
	return runProcess(command, args, options);
}
