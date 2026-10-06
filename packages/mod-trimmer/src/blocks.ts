import { classifyErrorLine, isRoutineLine, lineVerdicts } from "@exocortex/core";

/**
 * How much a block says about why the run failed (D-083). When there are more blocks than fit,
 * a higher rank is shown before a lower one, wherever the two sit in the output.
 * - 4: a failure with a name: a failing test, a compiler error, a crash report.
 * - 3: a failure's message standing alone (pytest's `E   …`, a bare exception line).
 * - 2: a line the toolchain prints beside errors that proves nothing (a log with a position).
 * - 1: a line that mentions an error in its own words.
 */
type Rank = 1 | 2 | 3 | 4;

/** A run of lines that belong together: an error with what explains it. Indices are inclusive. */
export interface Block {
	readonly start: number;
	readonly end: number;
	readonly rank: Rank;
	/** The line that names the failure: shown even when the block itself is not. */
	readonly header: number;
	/** The lines that carry the failure (its name, place and message), kept when the block is cut short. */
	readonly keys: readonly number[];
}

/** A structural block never runs further than this without its closing line. */
const MAX_STRUCTURE_LINES = 400;
const MAX_KEYS = 14;

/** Lines that continue the diagnostic above them even though they are not indented. */
const CONTINUATION =
	/^(Traceback \(most recent call last\):|[-=]{5,}$|E {3}|\d+ +\||\S+:\d+(:\d+)?: note: |\S+: In (function|member function|instantiation|constructor|destructor|lambda) |In file included from )/;

const TRACEBACK = /^\s*Traceback \(most recent call last\):\s*$/;
const TRACEBACK_CHAIN =
	/^\s*(During handling of the above exception, another exception occurred:|The above exception was the direct cause of the following exception:)\s*$/;
const GO_CRASH = /^(panic: |fatal error: )/;
const GO_STACK = /^(goroutine \d+ \[|runtime stack:)/;
const RUST_PANIC = /^thread '.*'( \(\d+\))? panicked at /;
const RULE = /^={10,}$/;
const DATA_RACE = /^WARNING: (DATA RACE|ThreadSanitizer: )/;
const SANITIZER = /^(==\d+==\s*)?(ERROR|WARNING): (Address|Leak|Thread|Memory|UndefinedBehavior|HWAddress)Sanitizer\b/;
const SANITIZER_END = /^SUMMARY: \w+Sanitizer\b|^==\d+==ABORTING/;
/** The start of one of a sanitizer report's stacks: `freed by thread T0 here:`, `Previous read at … by goroutine 8:`. */
const REPORT_PART = /^\S.*( here:| by (goroutine|thread) \S+:| created at:)$/;
const PYTEST_REPORT = /^=+ (FAILURES|ERRORS) =+$/;
const PYTEST_BANNER = /^={3,} .+ ={3,}$/;
const PYTEST_CASE = /^_{3,} .+ _{3,}$/;
const CARGO_CAPTURE = /^---- .+ (stdout|stderr) ----$/;
const CARGO_SECTION = /^(---- .+ ----|failures:)$/;
const GO_TEST_MARK = /^=== (RUN|CONT|NAME|PAUSE)\s+(\S+)/;
const GO_TEST_RESULT = /^\s*--- (PASS|FAIL|SKIP|BENCH): (\S+)/;
const GO_TEST_END = /^(PASS|FAIL|ok\s|exit status \d+)/;
const GO_TEST_LOG = /^\s+\S+_test\.go:\d+: /;

const isBlank = (line: string | undefined) => line === undefined || line.trim() === "";
const indentOf = (line: string) => line.length - line.trimStart().length;

interface Extent {
	readonly end: number;
	readonly header?: number;
	readonly keys: readonly number[];
}

/**
 * Finds the blocks in an output's lines: every error line with the lines that belong to it, in
 * order, never overlapping. The trimmer's selection works on these, not on single lines, so a
 * traceback keeps its exception, a panic its frames, and a failing test its name (D-083).
 *
 * Whether a line is an error is core's reading (`lineVerdicts` for what proves a failure,
 * `classifyErrorLine` for what is worth keeping, D-077). What is added here is structure the
 * line grammar cannot see: reports with an opening and a closing line, and whose test a Go log
 * line belongs to.
 */
export function findBlocks(lines: readonly string[]): Block[] {
	const verdicts = lineVerdicts(lines);
	const go = goTestSections(lines);
	const blocks: Block[] = [];
	let pytestReport = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (PYTEST_BANNER.test(line)) pytestReport = PYTEST_REPORT.test(line);
		const failing = go.failing.get(i);
		const extent =
			(failing !== undefined ? goTestExtent(lines, i, failing) : undefined) ??
			structureAt(lines, i) ??
			(pytestReport && PYTEST_CASE.test(line) ? pytestCase(lines, i) : undefined);
		const rank = extent ? 4 : lineRank(line, verdicts[i], go.passing.has(i));
		if (rank === undefined) continue;
		const { end, header, keys } = extent ?? diagnostic(lines, i);
		blocks.push({ start: i, end, rank, header: header ?? i, keys: keysOf(i, end, [header ?? i, ...keys]) });
		i = end;
	}
	return blocks;
}

/** A block that has its own shape, wherever its lines are indented or not; undefined when `i` opens none. */
function structureAt(lines: readonly string[], i: number): Extent | undefined {
	const line = lines[i] ?? "";
	if (RULE.test(line) && DATA_RACE.test(lines[i + 1] ?? "")) return report(lines, i + 1);
	if (DATA_RACE.test(line) || SANITIZER.test(line)) return report(lines, i);
	if (CARGO_CAPTURE.test(line)) return cargoCapture(lines, i);
	// libtest's list of the tests that failed: names, indented under the word.
	if (line === "failures:" && /^\s+\S/.test(lines[i + 1] ?? "")) return diagnostic(lines, i);
	if (TRACEBACK.test(line)) return traceback(lines, i);
	if (GO_CRASH.test(line)) return goCrash(lines, i);
	if (RUST_PANIC.test(line)) return rustPanic(lines, i);
	return undefined;
}

function lineRank(line: string, verdict: string | undefined, inPassingGoTest: boolean): Rank | undefined {
	// A passing test's log is not an error, whatever a failing test elsewhere makes of its shape.
	if (inPassingGoTest) return classifyErrorLine(line.replace(GO_TEST_LOG, "")) === undefined ? undefined : 1;
	if (verdict === "failed") return /^\s*E {3}/.test(line) ? 3 : 4;
	if (verdict === "error") return 3;
	const kind = classifyErrorLine(line);
	if (kind === "specific") return 2;
	// A routine line that only mentions an error (`test retries_on_failure ... ok`) is still routine.
	return kind === "generic" && !isRoutineLine(line) ? 1 : undefined;
}

function keysOf(start: number, end: number, keys: readonly number[]): number[] {
	const inside = new Set(keys.filter((key) => key >= start && key <= end));
	return [...inside].slice(0, MAX_KEYS).sort((a, b) => a - b);
}

/**
 * The lines under an error line that are indented or continue the diagnostic (a rustc snippet,
 * gcc's notes, TAP diagnostics, the names under `failures:`), as RTK's block filters keep a
 * failure whole. A traceback under the line (unittest's `FAIL: test_x`) is followed to its end.
 */
function diagnostic(lines: readonly string[], i: number): Extent {
	let end = i;
	// One Go test log line does not continue into the next: each is its own statement.
	const goLog = GO_TEST_LOG.test(lines[i] ?? "");
	while (end + 1 < lines.length && end - i < MAX_STRUCTURE_LINES) {
		const next = lines[end + 1] ?? "";
		if (goLog && GO_TEST_LOG.test(next)) break;
		if (TRACEBACK.test(next)) {
			const inner = traceback(lines, end + 1);
			return { end: inner.end, keys: inner.keys };
		}
		if (isBlank(next) || isRoutineLine(next) || !(/^\s/.test(next) || CONTINUATION.test(next))) break;
		end++;
	}
	return { end, keys: [] };
}

/** From `i` to the line before the next blank one. */
function paragraph(lines: readonly string[], i: number): Extent {
	let end = i;
	while (end + 1 < lines.length && end - i < MAX_STRUCTURE_LINES && !isBlank(lines[end + 1])) end++;
	return { end, keys: range(i, Math.min(end, i + 4)) };
}

/**
 * A Python traceback: its frames (indented under it) and the exception line after them, which
 * is the first line back at the traceback's own indentation, with the lines its message runs
 * over. A chained traceback ("During handling of the above exception…") is part of the same block.
 */
function traceback(lines: readonly string[], i: number): Extent {
	const base = indentOf(lines[i] ?? "");
	const keys = [i];
	let end = i;
	const under = (at: number) => !isBlank(lines[at]) && indentOf(lines[at] ?? "") > base;
	for (let at = i, chained = 0; chained < 8; chained++) {
		let frame = at + 1;
		while (under(frame)) frame++;
		end = frame - 1;
		if (!isBlank(lines[frame]) && frame - at > 1) {
			// The exception line, the frame it was raised in (two lines), and the rest of its message.
			keys.push(frame - 2, frame - 1, frame);
			end = frame;
			while (end - frame < 10 && under(end + 1)) end++;
		}
		const link = isBlank(lines[end + 1]) ? end + 2 : end + 1;
		const next = isBlank(lines[link + 1]) ? link + 2 : link + 1;
		if (!TRACEBACK_CHAIN.test(lines[link] ?? "") || !TRACEBACK.test(lines[next] ?? "")) break;
		keys.push(next);
		at = next;
		end = next;
	}
	return { end, keys };
}

/** A Rust panic: where it happened, then its message, a note and a backtrace if there is one. */
function rustPanic(lines: readonly string[], i: number): Extent {
	let end = i;
	while (end - i < MAX_STRUCTURE_LINES) {
		const next = lines[end + 1];
		if (next === undefined || isBlank(next) || isRoutineLine(next) || /^test .+ \.\.\. \w+$/.test(next)) break;
		if (end - i >= 6 && !/^\s|^(stack backtrace:|note: )/.test(next)) break;
		end++;
	}
	return { end, keys: range(i, Math.min(end, i + 4)) };
}

/**
 * A Go panic or runtime fatal error: its message lines, then, after one blank line, the stacks
 * (`goroutine N [running]:` paragraphs). The first stack is the one that crashed.
 */
function goCrash(lines: readonly string[], i: number): Extent {
	let end = i;
	// `panic: … [recovered]` repeats itself indented, and a signal line may follow.
	while (end - i < 12 && /^(\s+\S|\[signal |panic: )/.test(lines[end + 1] ?? "")) end++;
	const keys = range(i, end);
	let first = true;
	while (isBlank(lines[end + 1]) && GO_STACK.test(lines[end + 2] ?? "") && end - i < MAX_STRUCTURE_LINES * 5) {
		const stack = end + 2;
		end = stack;
		while (inGoStack(lines[end + 1], lines[end + 2])) end++;
		if (first) keys.push(...range(stack, Math.min(end, stack + 6)));
		first = false;
	}
	return { end, keys };
}

/** A stack's lines come in pairs: a function, then its file and line indented under it. */
function inGoStack(line: string | undefined, after: string | undefined): boolean {
	if (line === undefined || isBlank(line)) return false;
	return /^\s|^created by /.test(line) || (after !== undefined && /^\s+\S/.test(after));
}

/**
 * A race detector's or sanitizer's report, from its opening line to its closing one: the rule
 * that ends a Go or ThreadSanitizer report, or the `SUMMARY:` line of the others. Blank lines
 * separate its stacks, so indentation says nothing about where it ends.
 */
function report(lines: readonly string[], header: number): Extent {
	const ruled = DATA_RACE.test(lines[header] ?? "");
	const keys = [header, header + 1];
	const limit = Math.min(lines.length - 1, header + MAX_STRUCTURE_LINES);
	for (let at = header + 1; at <= limit; at++) {
		const line = lines[at] ?? "";
		if (ruled ? RULE.test(line) : SANITIZER_END.test(line)) return { end: at, header, keys: [...keys, at] };
		// Each stack's title and its first frames: who wrote, who read, who freed.
		if (REPORT_PART.test(line) || /^\S.* of size \d+ /.test(line)) keys.push(at, at + 1, at + 2);
	}
	// No closing line (the output was cut): the opening paragraph is what there is.
	const opening = paragraph(lines, header);
	return { end: opening.end, header, keys: opening.keys };
}

/** One failing test in pytest's report: from its `____ name ____` line to the next one, or the next banner. */
function pytestCase(lines: readonly string[], i: number): Extent {
	let end = i;
	while (
		end + 1 < lines.length &&
		!PYTEST_CASE.test(lines[end + 1] ?? "") &&
		!PYTEST_BANNER.test(lines[end + 1] ?? "")
	) {
		end++;
	}
	while (end > i && isBlank(lines[end])) end--;
	const body = range(i + 1, end);
	const messages = body.filter((at) => /^E {3}/.test(lines[at] ?? "")).slice(0, 6);
	// The line that failed (`>   assert …`) and where it is (`tests/test_x.py:27: AssertionError`).
	const failedAt = body.filter((at) => /^>/.test(lines[at] ?? "")).slice(-1);
	const places = body.filter((at) => /^\S+:\d+: /.test(lines[at] ?? "")).slice(-2);
	return { end, keys: [...failedAt, ...messages, ...places] };
}

/** What a failing Rust test printed: from `---- name stdout ----` to the next section. */
function cargoCapture(lines: readonly string[], i: number): Extent {
	let end = i;
	while (end + 1 < lines.length && end - i < MAX_STRUCTURE_LINES && !CARGO_SECTION.test(lines[end + 1] ?? "")) end++;
	while (end > i && isBlank(lines[end])) end--;
	const body = range(i + 1, end).filter((at) => !isBlank(lines[at]));
	const panic = body.find((at) => RUST_PANIC.test(lines[at] ?? ""));
	return { end, keys: panic === undefined ? body.slice(0, 5) : range(panic, Math.min(end, panic + 4)) };
}

interface GoTestSections {
	/** Where a failing test's own output starts (its `=== RUN` line), with where it ends. */
	readonly failing: ReadonlyMap<number, number>;
	/** Lines a passing or skipped test printed. */
	readonly passing: ReadonlySet<number>;
}

/**
 * Attributes `go test -v` output to tests. A test's lines follow its `=== RUN` (or `=== CONT`,
 * `=== NAME`) line; whether it failed is on a `--- FAIL` line that can come much later. Without
 * this, a failing test's log line and sixty passing tests' log lines look the same (D-083).
 */
function goTestSections(lines: readonly string[]): GoTestSections {
	const results = new Map<string, string>();
	for (const line of lines) {
		const result = GO_TEST_RESULT.exec(line);
		if (result) results.set(result[2] ?? "", result[1] ?? "");
	}
	const failing = new Map<number, number>();
	const passing = new Set<number>();
	if (results.size === 0) return { failing, passing };
	let open: { start: number; name: string } | undefined;
	const close = (end: number) => {
		if (!open || end <= open.start) return;
		const result = results.get(open.name);
		if (result === "FAIL") failing.set(open.start, end);
		else if (result !== undefined) for (let at = open.start + 1; at <= end; at++) passing.add(at);
	};
	lines.forEach((line, i) => {
		const mark = GO_TEST_MARK.exec(line);
		if (!mark && !GO_TEST_RESULT.test(line) && !GO_TEST_END.test(line)) return;
		close(i - 1);
		open = mark && mark[1] !== "PAUSE" ? { start: i, name: mark[2] ?? "" } : undefined;
	});
	close(lines.length - 1);
	return { failing, passing };
}

/**
 * A failing Go test's output, from its `=== RUN` line through its `--- FAIL` lines when they
 * follow directly. What matters most is at the end (`t.Fatalf` stops the test), and inside any
 * report the test's output contains.
 */
function goTestExtent(lines: readonly string[], start: number, bodyEnd: number): Extent {
	const reports: number[] = [];
	for (let at = start + 1; at <= bodyEnd; at++) {
		const inner = structureAt(lines, at);
		if (!inner) continue;
		reports.push(inner.header ?? at, ...inner.keys);
		at = Math.max(at, Math.min(inner.end, bodyEnd));
	}
	const results: number[] = [];
	let end = bodyEnd;
	while (/^\s*--- FAIL: /.test(lines[end + 1] ?? "")) results.push(++end);
	const last = range(Math.max(start + 1, bodyEnd - 3), bodyEnd).filter((at) => !isBlank(lines[at]));
	return { end, keys: [...results.slice(0, 2), ...last, ...reports] };
}

function range(from: number, to: number): number[] {
	const out: number[] = [];
	for (let at = from; at <= to; at++) out.push(at);
	return out;
}
