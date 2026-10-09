import { createHash } from "node:crypto";
import { type CommandOutput, isTestPath, outcomeOf, type RunOptions, type ToolOutcome } from "@exocortex/core";
import { checkOutcome } from "./checks.ts";
import { diffHeaderPath, testRunNotes } from "./signals.ts";

export interface CheckResult {
	readonly command: string;
	readonly output: CommandOutput;
	/** Who named the command: the user's config or the user's request (D-011). */
	readonly source: "config" | "request";
}

export interface EvidenceInput {
	/** `git diff --stat <start>`, or undefined outside a git repo. */
	readonly diffStat: string | undefined;
	/** `git diff <start>` plus new files as diffs (may be long; cut per file here). */
	readonly diff: string | undefined;
	/** Files git does not track yet, all of them. */
	readonly untracked: readonly string[];
	/** How many of those have no content in `diff` (too many to show, or not readable as text). */
	readonly newFilesNotShown?: number;
	readonly tools: readonly ToolOutcome[];
	/** Whether the workspace differs from what it was after the agent's last full test run, when known. */
	readonly changedSinceTests?: boolean;
	readonly checks: readonly CheckResult[];
	/** Deterministic warning signs (research R1.2), shown first. */
	readonly warnings?: readonly string[];
	/** The user's own check commands, which count as test runs among the agent's commands. */
	readonly runs?: RunOptions;
	readonly maxChars: number;
}

/** The evidence as the judge reads it, and the lines of it that can show an item is done. */
export interface Evidence {
	readonly text: string;
	/**
	 * Lines a `met` item may quote (D-084): an added or removed line of the diff, a line a check
	 * command printed, or a command line with its exit code. Not the summary of changed files, the
	 * warnings, the notes or anything the agent said: those show that something happened, not what.
	 */
	readonly quotable: readonly string[];
}

const RECENT_COMMANDS = 10;
const COMMAND_CHARS = 200;
const FAILED_OUTPUT_CHARS = 2_000;
const CHECK_OUTPUT_CHARS = 4_000;
/** Room kept for the "more lines not shown" note under a file's cut diff. */
const DIFF_CUT_NOTE_CHARS = 60;
/** New files listed by name; the rest are counted. */
const MAX_NEW_FILE_NAMES = 30;

/** One check command's result. A check that did not finish is not a failing one. */
function checkLines(check: CheckResult): { readonly header: string; readonly output: string } {
	const { output } = check;
	const shown = tail(output.outputTail, CHECK_OUTPUT_CHARS);
	if (checkOutcome(output) !== "inconclusive") return { header: `exit code: ${output.exitCode}`, output: shown };
	const why = output.timedOut ? `timed out after ${Math.round(output.durationMs / 1000)} s` : "it was interrupted";
	return { header: `did not finish (${why}): this shows nothing either way`, output: shown };
}

/** The check commands just run, with what each printed. */
function checksSection(checks: readonly CheckResult[], quotable: string[]): string {
	if (checks.length === 0) return "";
	return [
		"## Check commands (run just now)",
		...checks.map((check) => {
			const { header, output } = checkLines(check);
			quotable.push(`$ ${check.command}`);
			// What a check printed before it was killed proves nothing about how it would have ended.
			if (checkOutcome(check.output) !== "inconclusive") quotable.push(...output.split("\n"));
			return `$ ${check.command}\n${header}\n${output}`;
		}),
	].join("\n");
}

/** Which files changed: git's summary, the new files by name, and the ones the agent wrote. */
function changesSection(input: EvidenceInput): string {
	const touched = touchedFiles(input.tools);
	const more = input.untracked.length - MAX_NEW_FILE_NAMES;
	const changes =
		input.diffStat === undefined
			? "Not a git repository: no diff available."
			: input.diffStat.trim() === "" && input.untracked.length === 0
				? "No changes in the working tree."
				: [
						input.diffStat.trim(),
						...input.untracked.slice(0, MAX_NEW_FILE_NAMES).map((f) => ` ${f} (new, untracked)`),
						more > 0 ? ` … and ${more} more new, untracked files` : "",
					]
						.filter(Boolean)
						.join("\n");
	return [
		"## Changes since the task started",
		changes,
		touched.length > 0 ? `Files the agent edited or wrote: ${touched.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** The agent's last commands with their exit codes, what its test runs do not show, and its last unfixed failure. */
function commandsSection(input: EvidenceInput, quotable: string[]): string {
	const commands = input.tools.filter((t) => typeof t.input["command"] === "string").slice(-RECENT_COMMANDS);
	if (commands.length === 0) return "";
	// One line each: a command spanning lines could otherwise write a section of its own here.
	const lines = commands.map(
		(t) =>
			`$ ${clip(String(t.input["command"]).replace(/\s*\n\s*/g, " ⏎ "), COMMAND_CHARS)}  → exit ${t.exitCode ?? (t.isError ? "error" : "?")}`,
	);
	quotable.push(...lines);
	// A failure the agent has since fixed would only mislead: show it only if that command never passed again.
	// A run that failed behind a pipe is a failure too, whatever exit code the pipe gave it.
	const failedRun = (t: ToolOutcome) => outcomeOf(t) === "failed";
	const lastFailureAt = commands.findLastIndex(failedRun);
	const failed = commands[lastFailureAt];
	const fixedSince = commands
		.slice(lastFailureAt + 1)
		.some((t) => !failedRun(t) && t.input["command"] === failed?.input["command"]);
	const lastFailure = fixedSince ? undefined : failed;
	return [
		"## Commands the agent ran (most recent last)",
		...lines,
		...testRunNotes(input.tools, input.changedSinceTests, input.runs).map((n) => `Note: ${n}.`),
		lastFailure
			? `Output of the last failing command (it did not pass again):\n${tail(lastFailure.output, FAILED_OUTPUT_CHARS)}`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * Compact, deterministic evidence for the verdict sidecar (brief §6.1 step 2): what changed,
 * what was run and with which exit codes, and the results of check commands. Ordered by
 * importance so truncation drops the least useful parts (the raw diff) first.
 */
export function buildEvidence(input: EvidenceInput): Evidence {
	const quotable: string[] = [];
	const warnings = input.warnings ?? [];
	const sections = [
		warnings.length > 0 ? ["## Warnings (detected automatically)", ...warnings.map((w) => `- ${w}`)].join("\n") : "",
		checksSection(input.checks, quotable),
		changesSection(input),
		commandsSection(input, quotable),
	].filter(Boolean);

	const head = sections.join("\n\n");
	const notShown = input.newFilesNotShown ?? 0;
	// In the heading, where a cut at the end of the evidence cannot lose it.
	const left = notShown > 0 ? `${notShown} more new ${notShown === 1 ? "file is" : "files are"} not shown` : "";
	const heading = (cut: boolean) => {
		const notes = [cut ? "long files cut short" : "", left].filter(Boolean);
		return `## Diff${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
	};
	if (input.diff && input.diff.trim() !== "" && head.length < input.maxChars - 200) {
		const room = input.maxChars - head.length - heading(true).length - 4;
		const fitted = fitDiff(input.diff, room);
		quotable.push(...fitted.split("\n").filter((line) => /^[+-](?![+-]{2} )/.test(line)));
		sections.push(`${heading(input.diff.length > room)}\n${fitted}`);
	} else if (left !== "") {
		sections.push(heading(false));
	}
	const text = sections.join("\n\n");
	return { text: text.length > input.maxChars ? `${text.slice(0, input.maxChars)}\n…` : text, quotable };
}

/** {@link buildEvidence}'s text. */
export function formatEvidence(input: EvidenceInput): string {
	return buildEvidence(input).text;
}

/**
 * A diff cut to `room` characters with every file represented. Cutting the text at `room` showed
 * the judge the first files whole and the rest not at all, so items done in a later file looked
 * undone. Each file gets an equal share, and what a short file leaves over goes to the longer
 * ones. Code comes before tests: the request is usually about the code.
 */
export function fitDiff(diff: string, room: number): string {
	if (diff.length <= room) return diff;
	const files = diff
		.split(/^(?=diff --git )/m)
		.filter((f) => f.trim() !== "")
		.map((text) => ({ text: text.trimEnd(), test: isTestPath(diffHeaderPath(text.split("\n", 1)[0] ?? "") ?? "") }));
	const bySize = [...files].sort((x, y) => x.text.length - y.text.length);
	const share = new Map<string, number>();
	// One character per file is the line break that joins them.
	let left = room - files.length;
	bySize.forEach((file, i) => {
		const allowed = Math.min(file.text.length, Math.floor(left / (bySize.length - i)));
		share.set(file.text, allowed);
		left -= allowed;
	});
	return [...files.filter((f) => !f.test), ...files.filter((f) => f.test)]
		.map(({ text }) => {
			const allowed = share.get(text) ?? 0;
			if (text.length <= allowed) return text;
			const kept = text.slice(0, Math.max(0, allowed - DIFF_CUT_NOTE_CHARS));
			const cut = text.slice(kept.length).split("\n").length;
			return `${kept}\n… (${cut} more lines of this file's diff not shown)`;
		})
		.join("\n");
}

/** Fingerprint of a diff's text, for where the working tree itself cannot be fingerprinted. */
export function diffFingerprint(diff: string | undefined, untracked: readonly string[]): string {
	return createHash("sha256")
		.update(diff ?? "")
		.update("\0")
		.update(untracked.join("\n"))
		.digest("hex")
		.slice(0, 16);
}

/** Paths the agent wrote through file tools (pi's `edit`/`write`, or any tool with a `path`). */
export function touchedFiles(tools: readonly ToolOutcome[]): string[] {
	const paths = new Set<string>();
	for (const tool of tools) {
		const path = tool.input["path"] ?? tool.input["file_path"];
		if (typeof path === "string" && /edit|write|create|patch/i.test(tool.toolName) && !tool.isError) paths.add(path);
	}
	return [...paths].slice(0, 30);
}

/** The start of a long command, ending in `…` where it was cut. */
function clip(text: string, chars: number): string {
	return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

/** The end of a long output, beginning with `…` where it was cut: the verdict prompts say what that means. */
function tail(text: string, chars: number): string {
	const trimmed = text.trimEnd();
	return trimmed.length > chars ? `…${trimmed.slice(-chars)}` : trimmed;
}
