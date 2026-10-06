import { commandBase, splitCommand, unwrapCommand } from "@exocortex/core";

/** Commands that print nothing worth classifying: skipped when deciding what a command line outputs. */
const SILENT: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "export", "set", "source", ".", "true", ":"]);
const GIT_GLOBAL_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree"]);
/** `xargs` options that take their value as the next word (`-I{}` and `--max-args=5` carry it themselves). */
const XARGS_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"]);
/**
 * Commands that show part of what they are given: the lines the agent picked out of a run's
 * output. `cat`, `sort` or `tee` after a run pass all of it on, so it is still a log.
 * `sed` selects only with `-n`.
 */
const SELECTING: ReadonlySet<string> = new Set("head tail grep egrep fgrep rg ag ack awk wc jq yq".split(" "));

interface StageCommand {
	/** `name`, or `git <subcommand>`. */
	readonly name: string;
	readonly words: readonly string[];
}

/**
 * Whether a shell command's output is content the agent asked to see, as opposed to the log of a
 * build or test run. Such output is not trimmed: the agent chose it, and head/tail/error
 * selection would mangle it (RTK's "respect what was asked for"). Every pipeline on the line that
 * prints must qualify (D-070, D-083):
 * - it ends in one of `names` (`cat`, `grep`, `git diff`…), and
 * - every stage is one of `names` (`cat log | sort`), or a stage after the last one that is not
 *   selects from its output (`cargo test | tail -100`, `make | grep -A5 error | sort`).
 *   `cargo test | cat` is the whole log of a run, so it is trimmed.
 *
 * Anything this cannot read with confidence (heredocs, substitutions, unbalanced quotes) is not
 * content, so it is trimmed as before. The line is split by core's tokenizer (D-077).
 */
export function printsRequestedContent(command: string, names: readonly string[]): boolean {
	const segments = splitCommand(command);
	if (!segments) return false;
	let printing = 0;
	for (const pipeline of segments) {
		const stages = pipeline.map(stageCommand);
		const sink = stages.at(-1);
		if (sink === undefined || SILENT.has(sink.name)) continue;
		if (!names.includes(sink.name)) return false;
		const lastRun = stages.findLastIndex((stage) => stage === undefined || !names.includes(stage.name));
		if (lastRun !== -1 && !stages.slice(lastRun + 1).some((stage) => stage !== undefined && selects(stage))) {
			return false;
		}
		printing += 1;
	}
	return printing > 0;
}

function selects(stage: StageCommand): boolean {
	if (stage.name === "sed") return stage.words.some((word) => /^-[a-zA-Z]*n|^--(quiet|silent)$/.test(word));
	return SELECTING.has(stage.name);
}

/** The command a stage runs, past env assignments, wrappers (core's list) and `xargs`. */
function stageCommand(stage: readonly string[]): StageCommand | undefined {
	let words = unwrapCommand(stage);
	for (let depth = 0; depth < 3 && commandBase(words[0]) === "xargs"; depth++) {
		const rest = words.slice(pastOptions(words, XARGS_FLAGS_WITH_VALUE));
		// With no command of its own, xargs runs `echo`.
		words = rest.length > 0 ? unwrapCommand(rest) : ["echo"];
	}
	const base = commandBase(words[0]);
	if (base === "" || /^[A-Za-z_]\w*\+?=/.test(base)) return undefined;
	if (base !== "git") return { name: base, words };
	const sub = words[pastOptions(words, GIT_GLOBAL_FLAGS_WITH_VALUE)];
	return { name: sub === undefined ? "git" : `git ${sub}`, words };
}

/** The index of the first word after the command's name that is not an option or an option's value. */
function pastOptions(words: readonly string[], withValue: ReadonlySet<string>): number {
	let i = 1;
	while (i < words.length && /^-./.test(words[i] ?? "")) i += withValue.has(words[i] ?? "") ? 2 : 1;
	return i;
}
