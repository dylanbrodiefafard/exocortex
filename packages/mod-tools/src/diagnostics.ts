import { basename, extname, relative } from "node:path";
import {
	type CommandOutput,
	classifyErrorLine,
	cleanTerminalOutput,
	type ErrorLineKind,
	isRoutineLine,
} from "@exocortex/core";
import type { CheckSetting } from "./settings.ts";

/** One error a check reported, and what makes it the same error after lines moved. */
export interface Diagnostic {
	readonly key: string;
	readonly text: string;
}

/** A check that applies to a file: the command line to run and how to read what it prints. */
export interface Check {
	readonly command: string;
	/** Shown to the model: what was run. */
	readonly label: string;
	/** A built-in syntax check prints only its errors; a configured one prints a build log. */
	readonly builtin: boolean;
	/** The setting or built-in template it came from: marked unavailable when its program is missing. */
	readonly source: string;
}

/** Lines of a configured check's error kept under it (a Rust `-->` line, a code excerpt). */
const ERROR_BLOCK_LINES = 8;
/** A failed check with no error line this module can read shows this many of its last lines. */
const UNREAD_TAIL_LINES = 40;
/** A line that starts with a place in a source file: `a.py:1:8:`, `src/a.ts:3:7`, `x.c(12,5)`. */
const POSITION = /^\s*[^\s:()]*[\w-]\.[A-Za-z]\w{0,7}(:\d+|\(\d+[,)])/;
/** A check's output kept for reading. */
export const CHECK_TAIL_CHARS = 64 * 1024;
/** Shell's "command not found": the checker is not installed. */
const NOT_FOUND = 127;

const PYTHON_SYNTAX = [
	"import ast, sys",
	"try:",
	"    ast.parse(open(sys.argv[1], 'rb').read(), sys.argv[1])",
	"except SyntaxError as e:",
	"    print(f'{e.filename}:{e.lineno}:{e.offset}: SyntaxError: {e.msg}')",
	"    sys.exit(1)",
].join("\n");

const PYTHON = { template: `python3 -c ${shellQuote(PYTHON_SYNTAX)} {file}`, label: "python3 syntax check" };
const GO = { template: "gofmt -e {file} > /dev/null", label: "gofmt -e" };
const SHELL = { template: "bash -n {file}", label: "bash -n" };
const NODE = { template: `${shellQuote(process.execPath)} --check {file}`, label: "node --check" };

/** Syntax checks that need nothing set up, by extension (`{file}` is the quoted path). */
const BUILTIN: Readonly<Record<string, { readonly template: string; readonly label: string }>> = {
	".py": PYTHON,
	".pyi": PYTHON,
	".go": GO,
	".sh": SHELL,
	".bash": SHELL,
	".js": NODE,
	".mjs": NODE,
	".cjs": NODE,
};

/** The check for a file: the first configured one whose pattern matches, else a built-in one. */
export function checkFor(
	absolute: string,
	cwd: string,
	checks: readonly CheckSetting[],
	builtin: boolean,
	unavailable: ReadonlySet<string>,
): Check | undefined {
	const rel = relative(cwd, absolute);
	const shown = rel.startsWith("..") ? absolute : rel;
	const check = checks.find((c) => matchesGlob(c.files, shown) && !unavailable.has(c.command));
	if (check) {
		const command = check.command.replaceAll("{file}", shellQuote(shown));
		return { command, label: command, builtin: false, source: check.command };
	}
	const known = builtin ? BUILTIN[extname(absolute).toLowerCase()] : undefined;
	if (!known || unavailable.has(known.template)) return undefined;
	return {
		command: known.template.replaceAll("{file}", shellQuote(shown)),
		label: known.label,
		builtin: true,
		source: known.template,
	};
}

/**
 * What a check's run says:
 * - `errors`: what it reported (empty when it passed). `guessed` when the run failed but printed no
 *   error line this module knows, so its `path:line` lines, or its last lines, stand for its errors.
 * - `not_installed`: its program is missing.
 * - `unreadable`: it timed out, was killed, or failed without printing anything.
 */
export type CheckReading =
	| { readonly kind: "errors"; readonly diagnostics: Diagnostic[]; readonly guessed: boolean }
	| { readonly kind: "not_installed" }
	| { readonly kind: "unreadable"; readonly why: string };

export function readCheck(result: CommandOutput, check: Check): CheckReading {
	if (result.timedOut) return { kind: "unreadable", why: "it timed out" };
	if (result.exitCode === null) return { kind: "unreadable", why: "it was stopped before it exited" };
	if (result.exitCode === NOT_FOUND) return { kind: "not_installed" };
	if (result.exitCode === 0) return { kind: "errors", diagnostics: [], guessed: false };
	const lines = cleanTerminalOutput(result.outputTail).split("\n");
	const printed = lines.filter((line) => line.trim() !== "");
	if (printed.length === 0) return { kind: "unreadable", why: `it exited with ${result.exitCode} and printed nothing` };
	if (check.builtin) {
		const text = printed.slice(0, ERROR_BLOCK_LINES * 2).join("\n");
		return { kind: "errors", diagnostics: [{ key: keyOf(text), text }], guessed: false };
	}
	const known = errorBlocks(lines, (kind) => kind === "specific");
	if (known.length > 0) return { kind: "errors", diagnostics: known, guessed: false };
	// Linters print `path:line: CODE message` (ruff, pylint, `shellcheck -f gcc`, biome) with no word
	// the error grammar knows, and a summary line ("Found 3 errors") that only mentions one.
	const placed = errorBlocks(lines, (_kind, line) => POSITION.test(line));
	if (placed.length > 0) return { kind: "errors", diagnostics: placed, guessed: true };
	const generic = errorBlocks(lines, (kind) => kind === "generic");
	if (generic.length > 0) return { kind: "errors", diagnostics: generic, guessed: false };
	// A failure in words this module does not know: its end is what explains it.
	const text = printed.slice(-UNREAD_TAIL_LINES).join("\n");
	return { kind: "errors", diagnostics: [{ key: keyOf(text), text }], guessed: true };
}

/**
 * A build log's errors, each with the lines under it that belong to it: the lines `starts` picks,
 * each with what follows up to the next one, a blank line, or {@link ERROR_BLOCK_LINES}.
 */
function errorBlocks(
	lines: readonly string[],
	starts: (kind: ErrorLineKind | undefined, line: string) => boolean,
): Diagnostic[] {
	const picked = lines.map((line) => !isRoutineLine(line) && starts(classifyErrorLine(line), line));
	const blocks: Diagnostic[] = [];
	picked.forEach((start, index) => {
		if (!start) return;
		const block = [lines[index] ?? ""];
		for (let next = index + 1; next < lines.length && block.length < ERROR_BLOCK_LINES; next++) {
			const line = lines[next] ?? "";
			if (picked[next]) break;
			// A linter puts a blank line between its message and its code frame; a compiler does not.
			if (line.trim() === "" && !/^\s+\S/.test(lines[next + 1] ?? "")) break;
			block.push(line);
		}
		while (block.length > 1 && block.at(-1)?.trim() === "") block.pop();
		const text = block.join("\n");
		blocks.push({ key: keyOf(text), text });
	});
	return blocks;
}

/** An error's identity across edits: its text with line and column numbers taken out. */
function keyOf(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim().replace(/\d+/g, "#"))
		.join("\n");
}

/** Errors in `after` beyond those in `before`, counted by key: the same error twice is two. */
export function newDiagnostics(before: readonly Diagnostic[], after: readonly Diagnostic[]): Diagnostic[] {
	const left = new Map<string, number>();
	for (const d of before) left.set(d.key, (left.get(d.key) ?? 0) + 1);
	return after.filter((d) => {
		const count = left.get(d.key) ?? 0;
		if (count === 0) return true;
		left.set(d.key, count - 1);
		return false;
	});
}

/**
 * Whether an error names the file: some path in its text is the file's path, or ends with it, or
 * the file's path ends with it (a tool run from another directory prints paths from there). The
 * names must match whole: `b.rs` is not `lib.rs`.
 */
export function mentionsFile(text: string, absolute: string, cwd: string): boolean {
	const rel = relative(cwd, absolute);
	const targets = [absolute, ...(rel.startsWith("..") ? [] : [rel])];
	for (const match of text.matchAll(PATH_IN_TEXT)) {
		const path = (match[0] ?? "").replace(/^\.\//, "");
		if (basename(path) !== basename(absolute)) continue;
		if (targets.some((target) => endsWithPath(target, path) || endsWithPath(path, target))) return true;
	}
	return false;
}

const PATH_IN_TEXT = /[\w.@+~/-]*[\w-]\.[A-Za-z]\w{0,7}(?=[:(\s,"'`]|$)/gm;

function endsWithPath(path: string, end: string): boolean {
	return path === end || path.endsWith(`/${end}`);
}

/** `*.rs` matches a file name; a pattern with `/` matches the path from the workspace root. `**` spans directories. */
export function matchesGlob(pattern: string, path: string): boolean {
	const target = pattern.includes("/") ? path : basename(path);
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i] as string;
		if (c === "*" && pattern[i + 1] === "*") {
			source += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
			i += pattern[i + 2] === "/" ? 2 : 1;
		} else if (c === "*") source += "[^/]*";
		else if (c === "?") source += "[^/]";
		else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`).test(target);
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, "'\\''")}'`;
}
