import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Deterministic tool-output analysis shared by modules (trimmer, triage, compaction) and the
 * eval's metrics: terminal-noise cleanup, per-ecosystem error grammars (D-016: Rust, Go, C++,
 * Python first) and normalized error signatures.
 *
 * Three grammars, by what a line can prove (D-077). A line worth keeping when an output is
 * trimmed is not thereby a sign that the run failed: `go test -v` prints `x_test.go:41: …` for a
 * passing test's `t.Log`, and a linker prints `ld: warning: …` on a build that works.
 */

/**
 * What a runner or compiler prints only when it fails: enough, on its own, to call a run failed
 * whose exit code was not seen.
 */
const FAILED_PATTERNS: readonly RegExp[] = [
	// Rust / cargo, nextest
	/^error(\[E\d+\])?: /,
	/^test .+ \.\.\. FAILED$/,
	/^test result: FAILED/,
	/^Summary \[.*\b\d+ (failed|timed out)\b/,
	// Go: compile and vet errors carry a column, which log lines never do
	/^\S+\.go:\d+:\d+: /,
	/^\s*--- FAIL: /,
	/^FAIL(\s|$)/,
	/^panic: /,
	// C / C++ / linkers / build systems
	/^\S+:\d+(:\d+)?: (fatal )?error: /,
	/: undefined reference to /,
	/: multiple definition of /,
	/^(\/\S+\/)?ld(\.\w+)?: (error: |cannot find |symbol\(s\) not found|library not found)/,
	/^collect2: error: /,
	/^g?make(\[\d+\])?: \*\*\* /,
	/^ninja: build stopped/,
	/^CMake Error/,
	/^\d+% tests passed, [1-9]\d* tests? failed/,
	/^The following tests FAILED/,
	/^\s*\d+\/\d+ Test\s+#\d+: .*\*\*\*\w/,
	/^\[\s+FAILED\s+\]/,
	/^\S+:\d+: Failure$/,
	// TAP
	/^not ok\b/,
	// Python: pytest's report and summaries, unittest's headers and result
	/^E {3}/,
	/^(FAILED|ERROR) \S+(::| - |$)/,
	/^(FAIL|ERROR): \S+ \(\S+\)$/,
	/^FAILED \(/,
	/^=* ?(\d+ \w+, )*\d+ (failed|errors?)\b.* in [\d.]+s/,
	// TypeScript / Node
	/error TS\d+: /,
];

/**
 * What a program prints when it crashes. It is the error of an output known to have failed, but a
 * passing test run can show one too (an exception the code under test logged and handled), so
 * against a runner's pass summary it does not decide.
 */
const CRASH_PATTERNS: readonly RegExp[] = [
	// Rust 1.91+ prints the thread id: thread 'name' (12345) panicked at …
	/^thread '.*'( \(\d+\))? panicked at /,
	/^Traceback \(most recent call last\):/,
	// `json.decoder.JSONDecodeError: …`, `KeyboardInterrupt`; `SystemExit: 0` is a clean exit.
	/^(?!SystemExit: 0$)([A-Za-z_]\w*\.)*[A-Z]\w*(Error|Exception|Exit|Interrupt)(: |$)/,
];

/** Go's `t.Log`/`t.Errorf` output: under a `--- FAIL` it is the failure's message, else a passing test's log. */
const GO_TEST_LOG = /^\s+\S+_test\.go:\d+: /;
const GO_TEST_FAILED = /^\s*--- FAIL: /;

/**
 * Lines to keep when trimming that prove nothing about how the run ended: logs with a source
 * position, linker notes and warnings, and looser spellings of the lines above.
 */
const NOTABLE_PATTERNS: readonly RegExp[] = [
	/^\S+\.go:\d+: /,
	GO_TEST_LOG,
	/^(\/\S+\/)?ld(\.\w+)?: /,
	/^\d+% tests passed, \d+ tests? failed/,
	/^(FAILED|ERROR) \S/,
	/^(FAIL|ERROR): /,
	/^[A-Z]\w*(Error|Exception|Exit)(: |$)/,
];

/**
 * Lines a test or build run prints when nothing is wrong: passing tests, per-test progress and
 * compile chatter (the lines RTK's and tokf's per-command filters skip). Never a line that can
 * carry a failure, a warning or a summary count.
 */
const ROUTINE_PATTERNS: readonly RegExp[] = [
	// Rust / cargo
	/^\s+(Compiling|Checking|Downloading|Downloaded|Fresh|Locking|Updating|Blocking) /,
	/^running \d+ tests?$/,
	/^test .+ \.\.\. ok$/,
	// Go (`go test -v`)
	/^=== (RUN|PAUSE|CONT|NAME)\s/,
	/^\s*--- (PASS|SKIP): /,
	/^PASS$/,
	// C / C++ / build systems
	/^make(\[\d+\])?: (Entering|Leaving) directory /,
	/^\[\s*\d+%\] (Building|Linking|Built target|Generating|Scanning) /,
	/^\[\s+(RUN|OK)\s+\]/,
	/^\s*\d+\/\d+ Test\s+#\d+: .*\bPassed\b/,
	// TAP
	/^ok \d+/,
	// Python: pytest progress and verbose passes, unittest -v, pip
	/^\S+\.py [.sxX]+\s+\[\s*\d+%\]$/,
	/^\S+::\S+ (PASSED|SKIPPED)\b/,
	/^\w+ \([\w.]+\)(\s.*)? \.\.\. ok$/,
	/^(Requirement already satisfied|Collecting|Using cached) /,
];

/** A word that says something went wrong, standing on its own: not part of `error-chain`, `--fatal-warnings` or `errors.go`. */
const GENERIC_ERROR_PATTERN =
	/(?<!\w[-_.])(?<!--)\b(error|errors|fatal|failed|failure|failures|panic|exception|traceback|segmentation fault|abort(ed)?)\b(?![-_.]\w)/i;
/** Lines that mention errors without being one ("0 errors", "failures=0", "-Werror", "error_handler.go"). */
const FALSE_POSITIVE_PATTERN =
	/\b0 (tests? )?(errors?|failed|failures?)\b|\b(errors?|failures?|failed)[:=]\s?0\b|-Werror|\berror(s)?_\w|\w_errors?\b|\bno (errors?|failures?)\b/i;
/** A line of source a compiler quotes under its message: `3 |     let error = 1;`. */
const CODE_EXCERPT = /^\s*\d*\s*\|(\s|$)/;
/** Names, not statements: backticked and quoted identifiers, paths, URLs and module paths (`parse::error::tests`). */
const NAMES = /`[^`]*`|'[\w.:-]+'|\S*(\/|::)\S*/g;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

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

type LineReading = "failed" | "error" | "notable" | "mention";
const STRENGTH: Readonly<Record<LineReading, number>> = { failed: 4, error: 3, notable: 2, mention: 1 };

/** Whether a line talks about an error in its own words, as opposed to naming something called one. */
function mentionsError(line: string): boolean {
	if (CODE_EXCERPT.test(line) || FALSE_POSITIVE_PATTERN.test(line)) return false;
	return GENERIC_ERROR_PATTERN.test(line.replace(NAMES, " "));
}

function readLine(line: string): LineReading | undefined {
	if (FAILED_PATTERNS.some((pattern) => pattern.test(line))) return "failed";
	if (CRASH_PATTERNS.some((pattern) => pattern.test(line))) return "error";
	if (NOTABLE_PATTERNS.some((pattern) => pattern.test(line))) return "notable";
	return mentionsError(line) ? "mention" : undefined;
}

export type ErrorLineKind = "specific" | "generic";

/**
 * Classifies a line for keeping: one a toolchain prints about an error or beside one (`specific`),
 * a generic error mention, or neither. This is the trimmer's question. Whether the run failed is
 * {@link lineVerdicts}' question: a `specific` line can be a passing test's log.
 */
export function classifyErrorLine(line: string): ErrorLineKind | undefined {
	const reading = readLine(line);
	return reading === undefined ? undefined : reading === "mention" ? "generic" : "specific";
}

/**
 * What a line says about how a run ended:
 * - `failed`: a runner or compiler prints it only when it fails;
 * - `error`: a crash (a traceback, a panic), or a failing Go test's message. It is the error of a
 *   run known to have failed; against a runner's pass summary it is only a log;
 * - `mention`: the line talks about an error or a failure without being a toolchain's report of one.
 */
export type LineVerdict = "failed" | "error" | "mention";

/**
 * Reads every line of an output for how the run ended (D-077). The whole output is needed: Go's
 * indented `x_test.go:41: …` lines are a failure's message only when a test failed. An indented
 * line is read with and without its indentation, since nested output shifts everything right.
 */
export function lineVerdicts(lines: readonly string[]): (LineVerdict | undefined)[] {
	const goTestFailed = lines.some((line) => GO_TEST_FAILED.test(line));
	return lines.map((line) => {
		const raw = readLine(line);
		const trimmed = raw === "failed" ? raw : readLine(line.trim());
		const reading = (raw ? STRENGTH[raw] : 0) >= (trimmed ? STRENGTH[trimmed] : 0) ? raw : trimmed;
		if (reading !== "notable") return reading;
		if (goTestFailed && GO_TEST_LOG.test(line)) return "error";
		return mentionsError(line) ? "mention" : undefined;
	});
}

/** Whether a line is routine output of a passing test or a build step: safe to hide before anything else. */
export function isRoutineLine(line: string): boolean {
	return ROUTINE_PATTERNS.some((pattern) => pattern.test(line));
}

/** Indices of the lines worth keeping as errors, toolchain-specific or generic. */
export function errorLineIndices(lines: readonly string[]): number[] {
	const indices: number[] = [];
	lines.forEach((line, index) => {
		if (classifyErrorLine(line) !== undefined) indices.push(index);
	});
	return indices;
}

/** The first line a toolchain reports a failure or a crash on, else the first that mentions one (with its index). */
export function firstErrorLine(text: string): { readonly line: string; readonly index: number } | undefined {
	const lines = cleanTerminalOutput(text).split("\n");
	let generic: { line: string; index: number } | undefined;
	for (const [index, verdict] of lineVerdicts(lines).entries()) {
		const line = (lines[index] ?? "").trim();
		if (verdict === "failed" || verdict === "error") return { line, index };
		if (verdict === "mention" && !generic) generic = { line, index };
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

/** Extensions a bare word must end in to be read as a file name: `e.g` and `i.e` are not files. */
const SOURCE_EXTENSION =
	/\.(rs|go|c|h|cc|cpp|cxx|hpp|hh|hxx|py|pyi|ts|tsx|js|jsx|mjs|cjs|json|toml|yaml|yml|md|txt|sh|cfg|ini|conf|lock|mod|sum|cmake|mk|html|css|sql|proto|xml|java|kt|rb|log|csv)$/i;
/** Products written like files: Node.js, Vue.js. */
const PRODUCT_NAME = /^[A-Z][A-Za-z0-9]*\.js$/;
/** What a name carries in prose and not in code: a call's `()`, a position, type arguments. */
const NAME_SUFFIX = /\(\)$|(:\d+)+$|<[^<>]*>$|::$/;

/**
 * Guidance gate (research R3.5, brief constraint 5): file paths and backticked names in sidecar text
 * must appear in the evidence or exist in the workspace; returns those that do not. A bare word is
 * a path only with a `/` or a source file's extension, and a name is looked up without its `()`,
 * `:line` or type arguments (D-077).
 */
export function ungroundedReferences(hint: string, evidence: string, cwd: string): string[] {
	const references = new Set<string>();
	// Backticked names (not commands, which contain spaces).
	for (const match of hint.matchAll(/`([^`\s]{2,80})`/g)) if (match[1]) references.add(match[1]);
	for (const match of hint.matchAll(
		/(?:^|[\s(])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w-]+\.[a-z]{1,5})(?::\d+)*(?=[\s),.;:]|$)/gi,
	)) {
		const path = match[1] ?? "";
		if (path.includes("/") || (SOURCE_EXTENSION.test(path) && !PRODUCT_NAME.test(path))) references.add(path);
	}
	return [...references].filter((ref) => {
		let name = ref;
		while (NAME_SUFFIX.test(name)) name = name.replace(NAME_SUFFIX, "");
		return ![ref, name].some((spelling) => evidence.includes(spelling) || existsInWorkspace(spelling, cwd));
	});
}

function existsInWorkspace(ref: string, cwd: string): boolean {
	if (!/^[\w./-]+$/.test(ref)) return false;
	try {
		return existsSync(isAbsolute(ref) ? ref : join(cwd, ref));
	} catch {
		return false;
	}
}
