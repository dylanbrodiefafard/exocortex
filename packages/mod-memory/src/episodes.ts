import {
	errorSignature,
	type FileEdit,
	fileEdits,
	firstErrorLine,
	outcomeOf,
	type ToolOutcome,
	verifyingRun,
} from "@exocortex/core";
import { cardDetail } from "./detail.ts";

/**
 * A verified error→fix pair (research R5.1/R5.2): a command failed, files changed, the same
 * command passed. `steps` is the route from this error to the pass (D-072): the error, the edits
 * made while it stood, and any error the command failed with after them.
 */
export interface FixEpisode {
	readonly command: string;
	readonly signature: string;
	readonly errorLine: string;
	/** The names the failure mentioned: which problem of this kind it was. */
	readonly detail: readonly string[];
	readonly steps: readonly Step[];
}

/** One error on the way to the pass, and what was edited while the command failed with it. */
interface Step {
	readonly errorLine: string;
	/** The failing output around the first error. */
	readonly excerpt: string;
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
	retries: number;
	editsAtLastFailure: number;
}

/** Commands whose success is external evidence that a fix worked: builds, tests, runs. */
const VERIFYING_COMMAND =
	/\b(pytest|unittest|python3?|cargo|go (test|build|vet|run)|ctest|make\b|cmake|g\+\+|clang\+\+|gcc|npm|npx|node|tsc|tox|\.\/\S+)/;
const MAX_STAGES = 4;
const MAX_EDITS_PER_STAGE = 8;
const EDIT_TEXT_CHARS = 1_200;
const EXCERPT_LINES = 20;

/**
 * Watches tool results for error→fix pairs. Only a failure followed by edits and then a success
 * of the *same* command counts: the success is the external signal (never the model's opinion).
 *
 * When the error changes before the command passes, the earlier error is kept: the pass shows
 * that the edits made since it, taken together, fixed it. A pass then gives one episode for the
 * first error (what a fresh attempt meets first, with every edit since) and one for the last
 * (with the edits that finished the job).
 */
export function createEpisodeTracker(): { observe(tool: ToolOutcome): FixEpisode[]; reset(): void } {
	const open = new Map<string, Stage[]>();

	function onFailure(command: string, tool: ToolOutcome): void {
		const stages = open.get(command) ?? [];
		const last = stages.at(-1);
		const signature = errorSignature(tool.toolName, tool.exitCode, tool.output);
		if (last?.signature === signature) {
			// The same error again: keep collecting edits.
			if (last.edits.length > last.editsAtLastFailure) last.retries += 1;
			last.editsAtLastFailure = last.edits.length;
			return;
		}
		const first = firstErrorLine(tool.output);
		if (!first) {
			open.delete(command);
			return;
		}
		// An error that changed with nothing edited was not fixed by anything: it is replaced.
		if (last && last.edits.length === 0) stages.pop();
		if (stages.length === MAX_STAGES) return;
		stages.push({
			signature,
			errorLine: first.line,
			detail: cardDetail(tool.output),
			excerpt: excerptAround(tool.output, first.index),
			edits: [],
			retries: 0,
			editsAtLastFailure: 0,
		});
		open.set(command, stages);
	}

	function onSuccess(command: string): FixEpisode[] {
		const stages = (open.get(command) ?? []).filter((stage) => stage.edits.length > 0);
		open.delete(command);
		const starts = stages.length > 1 ? [0, stages.length - 1] : stages.length === 1 ? [0] : [];
		return starts.flatMap((start) => {
			const stage = stages[start];
			if (!stage) return [];
			const steps = stages.slice(start).map(({ errorLine, excerpt, edits, retries }) => ({
				errorLine,
				excerpt,
				edits: [...edits],
				retries,
			}));
			return [{ command, signature: stage.signature, errorLine: stage.errorLine, detail: stage.detail, steps }];
		});
	}

	return {
		observe(tool) {
			const edits = fileEdits(tool, EDIT_TEXT_CHARS);
			if (edits) {
				for (const stages of open.values()) {
					const stage = stages.at(-1);
					if (stage && stage.edits.length < MAX_EDITS_PER_STAGE) stage.edits.push(...edits);
				}
				return [];
			}
			const command = commandKey(tool);
			if (!command || !VERIFYING_COMMAND.test(command)) return [];
			// A run behind a pipe is read from its output (D-075); one that cannot be read proves nothing.
			const outcome = outcomeOf(tool);
			if (outcome === "failed") onFailure(command, tool);
			return outcome === "passed" ? onSuccess(command) : [];
		},
		reset() {
			open.clear();
		},
	};
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
