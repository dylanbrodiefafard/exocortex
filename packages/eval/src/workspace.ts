import { cpSync, mkdirSync } from "node:fs";
import { type CommandOutput, runProcess, runShellCommand } from "@exocortex/core";
import type { Task } from "./task.ts";

export type CommandResult = CommandOutput;
const GIT_ENV = {
	GIT_AUTHOR_NAME: "exo-eval",
	GIT_AUTHOR_EMAIL: "exo-eval@localhost",
	GIT_COMMITTER_NAME: "exo-eval",
	GIT_COMMITTER_EMAIL: "exo-eval@localhost",
};

/**
 * Copies the task's fixture repo into `workdir` and commits it as the baseline, so the agent's
 * changes are visible as a git diff. Fixtures are tiny; this is the only "isolation" eval needs
 * (D-013, D-014).
 */
export async function prepareWorkspace(task: Task, workdir: string): Promise<void> {
	mkdirSync(workdir, { recursive: true });
	cpSync(task.repoDir, workdir, { recursive: true });
	for (const args of [
		["init", "-q", "-b", "main"],
		["add", "-A"],
		["commit", "-q", "--no-gpg-sign", "-m", "fixture baseline"],
	]) {
		const result = await runCommand("git", args, { cwd: workdir, timeoutMs: 30_000, env: GIT_ENV });
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.outputTail}`);
	}
}

/** Copies the task's hidden acceptance files over the workspace (overwriting same-named files). */
export function applyHiddenOverlay(task: Task, workdir: string): void {
	if (task.hiddenDir) cpSync(task.hiddenDir, workdir, { recursive: true, force: true });
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

function runCommand(
	command: string,
	args: readonly string[],
	options: { readonly cwd: string; readonly timeoutMs: number; readonly env?: Readonly<Record<string, string>> },
): Promise<CommandResult> {
	return runProcess(command, args, options);
}
