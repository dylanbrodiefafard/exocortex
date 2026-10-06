import { commandBase, shellCommands, verifyingRun } from "@exocortex/core";
import { repoPath } from "./paths.ts";

/**
 * What a shell command line does to the working tree, as far as its words say (M1):
 * - `changes`: it rewrites, moves, deletes or restores files, installs something, or redirects
 *   output into a file of the repo. A pass after it may be its doing and not the edits'.
 * - `reads`: every command on it only looks, or is a run of the tests or the build.
 * - `other`: neither can be told (a script, a generator, an unknown tool).
 */
export type ShellEffect = "changes" | "reads" | "other";

const READ_ONLY: ReadonlySet<string> = new Set([
	...["cat", "ls", "grep", "egrep", "fgrep", "rg", "ag", "fd", "head", "tail", "wc", "echo", "printf", "pwd", "cd"],
	...["which", "type", "file", "stat", "du", "df", "tree", "sort", "uniq", "cut", "tr", "awk", "diff", "cmp", "less"],
	...["more", "nl", "od", "xxd", "hexdump", "jq", "yq", "date", "env", "printenv", "true", "false", "test", "["],
	...["basename", "dirname", "realpath", "readlink", "sleep", "id", "whoami", "uname", "ps", "column", "tac", "rev"],
	...["strings", "sha256sum", "md5sum", "nproc", "export", "set", "pushd", "popd", "bat", "command", "hostname", "tee"],
]);

/** Commands that change files or what is installed, whatever their arguments. */
const ALWAYS_CHANGES: ReadonlySet<string> = new Set([
	...["rm", "mv", "cp", "ln", "patch", "truncate", "dd", "rsync", "chmod", "chown", "rmdir", "unlink", "install"],
	...["apt", "apt-get", "brew", "dnf", "yum", "pacman", "apk", "rustfmt", "black", "gofmt", "goimports", "autopep8"],
	...["isort", "shfmt"],
]);

const GIT_CHANGES =
	/^(checkout|restore|stash|reset|revert|apply|am|cherry-pick|merge|rebase|pull|clean|switch|rm|mv|submodule|worktree)$/;
const GIT_READS =
	/^(status|diff|log|show|blame|ls-files|ls-tree|grep|rev-parse|rev-list|describe|remote|branch|tag|shortlog|cat-file|config|fetch|reflog|merge-base|name-rev|whatchanged|add|commit|push)$/;
/** Subcommands that install, remove or rewrite: `pip install`, `cargo add`, `go mod tidy`, `ruff format`. */
const TOOL_CHANGES: Readonly<Record<string, RegExp>> = {
	pip: /^(install|uninstall)$/,
	pip3: /^(install|uninstall)$/,
	uv: /^(add|remove|sync|lock|pip)$/,
	poetry: /^(add|remove|install|update|lock)$/,
	npm: /^(install|i|ci|add|uninstall|remove|rm|update|up|dedupe|link|prune)$/,
	yarn: /^(add|remove|install|up|upgrade)$/,
	pnpm: /^(add|remove|install|i|update|up)$/,
	bun: /^(add|remove|install|i|update)$/,
	cargo: /^(add|remove|rm|update|clean|install|fix|fmt)$/,
	go: /^(get|mod|install|generate|fmt)$/,
	ruff: /^format$/,
	biome: /^format$/,
};
/** Flags that make a linter or formatter rewrite the files it reads. */
const REWRITE_FLAG = /^(--fix(-\w+)*|--write|-w|--in-place|--apply|--apply-unsafe|--unsafe-fixes)$/;
const REWRITERS: ReadonlySet<string> = new Set([
	"prettier",
	"eslint",
	"biome",
	"ruff",
	"clippy",
	"cargo",
	"clang-format",
	"clang-tidy",
	"stylelint",
]);
/** `sed -i`, `perl -pi -e`, `clang-format -i`. */
const IN_PLACE_EDITORS = /^(sed|perl|ruby|clang-format)$/;
const IN_PLACE_FLAG = /^-[a-zA-Z]*i|^--in-place/;
const SCRIPT_RUNNERS = /^(npm|yarn|pnpm|bun|make|just)$/;
/** Package scripts and make targets named for rewriting: `npm run format`, `make fmt`. */
const REWRITE_SCRIPT = /^(format|fmt|fix|lint[:-]fix|clean|install|setup|bootstrap)([:-].*)?$/;
/** Output kept for reading, not part of the code: a redirect into one of these changes nothing that matters. */
const LOG_FILE = /\.(log|txt|out|err|tmp)$/i;

/** Reads a command line for what it does to the files under `cwd`. */
export function shellEffect(line: string, cwd: string): ShellEffect {
	if (writesInto(line, cwd)) return "changes";
	const commands = shellCommands(line);
	if (!commands) return "other";
	let effect: ShellEffect = "reads";
	for (const { words } of commands) {
		const one = commandEffect(words, cwd);
		if (one === "changes") return "changes";
		if (one === "other") effect = "other";
	}
	return effect;
}

function commandEffect(words: readonly string[], cwd: string): ShellEffect {
	const [first, ...args] = words;
	const name = commandBase(first);
	if (name === "") return "reads";
	if (name === "git") return gitEffect(args);
	if (rewrites(name, args, cwd)) return "changes";
	if (name === "sed" || READ_ONLY.has(name)) return "reads";
	if (name === "find") return args.some((arg) => /^-(delete|exec|execdir|ok)$/.test(arg)) ? "other" : "reads";
	// A run of the tests or the build is what the fix is measured by, not a change to it.
	return verifyingRun(words.join(" ")) ? "reads" : "other";
}

/** Whether a command, by its name and arguments, rewrites files or changes what is installed. */
function rewrites(name: string, args: readonly string[], cwd: string): boolean {
	// `tee` into a log only keeps a copy of the output.
	if (name === "tee") return args.some((arg) => !arg.startsWith("-") && isRepoFile(arg, cwd));
	const sub = args.find((arg) => !arg.startsWith("-")) ?? "";
	return (
		ALWAYS_CHANGES.has(name) ||
		TOOL_CHANGES[name]?.test(sub) === true ||
		(REWRITERS.has(name) && args.some((arg) => REWRITE_FLAG.test(arg))) ||
		(IN_PLACE_EDITORS.test(name) && args.some((arg) => IN_PLACE_FLAG.test(arg))) ||
		(SCRIPT_RUNNERS.test(name) && args.some((arg) => REWRITE_SCRIPT.test(arg)))
	);
}

function gitEffect(args: readonly string[]): ShellEffect {
	// Past `-C dir` and `-c key=value`.
	const rest = [...args];
	while (rest[0]?.startsWith("-")) rest.splice(0, /^-[Cc]$/.test(rest[0]) ? 2 : 1);
	const [sub = "", next = ""] = rest;
	if (sub === "stash") return /^(list|show)$/.test(next) ? "reads" : "changes";
	// Making a branch moves nothing in the tree.
	if (/^(checkout|switch)$/.test(sub) && rest.some((arg) => /^-[bBcC]$/.test(arg))) return "reads";
	if (GIT_CHANGES.test(sub)) return "changes";
	return GIT_READS.test(sub) ? "reads" : "other";
}

/** Whether the line redirects output into a file of the repo that is not a log. */
function writesInto(line: string, cwd: string): boolean {
	// Up to the first heredoc's line: its body is data, where `>` means nothing.
	const lines = line.split("\n");
	const heredoc = lines.findIndex((l) => /<<-?\s*['"]?\w/.test(l));
	const text = (heredoc === -1 ? lines : lines.slice(0, heredoc + 1))
		.join("\n")
		.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " ");
	for (const match of text.matchAll(/(?<![<>&\d=-])[12]?>{1,2}(?!&)\s*([^\s;|&<>()]+)/g)) {
		if (isRepoFile(match[1] ?? "", cwd)) return true;
	}
	return false;
}

function isRepoFile(target: string, cwd: string): boolean {
	return repoPath(cwd, target) !== undefined && !LOG_FILE.test(target);
}
