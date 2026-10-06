import { splitCommand } from "@exocortex/core";

/** Commands that print nothing worth classifying: skipped when deciding what a command line outputs. */
const SILENT: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "export", "set", "source", ".", "true", ":"]);
/** Prefixes that run another command; their own flags and numbers are skipped with them. */
const WRAPPERS: ReadonlySet<string> = new Set(["sudo", "env", "time", "timeout", "nice", "nohup", "command", "stdbuf"]);
const GIT_GLOBAL_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree"]);

/**
 * Whether a shell command's output is content the agent asked to see, as opposed to the log of a
 * build or test run: every part of the command line that prints ends in one of `names` (`cat`,
 * `grep`, `git diff`, a pipe into `tail`…). Such output is not trimmed: the agent chose it, and
 * head/tail/error selection would mangle it (RTK's "respect what was asked for").
 *
 * Anything this cannot read with confidence (heredocs, substitutions, unbalanced quotes) is not
 * content, so it is trimmed as before. The line is split by core's tokenizer (D-077).
 */
export function printsRequestedContent(command: string, names: readonly string[]): boolean {
	const segments = splitCommand(command);
	if (!segments) return false;
	let printing = 0;
	for (const pipeline of segments) {
		const name = commandName(pipeline.at(-1) ?? []);
		if (name === undefined || SILENT.has(name)) continue;
		if (!names.includes(name)) return false;
		printing += 1;
	}
	return printing > 0;
}

/** The command a stage runs, as `name` or `git <subcommand>`, past env assignments and wrappers. */
function commandName(words: readonly string[]): string | undefined {
	let i = 0;
	while (i < words.length) {
		const word = words[i] ?? "";
		if (/^\w+=/.test(word) || WRAPPERS.has(word) || /^-|^\d+[smhd]?$/.test(word)) i++;
		else break;
	}
	const name = words[i]?.replace(/^.*\//, "");
	if (name !== "git") return name;
	i++;
	while (i < words.length && words[i]?.startsWith("-")) i += GIT_GLOBAL_FLAGS_WITH_VALUE.has(words[i] ?? "") ? 2 : 1;
	return words[i] === undefined ? "git" : `git ${words[i]}`;
}
