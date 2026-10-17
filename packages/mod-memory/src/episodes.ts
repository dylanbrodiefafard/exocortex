import {
	errorSignature,
	type FileEdit,
	fileEdits,
	firstErrorLine,
	outcomeOf,
	type ToolOutcome,
	verifyingRun,
} from "@exocortex/core";
import { cardDetail, FAILURE_DETAIL_LINES, failureDetail } from "./detail.ts";
import { repoPath } from "./paths.ts";
import { problemIn } from "./problem.ts";
import { shellEffect } from "./shell-effects.ts";
import { oneLine } from "./text.ts";

/**
 * A verified error→fix pair (research R5.1/R5.2): a command failed, files changed, the same
 * command passed. `steps` is the route from this error to the pass (D-072): the error, the edits
 * made while it stood, and any error the command failed with after them.
 *
 * The pass is evidence, not proof, that the edits were the fix: the episode also carries what
 * else happened on the way, for the admission check to read (`admission.ts`).
 */
export interface FixEpisode {
	readonly command: string;
	readonly signature: string;
	readonly errorLine: string;
	/** The names the failure mentioned: which problem of this kind it was. */
	readonly detail: readonly string[];
	readonly steps: readonly Step[];
	/** Shell commands run on the way whose effect on the files cannot be told (a script, a generator). */
	readonly shell: readonly string[];
	/** A shell command run on the way that changed files: the pass may be its doing, not the edits'. */
	readonly changedBy?: string;
	/**
	 * Files edited on the way after which the same error came back, and not edited again after
	 * that. They may still be part of the fix, but they did not fix it on their own.
	 */
	readonly deadEnds: readonly string[];
}

/** One error on the way to the pass, and what was edited while the command failed with it. */
interface Step {
	readonly errorLine: string;
	/** The failing output around the first error. */
	readonly excerpt: string;
	/** The latest edits made while it stood, with paths inside the repo. */
	readonly edits: readonly Edit[];
	/** Times the command failed with this same error again after edits. */
	readonly retries: number;
}

export type Edit = FileEdit;

interface Stage {
	readonly signature: string;
	readonly errorLine: string;
	readonly detail: readonly string[];
	readonly excerpt: string;
	readonly edits: Edit[];
	/** Every edit made while it stood, including those the cap dropped. */
	edited: number;
	retries: number;
	editedAtLastFailure: number;
	/** Files edited since this error was last seen. */
	readonly sinceFailure: Set<string>;
	/** Files edited before this same error came back. */
	readonly deadEnds: Set<string>;
	readonly shell: string[];
	changedBy: string | undefined;
}

interface OpenCommand {
	readonly stages: Stage[];
	/** The tracker's count of tool results when the command last ran. */
	lastRun: number;
}

/** Commands whose success is external evidence that a fix worked: builds, tests, runs. */
const VERIFYING_COMMAND =
	/\b(pytest|unittest|python3?|cargo|go (test|build|vet|run)|ctest|make\b|cmake|g\+\+|clang\+\+|gcc|npm|npx|node|tsc|tox|\.\/\S+)/;
const MAX_STAGES = 4;
const MAX_EDITS_PER_STAGE = 8;
const EDIT_TEXT_CHARS = 1_200;
const EXCERPT_LINES = 20;
const MAX_SHELL_COMMANDS = 6;
/**
 * A failing command the agent has not run again for this many tool calls is no longer being
 * fixed: the agent moved on, and a pass much later says nothing about the edits in between.
 */
const MAX_CALLS_BETWEEN_RUNS = 60;

export interface TrackerOptions {
	/** Edits and redirects outside it are not part of a fix here. */
	readonly cwd: string;
	/** The share of a problem's names a failure must repeat to be that problem again (D-072). */
	readonly minDetail: number;
}

/**
 * Watches tool results for error→fix pairs. Only a failure followed by edits and then a success
 * of the *same* command counts: the success is the external signal (never the model's opinion).
 *
 * When the error changes before the command passes, the earlier error is kept: the pass shows
 * that the edits made since it, taken together, fixed it. A pass then gives one episode for the
 * first error (what a fresh attempt meets first, with every edit since) and one for the last
 * (with the edits that finished the job). "The error changed" means another problem (M3): another
 * kind of failure, or the same kind naming other things (another test).
 */
export function createEpisodeTracker(options: TrackerOptions): {
	observe(tool: ToolOutcome): FixEpisode[];
	reset(): void;
} {
	const open = new Map<string, OpenCommand>();
	let calls = 0;

	function onFailure(command: string, tool: ToolOutcome): void {
		const entry = open.get(command) ?? { stages: [], lastRun: calls };
		entry.lastRun = calls;
		const { stages } = entry;
		const last = stages.at(-1);
		const signature = errorSignature(tool.toolName, tool.exitCode, tool.output);
		const names = new Set(failureDetail(tool.output, FAILURE_DETAIL_LINES));
		if (last && problemIn(last, signature, names, options.minDetail)) {
			// The same problem again: keep collecting edits.
			if (last.edited > last.editedAtLastFailure) last.retries += 1;
			last.editedAtLastFailure = last.edited;
			for (const path of last.sinceFailure) last.deadEnds.add(path);
			last.sinceFailure.clear();
			return;
		}
		const first = firstErrorLine(tool.output);
		if (!first) {
			open.delete(command);
			return;
		}
		// An error that changed with nothing edited was not fixed by anything: it is replaced.
		if (last && last.edited === 0) stages.pop();
		if (stages.length === MAX_STAGES) return;
		stages.push({
			signature,
			errorLine: first.line,
			detail: cardDetail(tool.output),
			excerpt: excerptAround(tool.output, first.index),
			edits: [],
			edited: 0,
			retries: 0,
			editedAtLastFailure: 0,
			sinceFailure: new Set(),
			deadEnds: new Set(),
			shell: [],
			changedBy: undefined,
		});
		open.set(command, entry);
	}

	function onSuccess(command: string): FixEpisode[] {
		const stages = (open.get(command)?.stages ?? []).filter((stage) => stage.edited > 0);
		open.delete(command);
		const starts = stages.length > 1 ? [0, stages.length - 1] : stages.length === 1 ? [0] : [];
		return starts.flatMap((start) => {
			const stage = stages[start];
			if (!stage) return [];
			const route = stages.slice(start);
			const steps = route.map(({ errorLine, excerpt, edits, retries }) => ({
				errorLine,
				excerpt,
				edits: [...edits],
				retries,
			}));
			return [
				{
					command,
					signature: stage.signature,
					errorLine: stage.errorLine,
					detail: stage.detail,
					steps,
					// What ran since this stage opened ran on the way from its error to the pass.
					shell: [...stage.shell],
					deadEnds: deadEndsOf(route),
					...(stage.changedBy === undefined ? {} : { changedBy: stage.changedBy }),
				},
			];
		});
	}

	/** What a shell command did between a failure and the pass, noted on every error still open. */
	function noteShell(line: string, command: string): void {
		const effect = shellEffect(line, options.cwd);
		if (effect === "reads") return;
		const shown = oneLine(line, 200);
		for (const [key, { stages }] of open) {
			for (const stage of stages) {
				if (effect === "changes") stage.changedBy ??= shown;
				// The command being fixed is on its own route already.
				else if (key !== command && stage.shell.length < MAX_SHELL_COMMANDS && !stage.shell.includes(shown)) {
					stage.shell.push(shown);
				}
			}
		}
	}

	function onCommand(tool: ToolOutcome): FixEpisode[] {
		const line = tool.input["command"];
		const command = commandKey(tool);
		if (typeof line !== "string" || !command) return [];
		// Before this result opens or closes anything: it ran on the way to every pass still awaited.
		noteShell(line, command);
		if (!VERIFYING_COMMAND.test(command)) return [];
		// A run behind a pipe is read from its output (D-075); one that cannot be read proves nothing.
		const outcome = outcomeOf(tool);
		if (outcome === "failed") onFailure(command, tool);
		return outcome === "passed" ? onSuccess(command) : [];
	}

	return {
		observe(tool) {
			calls += 1;
			for (const [command, entry] of open) {
				if (calls - entry.lastRun > MAX_CALLS_BETWEEN_RUNS) open.delete(command);
			}
			const edits = editsInside(tool, options.cwd);
			if (!edits) return onCommand(tool);
			for (const { stages } of open.values()) {
				const stage = stages.at(-1);
				if (stage) addEdits(stage, edits);
			}
			return [];
		},
		reset() {
			open.clear();
		},
	};
}

/** A file tool's edits to files of the repo; undefined for any other tool call. */
function editsInside(tool: ToolOutcome, cwd: string): Edit[] | undefined {
	return fileEdits(tool, EDIT_TEXT_CHARS)?.flatMap((edit) => {
		const path = repoPath(cwd, edit.path);
		return path === undefined ? [] : [{ ...edit, path }];
	});
}

/**
 * Adds edits to a stage, keeping the latest {@link MAX_EDITS_PER_STAGE} (M11): the fix is what was
 * in place at the pass. An edit to a file that was edited again later goes first, so that every
 * file touched keeps its last edit for as long as there is room.
 */
function addEdits(stage: Stage, edits: readonly Edit[]): void {
	stage.edits.push(...edits);
	for (const edit of edits) stage.sinceFailure.add(edit.path);
	stage.edited += edits.length;
	while (stage.edits.length > MAX_EDITS_PER_STAGE) {
		const superseded = stage.edits.findIndex((edit, i) =>
			stage.edits.some((later, j) => j > i && later.path === edit.path),
		);
		stage.edits.splice(Math.max(superseded, 0), 1);
	}
}

/**
 * Files edited before the same error came back, less those edited again after its last return:
 * a later edit to one may be what fixed it.
 */
function deadEndsOf(route: readonly Stage[]): string[] {
	const fixed = new Set(route.flatMap((stage) => [...stage.sinceFailure]));
	return [...new Set(route.flatMap((stage) => [...stage.deadEnds]))].filter((path) => !fixed.has(path));
}

/** Every edit on the route, in order. */
export function editsOf(episode: FixEpisode): Edit[] {
	return episode.steps.flatMap((step) => step.edits);
}

/**
 * One command, however its output was redirected or cut: `cargo test`, `cargo test 2>&1` and
 * `cargo test 2>&1 | tail -30` are the same run.
 */
export function commandKey(tool: ToolOutcome): string | undefined {
	const line = tool.input["command"];
	if (typeof line !== "string") return undefined;
	// What a test or build run is piped into shapes its output, not what ran.
	const command = verifyingRun(line)?.unpiped ?? line;
	return command
		.replace(/\s*2>&1/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
}

function excerptAround(output: string, index: number): string {
	const lines = output.split("\n");
	return lines
		.slice(Math.max(0, index - 1), index - 1 + EXCERPT_LINES)
		.map((l) => l.slice(0, 300))
		.join("\n");
}
