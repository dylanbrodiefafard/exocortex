import { commandBase, splitCommand, unwrapCommand } from "@exocortex/core";

/** Commands that only print what is there: running them changes no file a check reads. */
const READERS: ReadonlySet<string> = new Set([
	..."cat head tail less more bat nl wc cut sort uniq tr tac column fold diff cmp".split(" "),
	..."grep egrep fgrep rg ag ack ls tree stat file du df pwd echo printf which type".split(" "),
	..."jq yq xxd hexdump od strings nm objdump readelf awk sed find fd cd true test [".split(" "),
]);
/** Git subcommands that only read. */
const GIT_READERS: ReadonlySet<string> = new Set(
	"status diff log show blame grep ls-files rev-parse cat-file shortlog describe".split(" "),
);

/**
 * Whether a shell command line only prints: every command in it reads (`cat`, `grep`, `git diff`,
 * `sed -n`), and nothing is written to a file. A check's last result still holds after it, and a
 * check still running is not stale (D-110). Anything this cannot read with confidence
 * (substitutions, heredocs, `sed -i`, `find -delete`, a redirect into a file) is taken to change files.
 */
export function printsOnly(command: string): boolean {
	// `2>&1` and `> /dev/null` write nowhere; any other `>` writes a file.
	const writes = command.replace(/\d*>&\d|&?\d*>>?\s*\/dev\/null/g, "");
	if (writes.includes(">") || /\btee\b/.test(writes)) return false;
	const pipelines = splitCommand(command);
	if (!pipelines || pipelines.length === 0) return false;
	return pipelines.every((stages) => stages.every((stage) => reads(unwrapCommand(stage))));
}

function reads(words: readonly string[]): boolean {
	const name = commandBase(words[0]);
	if (name === "git") {
		const sub = words.slice(1).find((word) => !word.startsWith("-"));
		return sub !== undefined && GIT_READERS.has(sub);
	}
	if (!READERS.has(name)) return false;
	if (name === "sed") return !words.some((word) => /^-[a-zA-Z]*i|^--in-place/.test(word));
	if (name === "find") return !words.some((word) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(word));
	if (name === "awk") return !words.some((word) => /system\s*\(|inplace/.test(word));
	return true;
}
