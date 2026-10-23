import { cleanTerminalOutput, isWrapperLine, lineVerdicts, normalizeErrorLine } from "@exocortex/core";

/**
 * Names that say nothing about which problem it was: what every failure of a kind prints, and
 * the pieces of common file names and library paths.
 */
const FILLER = new Set([
	...["error", "errors", "fail", "failed", "failure", "failures", "test", "tests", "main", "self", "none", "true"],
	...["false", "left", "right", "expected", "actual", "got", "want", "src", "lib", "mod", "std", "cpp", "hpp", "com"],
	...["assertionerror", "nil", "null", "usr", "bin", "the", "and", "not", "stdout", "stderr", "run"],
]);

/** Text in quotes or backticks: compilers and test runners quote the names they talk about. */
const QUOTED = /["'`‘]([^"'`‘’\n]{1,120})["'`’]/g;
/** Looks like an identifier, not a word of a message: `snake_case`, `camelCase`, `E0502`, `ipv4`. */
const IDENTIFIER = /_|[a-z][A-Z]|[A-Za-z]\d/;
/** A dotted or `::` path: `tests.test_cli.DueDateTest`, `render.rs`, `parser::tests`. */
const DOTTED = /\w(\.|::)\w/;
/** One name in quotes, as a module, key or attribute is quoted: `'yaml'`, `"user_id"`. */
const ONE_NAME = /^[A-Za-z_][\w.:-]*$/;
/**
 * A line that compares values: what it quotes is data (`assert 'hi bob' == 'hello bob'`,
 * `expected '' to be 'x'`), not the names of what failed.
 */
const COMPARES = /==|!=|\b(expected|assert|got|actual|left|right|to (be|equal))\b/i;
/**
 * Paths that change from run to run: temporary directories (`/tmp/pytest-of-u/pytest-12/x0`,
 * `/var/folders/…`) and the random names `mkdtemp` makes.
 */
const VOLATILE = /(?:\/private)?\/(?:tmp|var\/folders|var\/tmp)\/\S*|\btmp[\w-]*\d[\w-]*/gi;
/**
 * A heading a runner prints above one failure (`____ test_one ____`, `---- simple_table stdout ----`,
 * `=== RUN   TestA`): where one failure's lines end and the next one's start.
 */
const HEADING = /^\s*(?:_{3,}|-{3,}|={3,}|─{3,})\s*\S/;
/**
 * A failing test's title line, which names it in words: Jest's `● suite › test`, Vitest's
 * `FAIL file > suite > test`. It starts a failure, and its words are its name.
 */
const TITLE = /^\s*(?:●\s+\S|FAIL\s+\S+ > \S)/;
/**
 * Lines that sum up or wrap a failure instead of saying what failed (D-109; core's `isWrapperLine`
 * for `make: ***` and the like): a count, a file or package that failed, a crash's opening line.
 * Every failure of a toolchain prints them, so a card keyed on one would come back for any failure
 * in the repo. They are not a problem's key, and an output that shows nothing else (its error cut
 * off by `| tail`) teaches nothing.
 */
const SUMMARY: readonly RegExp[] = [
	/^Traceback \(most recent call last\):$/,
	/^FAIL$/,
	// Go's package line, Jest's file line: `FAIL\tpkg\t0.01s`, `FAIL src/a.test.js (5 ms)`
	/^FAIL\s+\S+(\s+(\[[^\]]*\]|[\d.]+\s*m?s|\([^)]*\)))?$/,
	// unittest's result, pytest's counts
	/^FAILED \(/,
	/^=*\s*(\d+ [\w ]+, )*\d+ (failed|errors?)\b[^=]*=*$/,
	/^failures:$/,
	/^test result: FAILED\b/,
	/^Summary \[/,
	/^(Test Files|Tests|Test Suites):?\s+\d+ failed\b/,
	/^\d+ failing$/,
	/^(#|ℹ) fail \d+$/,
	/^FAILED \| \d+ passed\b/,
	/^\d+% tests passed\b/,
	/^\[\s+FAILED\s+\] \d+ tests?\b/,
	/^npm ERR!/,
	/\bELIFECYCLE\b/,
	/^error: Recipe `[^`]*` failed/,
];

/** Failure lines a failure is read by, for its keys and its names: a problem may not come first. */
const MAX_FAILURE_LINES = 100;
/** Lines read below a failure's first line for the names of that failure. */
const BLOCK_LINES = 30;
/** How far above its first failure line a failure's heading may be. */
const HEADING_ABOVE = 20;
const MAX_CARD_WORDS = 24;

/** An output's lines, read for how the run failed (D-077). */
interface Reading {
	readonly lines: readonly string[];
	/** For each line: whether it says what failed (a failure line of the kind the output is read by, not a summary). */
	readonly failing: readonly boolean[];
}

/** Whether a line only sums up or wraps a failure. */
function isSummary(line: string): boolean {
	const trimmed = line.trim();
	return !TITLE.test(trimmed) && (isWrapperLine(trimmed) || SUMMARY.some((pattern) => pattern.test(trimmed)));
}

/**
 * The lines that say what failed: a toolchain's own failure and crash lines and test titles, or,
 * when the toolchain printed none at all, the lines that mention an error. Summaries are left out
 * (D-109); when they are all a toolchain printed, its error was cut off, and nothing is read. A
 * line a toolchain prints beside an error (a log line, a linker note) names things the problem is
 * not about.
 */
function read(output: string): Reading {
	const lines = cleanTerminalOutput(output).split("\n");
	const kinds = lineVerdicts(lines).map((verdict, i) =>
		TITLE.test(lines[i] ?? "") ? "specific" : verdict === "mention" ? "generic" : verdict && "specific",
	);
	const wanted = kinds.includes("specific") ? "specific" : "generic";
	return {
		lines,
		failing: kinds.map((kind, i) => kind === wanted && (lines[i] ?? "").trim() !== "" && !isSummary(lines[i] ?? "")),
	};
}

/** A problem's key: the tool and the error line with its volatile parts normalized (D-109: no exit code). */
export function problemKey(toolName: string, line: string): string {
	return `${toolName}|${normalizeErrorLine(line)}`;
}

/**
 * The line a failure is known by (D-109): its first line that says what failed, past summaries
 * and wrappers (`Traceback (most recent call last):`, `FAILED (errors=1)`, `FAIL src/a.test.js`).
 * None when the output shows only those.
 */
export function anchorOf(output: string): { readonly line: string; readonly index: number } | undefined {
	const { lines, failing } = read(output);
	const index = failing.indexOf(true);
	return index === -1 ? undefined : { line: (lines[index] ?? "").trim(), index };
}

/** What a failing output is, for asking whether a known problem is in it. */
export interface Failure {
	/** The key of each line that says what failed (D-109): a card is found whichever its problem is. */
	readonly keys: ReadonlySet<string>;
	/** The key of its anchor: a card with no names matches only there. */
	readonly anchor: string | undefined;
	/** The names it mentions (D-072). */
	readonly names: ReadonlySet<string>;
}

/** Reads a failing output's keys and names, from its first {@link MAX_FAILURE_LINES} failure lines. */
export function failureOf(toolName: string, output: string): Failure {
	const { lines, failing } = read(output);
	const keys = new Set<string>();
	const names = new Set<string>();
	let anchor: string | undefined;
	let taken = 0;
	for (const [index, line] of lines.entries()) {
		if (failing[index]) {
			if (++taken > MAX_FAILURE_LINES) break;
			const key = problemKey(toolName, line.trim());
			anchor ??= key;
			keys.add(key);
			namesIn(line, names);
		} else if (HEADING.test(line)) titleWords(line, names);
	}
	return { keys, anchor, names };
}

/**
 * The names one line mentions (D-072, D-109): dotted or `::` paths and identifier-like tokens, and
 * from quoted text, one quoted name (`'yaml'`) or the identifier-like tokens of a longer quote.
 * Plain words of the message are left out: they are the same for every problem of the kind, and
 * the key already holds them. So are what a comparison quotes (assertion data) and temporary paths.
 */
function namesIn(raw: string, into: Set<string>): void {
	const line = raw.replace(VOLATILE, " ");
	const add = (text: string) => {
		for (const word of text.toLowerCase().split(/[^a-z0-9_]+/)) {
			if (word.length >= 3 && /^[a-z_]*[a-z]/.test(word) && !FILLER.has(word)) into.add(word);
		}
	};
	const tokens = (text: string) => {
		for (const chunk of text.split(/[^A-Za-z0-9_.:]+/)) {
			if (DOTTED.test(chunk) || IDENTIFIER.test(chunk)) add(chunk);
		}
	};
	const data = COMPARES.test(line);
	for (const match of line.matchAll(QUOTED)) {
		const quoted = match[1] ?? "";
		if (!data && ONE_NAME.test(quoted)) add(quoted);
		else tokens(quoted);
	}
	tokens(line.replace(QUOTED, " "));
}

/**
 * All the words of a heading or a test's title (`____ test_one ____`, `● sum › adds numbers`): it
 * is nothing but the failure's name, often in plain words.
 */
function titleWords(line: string, into: Set<string>): void {
	for (const word of line
		.replace(VOLATILE, " ")
		.toLowerCase()
		.split(/[^a-z0-9_]+/)) {
		if (word.length >= 3 && /^[a-z_]*[a-z]/.test(word) && !FILLER.has(word)) into.add(word);
	}
}

/** Where one failure ends and the next starts: a heading, or another test's title. */
function startsFailure(line: string): boolean {
	return HEADING.test(line) || TITLE.test(line);
}

/**
 * The names of the one failure whose first line is line `index` (D-109): its heading above, if
 * the runner printed one, and its failure lines down to the next heading or the next failure of
 * the same kind (`test other_one ... FAILED` after `test simple_table ... FAILED`). The names of
 * the other failures in the output are not this problem's: with them a card would not be found
 * when its problem comes back alone.
 */
export function cardDetail(output: string, index: number): string[] {
	const { lines, failing } = read(output);
	const anchor = lines[index] ?? "";
	const names = new Set(identityOf(lines, failing, index));
	const end = Math.min(lines.length, index + 1 + BLOCK_LINES);
	for (let at = index + 1; at < end; at++) {
		const line = lines[at] ?? "";
		if (startsFailure(line) || (failing[at] && sameKind(line, anchor))) break;
		if (failing[at]) namesIn(line, names);
	}
	return [...names].slice(0, MAX_CARD_WORDS);
}

/**
 * What the failure at line `index` is named by (D-109): its heading's or title's words when the
 * runner printed one (the test's name), else the names on its own line. A pass narrowed to the
 * test names these; it never prints the failure's message.
 */
export function identity(output: string, index: number): string[] {
	const { lines, failing } = read(output);
	return identityOf(lines, failing, index).slice(0, MAX_CARD_WORDS);
}

function identityOf(lines: readonly string[], failing: readonly boolean[], index: number): string[] {
	const names = new Set<string>();
	const own = lines[index] ?? "";
	if (TITLE.test(own)) titleWords(own, names);
	for (let above = index - 1; names.size === 0 && above >= Math.max(0, index - HEADING_ABOVE); above--) {
		const line = lines[above] ?? "";
		if (startsFailure(line)) {
			titleWords(line, names);
			break;
		}
		if (failing[above]) break;
	}
	if (names.size === 0) namesIn(own, names);
	return [...names];
}

/** The failure line with `key`, else the failure's anchor: where a known problem is in an output. */
export function lineOf(toolName: string, output: string, key: string): { readonly index: number } | undefined {
	const { lines, failing } = read(output);
	const index = lines.findIndex((line, i) => failing[i] && problemKey(toolName, line.trim()) === key);
	return index === -1 ? anchorOf(output) : { index };
}

/**
 * Whether a failure line starts another failure of the anchor's kind: it opens with the same word
 * (`FAILED`, `error[E0308]:`, `test`), numbers aside. A one-character opener (pytest's `E`, a `>`
 * or `|` of quoted source) continues the failure above it.
 */
function sameKind(line: string, anchor: string): boolean {
	const opener = (text: string) => normalizeErrorLine(text).split(/\s+/)[0] ?? "";
	const first = opener(line);
	return first.length > 1 && first === opener(anchor);
}

/**
 * How much of a card's problem is in a failure: the share of the card's names the failure also
 * mentions. A card with no names counts as present here; `problemIn` then asks for its key on the
 * failure's anchor.
 */
export function detailShare(card: readonly string[], failure: ReadonlySet<string>): number {
	if (card.length === 0) return 1;
	return card.filter((word) => failure.has(word)).length / card.length;
}

/** Every word of a text, split as names are, for asking whether a run names a problem's things. */
export function wordsOf(text: string): Set<string> {
	return new Set(text.toLowerCase().split(/[^a-z0-9_]+/));
}
