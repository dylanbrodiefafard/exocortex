import { createHash } from "node:crypto";
import type { CommandOutput, ToolOutcome } from "@exocortex/core";

export interface CheckResult {
	readonly command: string;
	readonly output: CommandOutput;
}

export interface EvidenceInput {
	/** `git diff --stat <start>` plus untracked files, or undefined outside a git repo. */
	readonly diffStat: string | undefined;
	/** `git diff <start>` (may be long; truncated here). */
	readonly diff: string | undefined;
	readonly untracked: readonly string[];
	readonly tools: readonly ToolOutcome[];
	readonly checks: readonly CheckResult[];
	/** Deterministic warning signs (research R1.2), shown first. */
	readonly warnings?: readonly string[];
	readonly maxChars: number;
}

const RECENT_COMMANDS = 10;
const FAILED_OUTPUT_CHARS = 600;
const CHECK_OUTPUT_CHARS = 1_200;

/**
 * Compact, deterministic evidence for the verdict sidecar (brief §6.1 step 2): what changed,
 * what was run and with which exit codes, and the results of check commands. Ordered by
 * importance so truncation drops the least useful parts (the raw diff) first.
 */
export function formatEvidence(input: EvidenceInput): string {
	const sections: string[] = [];

	if (input.warnings && input.warnings.length > 0) {
		sections.push(["## Warnings (detected automatically)", ...input.warnings.map((w) => `- ${w}`)].join("\n"));
	}

	if (input.checks.length > 0) {
		sections.push(
			[
				"## Check commands (run just now)",
				...input.checks.map(
					(c) =>
						`$ ${c.command}\nexit code: ${c.output.timedOut ? "timed out" : c.output.exitCode}\n${tail(c.output.outputTail, CHECK_OUTPUT_CHARS)}`,
				),
			].join("\n"),
		);
	}

	const touched = touchedFiles(input.tools);
	const changes =
		input.diffStat === undefined
			? "Not a git repository: no diff available."
			: input.diffStat.trim() === "" && input.untracked.length === 0
				? "No changes in the working tree."
				: [input.diffStat.trim(), ...input.untracked.map((f) => ` ${f} (new, untracked)`)].join("\n");
	sections.push(
		[
			"## Changes since the task started",
			changes,
			touched.length > 0 ? `Files the agent edited or wrote: ${touched.join(", ")}` : "",
		]
			.filter(Boolean)
			.join("\n"),
	);

	const commands = input.tools.filter((t) => typeof t.input["command"] === "string").slice(-RECENT_COMMANDS);
	if (commands.length > 0) {
		const lines = commands.map(
			(t) => `$ ${String(t.input["command"]).slice(0, 200)}  → exit ${t.exitCode ?? (t.isError ? "error" : "?")}`,
		);
		// A failure the agent has since fixed would only mislead: show it only if that command never passed again.
		const lastFailureAt = commands.findLastIndex((t) => t.isError);
		const failed = commands[lastFailureAt];
		const fixedSince = commands
			.slice(lastFailureAt + 1)
			.some((t) => !t.isError && t.input["command"] === failed?.input["command"]);
		const lastFailure = fixedSince ? undefined : failed;
		sections.push(
			[
				"## Commands the agent ran (most recent last)",
				...lines,
				lastFailure
					? `Output of the last failing command (it did not pass again):\n${tail(lastFailure.output, FAILED_OUTPUT_CHARS)}`
					: "",
			]
				.filter(Boolean)
				.join("\n"),
		);
	}

	const head = sections.join("\n\n");
	if (input.diff && input.diff.trim() !== "" && head.length < input.maxChars - 200) {
		const room = input.maxChars - head.length - 40;
		sections.push(`## Diff (truncated)\n${input.diff.length > room ? `${input.diff.slice(0, room)}\n…` : input.diff}`);
	}
	const text = sections.join("\n\n");
	return text.length > input.maxChars ? `${text.slice(0, input.maxChars)}\n…` : text;
}

/** Fingerprint of the working tree's changes, to detect continuations that change nothing. */
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

function tail(text: string, chars: number): string {
	const trimmed = text.trimEnd();
	return trimmed.length > chars ? `…${trimmed.slice(-chars)}` : trimmed;
}

/**
 * Heuristic: does the agent's final message end by asking the user something (brief §6.1
 * guard)? Looks at the last non-empty lines outside code fences.
 */
export function asksUserQuestion(finalMessage: string): boolean {
	const withoutCode = finalMessage.replace(/```[\s\S]*?```/g, "");
	const lines = withoutCode
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	const ending = lines.slice(-2).join(" ");
	if (/\?\s*[*_)"'`]*\s*$/.test(ending)) return true;
	return /\b(would you like|do you want|should i|shall i|which (option|one) (do|would) you|please (confirm|clarify|choose|let me know which))\b/i.test(
		ending,
	);
}
