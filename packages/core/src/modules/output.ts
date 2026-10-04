import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Deterministic tool-output analysis shared by modules (trimmer, triage, compaction) and the
 * eval's metrics: terminal-noise cleanup, per-ecosystem error grammars (D-016: Rust, Go, C++,
 * Python first) and normalized error signatures.
 */

/** Error lines that are specific to a toolchain: preferred over generic matches. */
const SPECIFIC_ERROR_PATTERNS: readonly RegExp[] = [
	// Rust / cargo
	/^error(\[E\d+\])?: /,
	/^thread '.*' panicked at /,
	/^test \S+ \.\.\. FAILED$/,
	/^error: test failed/,
	// Go
	/^\S+\.go:\d+(:\d+)?: /,
	/^\s*--- FAIL: /,
	/^panic: /,
	/^FAIL\s/,
	// C / C++ / linkers / build systems
	/^\S+:\d+(:\d+)?: (fatal )?error: /,
	/: undefined reference to /,
	/^(\/\S+\/)?ld(\.\w+)?: /,
	/^collect2: error: /,
	/^make(\[\d+\])?: \*\*\* /,
	/^CMake Error/,
	/^\d+% tests passed, \d+ tests? failed/,
	/^The following tests FAILED/,
	// Python / pytest
	/^Traceback \(most recent call last\):/,
	/^E {3}/,
	/^(FAILED|ERROR) \S/,
	/^[A-Z]\w*(Error|Exception|Exit): /,
	// TypeScript / Node
	/error TS\d+: /,
];

const GENERIC_ERROR_PATTERN =
	/\b(error|errors|fatal|failed|failure|panic|exception|traceback|segmentation fault|abort(ed)?)\b/i;
/** Lines that mention errors without being one ("0 errors", "-Werror", "error_handler.go"). */
const FALSE_POSITIVE_PATTERN = /\b0 (errors?|failed|failures)\b|-Werror|\berror(s)?_\w|\w_errors?\b|\bno errors?\b/i;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Removes ANSI escapes and keeps only the final state of carriage-return-redrawn lines (progress bars). */
export function cleanTerminalOutput(text: string): string {
	return text
		.replace(ANSI_PATTERN, "")
		.split("\n")
		.map((line) => {
			const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
			const last = trimmed.lastIndexOf("\r");
			return last === -1 ? trimmed : trimmed.slice(last + 1);
		})
		.join("\n");
}

export type ErrorLineKind = "specific" | "generic";

/** Classifies a line as a toolchain-specific error, a generic error mention, or neither. */
export function classifyErrorLine(line: string): ErrorLineKind | undefined {
	if (SPECIFIC_ERROR_PATTERNS.some((pattern) => pattern.test(line))) return "specific";
	if (GENERIC_ERROR_PATTERN.test(line) && !FALSE_POSITIVE_PATTERN.test(line)) return "generic";
	return undefined;
}

/** Indices of error lines, toolchain-specific or generic. */
export function errorLineIndices(lines: readonly string[]): number[] {
	const indices: number[] = [];
	lines.forEach((line, index) => {
		if (classifyErrorLine(line) !== undefined) indices.push(index);
	});
	return indices;
}

/** The first toolchain-specific error line, else the first generic one (with its index). */
export function firstErrorLine(text: string): { readonly line: string; readonly index: number } | undefined {
	const lines = cleanTerminalOutput(text).split("\n");
	let generic: { line: string; index: number } | undefined;
	for (const [index, raw] of lines.entries()) {
		const line = raw.trim();
		const kind = classifyErrorLine(raw) ?? classifyErrorLine(line);
		if (kind === "specific") return { line, index };
		if (kind === "generic" && !generic) generic = { line, index };
	}
	return generic;
}

/** Normalizes the volatile parts of an error line: quoted strings, paths, hex ids and numbers. */
export function normalizeErrorLine(line: string): string {
	return line
		.trim()
		.replace(/(["'`]).*?\1/g, "<str>")
		.replace(/(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g, "<path>")
		.replace(/0x[0-9a-f]+/gi, "<hex>")
		.replace(/\d+/g, "<n>")
		.slice(0, 200);
}

/**
 * Deterministic error signature: tool, exit code and the normalized first error line (else the
 * first non-empty line), so the "same" failure matches across attempts.
 */
export function errorSignature(toolName: string, exitCode: number | null, output: string): string {
	const line = firstErrorLine(output)?.line ?? output.split("\n").find((l) => l.trim() !== "") ?? "";
	return `${toolName}|${exitCode ?? ""}|${normalizeErrorLine(line)}`;
}

const TEST_PATH =
	/(^|\/)(tests?|__tests__|spec|testdata)\/|_test\.(go|py|rs|cc|cpp)$|(^|\/)test_[^/]*\.(py|cpp|cc|c|hpp|h)$|\.(test|spec)\.[jt]sx?$|(^|\/)[^/]*tests?\.rs$/;

/** Whether a repo-relative path looks like a test file (Rust, Go, C/C++, Python, JS/TS conventions). */
export function isTestPath(path: string): boolean {
	return TEST_PATH.test(path);
}

/**
 * Guidance gate (research R3.5, brief constraint 5): file paths and backticked names in sidecar text
 * must appear in the evidence or exist in the workspace; returns those that do not.
 */
export function ungroundedReferences(hint: string, evidence: string, cwd: string): string[] {
	const references = new Set<string>();
	// Backticked names (not commands, which contain spaces).
	for (const match of hint.matchAll(/`([^`\s]{2,80})`/g)) if (match[1]) references.add(match[1]);
	for (const match of hint.matchAll(
		/(?:^|[\s(])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w-]+\.[a-z]{1,5})(?::\d+)*(?=[\s),.;:]|$)/gi,
	)) {
		if (match[1] && /[/]|\.[a-z]{1,5}$/i.test(match[1])) references.add(match[1]);
	}
	return [...references].filter((ref) => !evidence.includes(ref) && !existsInWorkspace(ref, cwd));
}

function existsInWorkspace(ref: string, cwd: string): boolean {
	if (!/^[\w./-]+$/.test(ref)) return false;
	try {
		return existsSync(isAbsolute(ref) ? ref : join(cwd, ref));
	} catch {
		return false;
	}
}
