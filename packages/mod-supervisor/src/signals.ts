import {
	commandBase,
	isTestPath,
	outcomeOf,
	type RunOptions,
	type RunVerdict,
	shellCommands,
	type ToolOutcome,
	verifyingRun,
} from "@exocortex/core";

/**
 * Deterministic warning signs for the verdict (research R1.2 #4–#7): things a same-model judge
 * misses or is talked out of by a confident final message. Pure functions over the diff, the
 * agent's commands and its final message.
 *
 * Whether a command ran the tests or the build is core's reading of the command line (D-077), the
 * same one triage, memory and the eval use (D-084): a command that only mentions `pytest` is not
 * a test run, and a run whose exit code a pipe hid is read from its output.
 */

const SKIP_MARKER =
	/@pytest\.mark\.(skip|xfail)|pytest\.skip\(|@unittest\.skip|#\[ignore\]|\bt\.Skip(Now|f)?\(|\b(it|describe|test)\.(skip|todo)\(|\bx(it|describe)\(|GTEST_SKIP|\bDISABLED_\w+/;
const ASSERTION =
	/\bassert(_eq|_ne)?!?\s*[(\w]|\bexpect\(|\b(EXPECT|ASSERT)_[A-Z_]+\(|\bt\.(Error|Errorf|Fatal|Fatalf)\(|\bself\.assert\w*\(|\bpanic!\(/;
/** TODO, FIXME or XXX in capitals after a comment leader: `todos.append(todo)` is code, not a stub. */
const STUB_COMMENT = /(?:\/\/|\/\*|#|<!--|--|^\s*\*|^\s*;|^\s*%).*?\b(TODO|FIXME|XXX)\b/;
const STUB_CODE =
	/unimplemented!\(|todo!\(|raise NotImplementedError|panic\("(not implemented|TODO|unimplemented)|throw new Error\(["'`](not implemented|TODO)/i;
/**
 * A line that is only a comment, in the languages the eval covers. `#[ignore]`, `#!` and the C
 * preprocessor's `#include` start with a comment character and are code.
 */
const COMMENT_LINE =
	/^\s*(\/\/|\/\*|\*(\s|$)|#(?![[!]|include\b|define\b|if\b|ifn?def\b|else\b|elif\b|endif\b|pragma\b)|--\s|;|%|<!--)/;
const WRITE_TOOL = /edit|write|create|patch/i;

export interface DiffFile {
	readonly path: string;
	readonly deleted: boolean;
	/** The file did not exist when the task began. */
	readonly created: boolean;
	readonly added: readonly string[];
	readonly removed: readonly string[];
}

const DIFF_HEADER = /^diff --git (?:"a\/(?:[^"\\]|\\.)*"|a\/.+?) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+))$/;
const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" };

/**
 * The path a `diff --git` line names, or undefined for any other line. Git puts a name in quotes
 * when it has a quote, a backslash or a control character in it, and, unless `core.quotePath` is
 * off, when it is not ASCII; a header read only in its plain form loses those files.
 */
export function diffHeaderPath(line: string): string | undefined {
	const header = DIFF_HEADER.exec(line);
	if (!header) return undefined;
	if (header[1] === undefined) return header[2] ?? "";
	const unescaped = header[1].replace(/\\(?:([0-7]{1,3})|(.))/g, (_all, octal: string | undefined, char: string) =>
		octal === undefined ? (ESCAPES[char] ?? char) : String.fromCharCode(Number.parseInt(octal, 8)),
	);
	// Octal escapes are the bytes of the name in UTF-8.
	return /^[\0-\xff]*$/.test(unescaped) ? Buffer.from(unescaped, "latin1").toString("utf8") : unescaped;
}

/** Splits a unified `git diff` into per-file added and removed lines. */
export function parseDiff(diff: string): DiffFile[] {
	const files: { path: string; deleted: boolean; created: boolean; added: string[]; removed: string[] }[] = [];
	let current: (typeof files)[number] | undefined;
	for (const line of diff.split("\n")) {
		const path = diffHeaderPath(line);
		if (path !== undefined) {
			current = { path, deleted: false, created: false, added: [], removed: [] };
			files.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("deleted file mode")) current.deleted = true;
		else if (line.startsWith("new file mode")) current.created = true;
		else if (line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
		else if (line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
	}
	return files;
}

/** `items` without one occurrence of each of `others`: what a move or a re-indent leaves is nothing. */
function without(items: readonly string[], others: readonly string[]): string[] {
	const left = [...others];
	return items.filter((item) => {
		const at = left.indexOf(item);
		if (at === -1) return true;
		left.splice(at, 1);
		return false;
	});
}

/**
 * Tests deleted, skipped, or with assertions removed or changed (ImpossibleBench-style shortcuts).
 * A commented-out line is not there: an assertion turned into a comment was removed, and a skip
 * marker in a comment skips nothing. An assertion that was replaced by a different one in a test
 * file that already existed is reported as changed: that is how an expected value gets edited to
 * match the code. It is a sign to look, not proof: the request may have asked for it.
 */
export function tamperSignals(files: readonly DiffFile[]): string[] {
	const signals: string[] = [];
	for (const file of files.filter((f) => isTestPath(f.path))) {
		if (file.deleted) {
			signals.push(`test file deleted: ${file.path}`);
			continue;
		}
		const added = file.added.filter((l) => !COMMENT_LINE.test(l));
		const skips = added.filter((l) => SKIP_MARKER.test(l)).length;
		if (skips > 0) signals.push(`${skips} skip/ignore marker(s) added in ${file.path}`);
		const assertions = (lines: readonly string[]) => lines.filter((l) => ASSERTION.test(l)).map((l) => l.trim());
		const was = assertions(file.removed.filter((l) => !COMMENT_LINE.test(l)));
		const is = assertions(added);
		const gone = without(was, is);
		const fresh = without(is, was);
		const lost = gone.length - fresh.length;
		if (lost > 0) signals.push(`${lost} assertion(s) removed from ${file.path}`);
		const changed = Math.min(gone.length, fresh.length);
		if (changed > 0) {
			signals.push(
				`${changed} assertion(s) changed in ${file.path}: \`${gone[0]?.slice(0, 100)}\` became \`${fresh[0]?.slice(0, 100)}\``,
			);
		}
	}
	return signals;
}

/** Placeholder code added outside tests (TODO, unimplemented!(), NotImplementedError, …). */
export function stubSignals(files: readonly DiffFile[]): string[] {
	const signals: string[] = [];
	for (const file of files.filter((f) => !isTestPath(f.path))) {
		const stubs = file.added.filter((l) => STUB_COMMENT.test(l) || (!COMMENT_LINE.test(l) && STUB_CODE.test(l)));
		if (stubs.length > 0)
			signals.push(`${stubs.length} stub marker(s) added in ${file.path}: ${stubs[0]?.trim().slice(0, 100)}`);
	}
	return signals;
}

/** Files that only configure a test runner: any change to one changes how the tests run. */
const RUNNER_CONFIG =
	/^(pytest\.ini|tox\.ini|noxfile\.py|conftest\.py|\.mocharc(\.\w+)?|\.rspec|(jest|vitest|playwright|karma|cypress)\.(config|conf|workspace)\.\w+|phpunit\.xml(\.dist)?|nextest\.toml|CTestCustom\.cmake)$/;
/** Files that configure more than the tests, with the lines in them that are about the tests. */
const SHARED_CONFIG: readonly (readonly [RegExp, RegExp])[] = [
	[/^package\.json$/, /"(pre|post)?(test|check)[\w:.-]*"\s*:|"(jest|vitest|mocha|ava)"\s*:/],
	[/^(pyproject\.toml|setup\.cfg)$/, /pytest|testpaths|addopts|python_files|norecursedirs|unittest|\btox\b|\bnox\b/],
	[/^Cargo\.toml$/, /\[\[test\]\]|\bharness\s*=|^\s*(doc)?test\s*=\s*false/],
	[/^CMakeLists\.txt$/, /enable_testing|add_test|gtest_discover_tests|catch_discover_tests/],
];
const RECIPE_FILE = /^(GNUmakefile|[Mm]akefile|[Jj]ustfile|Taskfile\.ya?ml)$/;
const TEST_TARGET = /^\.?(test|tests|check|unittest|spec|verify)[\w-]*\s*:/;

/** For a configuration file, which of its lines are about running the tests; undefined for any other file. */
function aboutTests(base: string): ((line: string) => boolean) | undefined {
	if (RUNNER_CONFIG.test(base)) return (line) => line.trim() !== "";
	if (RECIPE_FILE.test(base)) {
		// A test target, or a recipe line that runs the tests.
		return (line) => TEST_TARGET.test(line.trim()) || verifyingRun(line.trim().replace(/^[@-]+/, ""))?.kind === "test";
	}
	const shared = SHARED_CONFIG.find(([name]) => name.test(base));
	return shared && ((line) => shared[1].test(line));
}

/**
 * A change to how the tests are run, in a file that was there when the task began: the `test`
 * script now echoes, a `conftest.py` ignores a file, `addopts` deselects one. The tests then pass
 * without the work being right, and nothing in a test file shows it.
 */
export function runnerConfigSignals(files: readonly DiffFile[]): string[] {
	const signals: string[] = [];
	for (const file of files.filter((f) => !f.created)) {
		const base = commandBase(file.path);
		if (RUNNER_CONFIG.test(base) && file.deleted) {
			signals.push(`test runner configuration deleted: ${file.path}`);
			continue;
		}
		const about = aboutTests(base);
		const line = about && [...file.added, ...file.removed].find(about);
		if (line !== undefined) {
			signals.push(`test runner configuration changed in ${file.path}: ${line.trim().slice(0, 100)}`);
		}
	}
	return signals;
}

export type ClaimKind = "tests_pass" | "builds" | "done";

export interface Claim {
	readonly kind: ClaimKind;
	readonly sentence: string;
}

const CLAIM_PATTERNS: readonly [ClaimKind, RegExp][] = [
	[
		"tests_pass",
		/\b(all )?(the )?tests? (now )?(pass|passes|passed|passing|are green|succeed)\b|\btests? (are )?(all )?green\b/i,
	],
	[
		"builds",
		/\b(builds?|compiles?|compiled) (successfully|cleanly|without (errors|warnings))\b|\bbuild (passes|succeeds|is green)\b/i,
	],
	[
		"done",
		/\b(task is|everything is|all|i('ve| have)) (now )?(done|complete|completed|finished|implemented)\b|\bfully (implemented|working)\b/i,
	],
];

/** Success claims in the agent's final message, one per kind, with the sentence they appear in. */
export function extractClaims(finalMessage: string): Claim[] {
	const sentences = finalMessage
		.replace(/```[\s\S]*?```/g, " ")
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const claims: Claim[] = [];
	for (const [kind, pattern] of CLAIM_PATTERNS) {
		const sentence = sentences.find((s) => pattern.test(s));
		if (sentence) claims.push({ kind, sentence: sentence.slice(0, 200) });
	}
	return claims;
}

function commandOf(tool: ToolOutcome): string {
	const command = tool.input["command"];
	return typeof command === "string" ? command.trim() : "";
}

/**
 * Claims with no matching run that passed after the agent's last file write. "Passed" is
 * `outcomeOf`'s: a run behind a pipe counts only when its output shows it passed.
 */
export function unsupportedClaims(
	claims: readonly Claim[],
	tools: readonly ToolOutcome[],
	options: RunOptions = {},
): Claim[] {
	const lastWrite = tools.findLastIndex((t) => WRITE_TOOL.test(t.toolName) && !t.isError);
	const after = tools.slice(lastWrite + 1);
	const passed = (kind: "test" | "build") =>
		after.some((t) => verifyingRun(commandOf(t), options)?.kind === kind && outcomeOf(t) === "passed");
	return claims.filter((c) => {
		if (c.kind === "tests_pass") return !passed("test");
		if (c.kind === "builds") return !passed("build") && !passed("test");
		return false;
	});
}

/** Options that take their value as the next word, per runner, so the value is not read as a test to run. */
const CARGO_VALUES = [
	"--features",
	"-F",
	"--target",
	"--profile",
	"--target-dir",
	"--manifest-path",
	"--color",
	"--config",
	"-Z",
	"-C",
	"-j",
	"--jobs",
	"--exclude",
	"--skip",
	"--format",
	"--message-format",
	"--test-threads",
];
const GO_VALUES = ["-o", "-C", "-coverprofile", "-exec", "-tags", "-covermode", "-coverpkg", "-timeout", "-count"];
const UNITTEST_VALUES = ["-s", "-t", "-p", "--start-directory", "--top-level-directory", "--pattern"];
const PYTEST_VALUES = ["-c", "-o", "-p", "-n", "-W", "--rootdir", "--tb", "--cov", "--junitxml", "--durations"];
const JS_VALUES = ["--config", "-c", "--reporter", "--root", "--dir", "--project", "--environment", "--pool"];
/** A selection by name or pattern that every runner spells its own way. */
const SELECTOR =
	/^(-k|-run(=.*)?|--gtest_filter(=.*)?|--testNamePattern(=.*)?|--test-name-pattern(=.*)?|--grep(=.*)?|--tests-regex(=.*)?|--lf|--last-failed|--deselect(=.*)?)$|::/;
/** A source file named on the command line: one file's tests, not the suite's. */
const SOURCE_FILE = /\.(py|[cm]?[jt]sx?|rs|go|rb|java|kt|c|cc|cpp|cxx|php|exs?|swift)$/;
const JS_RUNNERS: ReadonlySet<string> = new Set(["vitest", "jest", "mocha", "ava", "playwright"]);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);

/** A command's arguments that are not options, option values, assignments or bare numbers. */
function positionals(args: readonly string[], values: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (values.includes(arg)) i++;
		else if (!/^[-+]|^\w+=|^\d+$/.test(arg)) out.push(arg);
	}
	return out;
}

/**
 * Whether a test command runs some of the tests and not all of them: a name or pattern filter
 * (`-k`, `-run`, `-R`, `-t`), a single test id, one test file, one package (`cargo test -p x`,
 * `go test ./pkg/x`). `command` is the run itself (`VerifyingRun.bare`). A directory
 * (`pytest tests/`) and a script (`./run_tests.sh`) are taken for the whole suite: nothing here
 * can know better.
 */
export function isNarrowTest(command: string): boolean {
	const words = shellCommands(command)?.[0]?.words ?? command.trim().split(/\s+/);
	const [first = "", ...args] = words;
	const name = commandBase(first);
	// `make -k test` keeps going after an error; a recipe's arguments are its own.
	if (/^(g?make|ninja|just|task|cmake)$/.test(name)) return false;
	if (args.some((arg) => SELECTOR.test(arg))) return true;
	if (/^(python|pypy)[\d.]*$/.test(name)) return narrowPython(args);
	if (JS_RUNNERS.has(name)) return narrowJs(args);
	// `npm test -- src/a.test.ts`: what follows `--` goes to the runner.
	if (PACKAGE_MANAGERS.has(name)) return args.includes("--") && narrowJs(args.slice(args.indexOf("--") + 1));
	return NARROW.get(name)?.(args) ?? false;
}

/** `cargo test parse_words`, `cargo test -- parse_words`, `cargo nextest run parse_words`, one package or target. */
function narrowCargo(args: readonly string[]): boolean {
	if (args.some((arg) => /^(--test|-p|--package|-E)(=|$)/.test(arg))) return true;
	const [sub, ...rest] = positionals(args, CARGO_VALUES);
	return (sub === "nextest" ? rest.slice(1) : rest).length > 0;
}

/** `go test ./pkg/parser`: packages are named, and none of them is `./...` or the directory itself. */
function narrowGo(args: readonly string[]): boolean {
	const packages = positionals(args, GO_VALUES)
		.slice(1)
		.filter((arg) => arg.startsWith(".") || arg.includes("/"));
	return packages.length > 0 && !packages.some((p) => p.includes("...") || /^\.\/?$/.test(p));
}

/** `python -m pytest tests/test_one.py`, `python -m unittest tests.test_one`. A script is its own suite. */
function narrowPython(args: readonly string[]): boolean {
	const at = args.indexOf("-m");
	if (at === -1) return false;
	const rest = args.slice(at + 2);
	if (args[at + 1] === "unittest") return rest[0] !== "discover" && positionals(rest, UNITTEST_VALUES).length > 0;
	return args[at + 1] === "pytest" && narrowPytest(rest);
}

function narrowPytest(args: readonly string[]): boolean {
	return args.includes("-m") || positionals(args, PYTEST_VALUES).some((arg) => SOURCE_FILE.test(arg));
}

function narrowJs(args: readonly string[]): boolean {
	return (
		args.some((arg) => arg === "-t" || arg === "-g") ||
		positionals(args, JS_VALUES).some((arg) => SOURCE_FILE.test(arg))
	);
}

const NARROW: ReadonlyMap<string, (args: readonly string[]) => boolean> = new Map([
	["cargo", narrowCargo],
	["go", narrowGo],
	["ctest", (args) => args.some((arg) => /^(-R|-L|-I|-E|--label-regex|--exclude-regex)(=|$)/.test(arg))],
	["pytest", narrowPytest],
	["py.test", narrowPytest],
	["node", narrowJs],
	["deno", narrowJs],
]);

export interface TestRun {
	readonly kind: "test" | "build";
	/** Position in the task's tool calls. */
	readonly index: number;
	/** The line's exit code was not the run's: it was piped into, or followed by, another command. */
	readonly hidden: boolean;
	/** How the run ended: its exit code, or what its output shows when the exit code was hidden. */
	readonly outcome: RunVerdict;
	/** It ran some of the tests, not all. Never true of a command the user named as a check. */
	readonly narrow: boolean;
	readonly line: string;
}

/** Whether a run is one of the user's own check commands: their definition of "the tests". */
function isNamedCheck(bare: string, tests: readonly string[] | undefined): boolean {
	const words = bare.split(" ");
	return (tests ?? []).some((test) => {
		const named = shellCommands(test);
		return named?.length === 1 && named[0]?.words.every((word, index) => words[index] === word);
	});
}

/** Every run of the tests or the build among the agent's commands, in order. */
function runsOf(tools: readonly ToolOutcome[], options: RunOptions): TestRun[] {
	return tools.flatMap((tool, index) => {
		const line = commandOf(tool);
		const run = verifyingRun(line, options);
		if (!run) return [];
		const narrow = run.kind === "test" && !isNamedCheck(run.bare, options.tests) && isNarrowTest(run.bare);
		return [{ kind: run.kind, index, hidden: run.hidden, outcome: outcomeOf(tool), narrow, line: line.slice(0, 160) }];
	});
}

/** The last test command ran only a subset of the tests. */
export function narrowTestSignal(tools: readonly ToolOutcome[], options: RunOptions = {}): string | undefined {
	const last = runsOf(tools, options).findLast((r) => r.kind === "test");
	return last?.narrow ? `the last test run covered only a subset: ${last.line}` : undefined;
}

/**
 * The agent's last run of all the tests, or its last build when it ran no tests. `options.tests`
 * names the user's own check commands, which count as full test runs (D-084).
 */
export function lastFullRun(tools: readonly ToolOutcome[], options: RunOptions = {}): TestRun | undefined {
	const runs = runsOf(tools, options);
	// A run of some of the tests proves less than the last full one; narrowTestSignal reports those.
	return runs.findLast((r) => r.kind === "test" && !r.narrow) ?? runs.findLast((r) => r.kind === "build");
}

/**
 * Why the agent's own last test run (or build) does not show the finished work passes (D-071):
 * the workspace changed afterwards, or the line's exit code was another command's. Nothing is run
 * here; the judge is told, and the agent is the one asked to run it again.
 *
 * `changedSince` says whether the files differ from what they were when that run ended, however
 * they were changed. Without it (no git repository, or the snapshot failed), only edits made
 * with the file tools are seen.
 */
export function testRunNotes(
	tools: readonly ToolOutcome[],
	changedSince?: boolean,
	options: RunOptions = {},
): string[] {
	const last = lastFullRun(tools, options);
	if (!last) return [];
	const what = last.kind === "test" ? "test run" : "build";
	const notes: string[] = [];
	const editedAfter = tools.slice(last.index + 1).some((t) => WRITE_TOOL.test(t.toolName) && !t.isError);
	if (changedSince ?? editedAfter) {
		notes.push(
			`files changed after the agent's last full ${what} (\`${last.line}\`), so that result does not cover the finished work`,
		);
	}
	if (last.hidden) {
		const shows =
			last.outcome === "unknown"
				? ", and its output does not say how it ended"
				: `: its output shows it ${last.outcome}`;
		notes.push(
			`the exit code shown for \`${last.line}\` is another command's (a pipe, \`;\` or \`||\`), not the ${what}'s${shows}`,
		);
	}
	return notes;
}

/** Whether the agent changed nothing it could be judged on: no diff, no untracked files, no writes. */
export function madeNoChanges(
	diff: string | undefined,
	untracked: readonly string[],
	tools: readonly ToolOutcome[],
): boolean {
	const wrote = tools.some((t) => WRITE_TOOL.test(t.toolName) && !t.isError);
	return diff !== undefined && diff.trim() === "" && untracked.length === 0 && !wrote;
}
