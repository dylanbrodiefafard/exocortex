import { type FileEdit, fileEdits, outcomeOf, type ToolOutcome } from "@exocortex/core";
import { anchorOf, cardDetail, failureOf, identity, problemKey } from "./detail.ts";
import { repoPath } from "./paths.ts";
import { problemIn } from "./problem.ts";
import { covers, type Run, runOf } from "./runs.ts";
import { shellEffect } from "./shell-effects.ts";
import { oneLine } from "./text.ts";

/**
 * A verified error→fix pair (research R5.1/R5.2, D-109): a test or build run failed, files
 * changed, and a run of the same runner that covers the failure passed. `steps` is the route from
 * this error to the pass (D-072): the error, the edits made while it stood, and any error the
 * runner failed with after them.
 *
 * The pass is evidence, not proof, that the edits were the fix: the episode also carries what
 * else happened on the way, for the admission check and the lesson sidecar to read (`admission.ts`).
 */
export interface FixEpisode {
	/** The run that failed, as the agent wrote it. */
	readonly command: string;
	/** The run that passed. */
	readonly passCommand: string;
	readonly signature: string;
	readonly errorLine: string;
	/** The names the failure mentioned: which problem of this kind it was. */
	readonly detail: readonly string[];
	readonly steps: readonly Step[];
	/** Shell commands run on the way that changed files of the repo, or whose effect cannot be told. */
	readonly shell: readonly ShellNote[];
	/** A git command run on the way that put other code in place: the pass is its doing. */
	readonly replacedBy?: string;
	/**
	 * Files edited on the way after which the same error came back, and not edited again after
	 * that. They may still be part of the fix, but they did not fix it on their own.
	 */
	readonly deadEnds: readonly string[];
}

/** A shell command run on the way to a pass, for the lesson sidecar to weigh. */
interface ShellNote {
	readonly line: string;
	/** It wrote to files of the repo (a formatter, a delete, a redirect), as far as its words say. */
	readonly changes: boolean;
}

/** One error on the way to the pass, and what was edited while the runner failed with it. */
interface Step {
	readonly errorLine: string;
	/** The failing output around the error. */
	readonly excerpt: string;
	/** The latest edits made while it stood, with paths inside the repo. */
	readonly edits: readonly Edit[];
	/** Times the runner failed with this same error again after edits. */
	readonly retries: number;
}

export type Edit = FileEdit;

interface Stage {
	readonly command: string;
	readonly signature: string;
	readonly errorLine: string;
	readonly detail: readonly string[];
	/** What the failure is named by: a pass that names it covers it (D-109). */
	readonly named: readonly string[];
	/** What the failing run was narrowed to. */
	readonly filters: readonly string[];
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
	readonly shell: ShellNote[];
	replacedBy: string | undefined;
}

interface OpenRunner {
	readonly stages: Stage[];
	/** The tracker's count of steps (edits and runs) when the runner last ran. */
	lastRun: number;
}

const MAX_STAGES = 4;
const MAX_EDITS_PER_STAGE = 8;
const EDIT_TEXT_CHARS = 1_200;
const EXCERPT_LINES = 20;
const MAX_SHELL_COMMANDS = 6;
/**
 * A failing runner the agent has not run again for this many edits and test or build runs is no
 * longer being fixed: the agent moved on, and a pass much later says nothing about the edits in
 * between. Reads, searches and messages do not count: a long look around is part of a fix.
 */
const MAX_STEPS_BETWEEN_RUNS = 40;

export interface TrackerOptions {
	/** Edits and redirects outside it are not part of a fix here. */
	readonly cwd: string;
	/** The share of a problem's names a failure must repeat to be that problem again (D-072). */
	readonly minDetail: number;
}

/**
 * Watches tool results for error→fix pairs. Only a failing test or build run followed by edits
 * and then a pass of the same runner that covers it counts (D-109): the pass is the external
 * signal (never the model's opinion). The user's messages do not end what is being fixed: a fix
 * that spans a question to the user is still one fix. Staleness does.
 *
 * When the error changes before the runner passes, the earlier error is kept: the pass shows
 * that the edits made since it, taken together, fixed it. A pass then gives one episode for the
 * first error (what a fresh attempt meets first, with every edit since) and one for the last
 * (with the edits that finished the job), each when the pass covers it. "The error changed" means
 * another problem (M3): another key, or the same key naming other things (another test).
 */
export function createEpisodeTracker(options: TrackerOptions): { observe(tool: ToolOutcome): FixEpisode[] } {
	const open = new Map<string, OpenRunner>();
	let steps = 0;

	function onFailure(run: Run, command: string, tool: ToolOutcome): void {
		const entry = open.get(run.runner) ?? { stages: [], lastRun: steps };
		entry.lastRun = steps;
		open.set(run.runner, entry);
		const { stages } = entry;
		const last = stages.at(-1);
		if (last && problemIn(last, failureOf(tool.toolName, tool.output), options.minDetail)) {
			// The same problem again: keep collecting edits.
			if (last.edited > last.editedAtLastFailure) last.retries += 1;
			last.editedAtLastFailure = last.edited;
			for (const path of last.sinceFailure) last.deadEnds.add(path);
			last.sinceFailure.clear();
			return;
		}
		// No line says what failed (only a summary was left, `| tail` cut the rest): nothing to tell
		// it by, and nothing to learn from. What is open stays open.
		const anchor = anchorOf(tool.output);
		if (!anchor) return;
		// An error that changed with nothing edited was not fixed by anything: it is replaced.
		if (last && last.edited === 0) stages.pop();
		if (stages.length === MAX_STAGES) return;
		stages.push({
			command,
			signature: problemKey(tool.toolName, anchor.line),
			errorLine: anchor.line,
			detail: cardDetail(tool.output, anchor.index),
			named: identity(tool.output, anchor.index),
			filters: run.filters,
			excerpt: excerptAround(tool.output, anchor.index),
			edits: [],
			edited: 0,
			retries: 0,
			editedAtLastFailure: 0,
			sinceFailure: new Set(),
			deadEnds: new Set(),
			shell: [],
			replacedBy: undefined,
		});
	}

	function onPass(run: Run, command: string, tool: ToolOutcome): FixEpisode[] {
		const entry = open.get(run.runner);
		if (!entry) return [];
		const stages = entry.stages.filter((stage) => stage.edited > 0);
		const last = stages.at(-1);
		const text = `${command}\n${tool.output}`;
		const covered = (stage: Stage) => covers({ runner: run.runner, ...stage }, run, text, options.minDetail);
		// The problem worked on last is what a pass must cover; one that does not ran other tests.
		if (!last || !covered(last)) {
			// A whole run passed: whatever failed before passes now, edited or not.
			if (run.filters.length === 0) open.delete(run.runner);
			return [];
		}
		open.delete(run.runner);
		const first = stages[0];
		const starts = first && first !== last && covered(first) ? [0, stages.length - 1] : [stages.length - 1];
		return starts.flatMap((start) => {
			const stage = stages[start];
			if (!stage) return [];
			const route = stages.slice(start);
			return [
				{
					command: stage.command,
					passCommand: command,
					signature: stage.signature,
					errorLine: stage.errorLine,
					detail: stage.detail,
					steps: route.map(({ errorLine, excerpt, edits, retries }) => ({
						errorLine,
						excerpt,
						edits: [...edits],
						retries,
					})),
					// What ran since this stage opened ran on the way from its error to the pass.
					shell: [...stage.shell],
					deadEnds: deadEndsOf(route),
					...(stage.replacedBy === undefined ? {} : { replacedBy: stage.replacedBy }),
				},
			];
		});
	}

	/** What a shell command did between a failure and the pass, noted on every error still open. */
	function noteShell(line: string): void {
		const effect = shellEffect(line, options.cwd);
		if (effect === "reads") return;
		const shown = oneLine(line, 200);
		for (const { stages } of open.values()) {
			for (const stage of stages) {
				if (effect === "replaces") stage.replacedBy ??= shown;
				else if (stage.shell.length < MAX_SHELL_COMMANDS && !stage.shell.some((note) => note.line === shown)) {
					stage.shell.push({ line: shown, changes: effect === "changes" });
				}
			}
		}
	}

	function onCommand(tool: ToolOutcome): FixEpisode[] {
		const line = tool.input["command"];
		if (typeof line !== "string") return [];
		// Before this result opens or closes anything: it ran on the way to every pass still awaited.
		noteShell(line);
		const run = runOf(line, options.cwd);
		if (!run?.verifying) return [];
		steps += 1;
		const command = oneLine(line, 300);
		// A run behind a pipe is read from its output (D-075); one that cannot be read proves nothing.
		const outcome = outcomeOf(tool);
		if (outcome === "failed") onFailure(run, command, tool);
		return outcome === "passed" ? onPass(run, command, tool) : [];
	}

	return {
		observe(tool) {
			for (const [runner, entry] of open) {
				if (steps - entry.lastRun > MAX_STEPS_BETWEEN_RUNS) open.delete(runner);
			}
			const edits = editsInside(tool, options.cwd);
			if (!edits) return onCommand(tool);
			if (edits.length === 0) return [];
			steps += 1;
			for (const { stages } of open.values()) {
				const stage = stages.at(-1);
				if (stage) addEdits(stage, edits);
			}
			return [];
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

function excerptAround(output: string, index: number): string {
	const lines = output.split("\n");
	return lines
		.slice(Math.max(0, index - 1), index - 1 + EXCERPT_LINES)
		.map((l) => l.slice(0, 300))
		.join("\n");
}
