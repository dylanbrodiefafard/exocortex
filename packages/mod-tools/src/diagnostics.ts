import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, relative } from "node:path";
import { type CommandOutput, classifyErrorLine, cleanTerminalOutput, isRoutineLine } from "@exocortex/core";
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
const ERROR_BLOCK_LINES = 6;
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

/** What a check's run says: the errors in it, or undefined when it cannot be read (timeout, not installed). */
export function readCheck(result: CommandOutput, check: Check): Diagnostic[] | "not_installed" | undefined {
	if (result.timedOut || result.exitCode === null) return undefined;
	if (result.exitCode === NOT_FOUND) return "not_installed";
	if (result.exitCode === 0) return [];
	const lines = cleanTerminalOutput(result.outputTail).split("\n");
	if (check.builtin) {
		const text = lines
			.filter((line) => line.trim() !== "")
			.slice(0, ERROR_BLOCK_LINES * 2)
			.join("\n");
		return text === "" ? undefined : [{ key: keyOf(text), text }];
	}
	return errorBlocks(lines);
}

/**
 * A build log's errors, each with the lines under it that belong to it. Toolchain-specific error
 * lines first; a log with none falls back to lines that only mention an error.
 */
function errorBlocks(lines: readonly string[]): Diagnostic[] | undefined {
	const kinds = lines.map((line) => (isRoutineLine(line) ? undefined : classifyErrorLine(line)));
	const wanted = kinds.includes("specific") ? "specific" : kinds.includes("generic") ? "generic" : undefined;
	if (!wanted) return undefined;
	const blocks: Diagnostic[] = [];
	kinds.forEach((kind, index) => {
		if (kind !== wanted) return;
		const block = [lines[index] ?? ""];
		for (let next = index + 1; next < lines.length && block.length < ERROR_BLOCK_LINES; next++) {
			const line = lines[next] ?? "";
			if (line.trim() === "" || kinds[next] === wanted) break;
			block.push(line);
		}
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

/** A file's content hash; "missing" for a file that is not there (a write may create it). */
export function contentHash(absolute: string): string {
	try {
		return createHash("sha1").update(readFileSync(absolute)).digest("hex");
	} catch {
		return "missing";
	}
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
