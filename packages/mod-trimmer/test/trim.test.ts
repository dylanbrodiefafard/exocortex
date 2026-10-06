import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findBlocks } from "../src/blocks.ts";
import { type Line, type Prepared, prepareLines, renderSelection, selectLines, type TrimOptions } from "../src/trim.ts";

const OPTIONS = {
	headLines: 3,
	tailLines: 2,
	contextLines: 1,
	maxBlockLines: 6,
	maxErrorWindows: 4,
	collapseRuns: 3,
	maxLineChars: 50,
	hideRoutine: true,
};
const numbered = (n: number, prefix = "line") =>
	Array.from({ length: n }, (_, i) => `${prefix} ${String.fromCharCode(97 + (i % 26))}${i}`);
const asLines = (texts: readonly string[]): Line[] => texts.map((text, i) => ({ text, first: i + 1, last: i + 1 }));
/** Selects and renders already-prepared lines, as the trimmer does. */
function trimLines(texts: readonly string[], options: TrimOptions, isNumbered = false) {
	const lines = asLines(texts);
	// Nothing hidden or collapsed, so a block's place in the output is its place in the lines.
	const prepared: Prepared = { lines, totalLines: lines.length, routineLines: 0, blocks: findBlocks(texts) };
	return renderSelection(prepared, selectLines(prepared, options), {
		maxLineChars: options.maxLineChars,
		numbered: isNumbered,
	});
}

describe("prepareLines", () => {
	it("cleans terminal noise, drops trailing blank lines and collapses similar runs", () => {
		const text =
			"\u001b[32mok\u001b[0m\nDownloading 1%\rDownloading 100%\nstep 1/9\nstep 2/9\nstep 3/9\nstep 4/9\ndone\n\n\n";
		const prepared = prepareLines(text, OPTIONS);
		expect(prepared.lines.map((l) => l.text)).toEqual([
			"ok",
			"Downloading 100%",
			"step 1/9",
			"[… 3 more similar lines …]",
			"done",
		]);
		expect(prepared.lines[3]).toMatchObject({ first: 4, last: 6, similar: 3 });
		expect(prepared).toMatchObject({ totalLines: 7, routineLines: 0 });
		// With line numbers, the marker says which lines of the full output it stands for.
		const all = new Set(prepared.lines.keys());
		expect(renderSelection(prepared, all, { maxLineChars: 50, numbered: true }).text).toContain(
			"step 1/9\n[… lines 4–6: 3 more similar …]\ndone",
		);
		expect(renderSelection(prepared, all, { maxLineChars: 50, numbered: false }).text).toContain(
			"step 1/9\n[… 3 more similar lines …]\ndone",
		);
		const pair = prepareLines("tick 1\ntick 2\nend", { ...OPTIONS, collapseRuns: 2 });
		expect(renderSelection(pair, new Set([0, 1, 2]), { maxLineChars: 50, numbered: true }).text).toBe(
			"tick 1\n[… line 2: 1 more similar …]\nend",
		);
	});
	it("never collapses an error, a line with a source position, or a line of a failure's block (R1)", () => {
		const runs = [
			// Errors that differ only in where they are.
			["./book.go:41:9: undefined: roundHalfEven", "./book.go:57:12: undefined: roundHalfEven"],
			["src/a.ts(12,5): error TS2304: Cannot find name 'x'.", "src/a.ts(40,9): error TS2304: Cannot find name 'x'."],
			// Failing tests that differ only in their parameters.
			["--- FAIL: TestRound/case_1 (0.00s)", "--- FAIL: TestRound/case_2 (0.00s)"],
			["not ok 13 - rounds 105", "not ok 14 - rounds 115"],
			// Positions without an error: a warning, a log line, a traceback frame.
			["src/net.c:120:9: warning: unused variable 'i'", "src/net.c:188:9: warning: unused variable 'i'"],
			['  File "/srv/app/retry.py", line 12, in call', '  File "/srv/app/retry.py", line 30, in call'],
			// Mentions of a failure.
			["attempt 1 failed", "attempt 2 failed"],
		];
		for (const [first, second] of runs) {
			const text = [first, second, first, second].join("\n");
			expect(
				prepareLines(text, OPTIONS).lines.map((l) => l.text),
				first,
			).toEqual(text.split("\n"));
		}
		// The names under cargo's `failures:` are part of its block.
		const failures = "failures:\n    ledger::tests::settle_1\n    ledger::tests::settle_2\n    ledger::tests::settle_3";
		expect(prepareLines(`${failures}\n\nmore`, OPTIONS).lines.map((l) => l.text)).toContain(
			"    ledger::tests::settle_2",
		);
		// What is neither still collapses.
		expect(prepareLines("retry 1\nretry 2\nretry 3\nend", OPTIONS).lines).toHaveLength(3);
	});
	it("keeps a failing Go test's own lines out of the routine ones", () => {
		const text = [
			"=== RUN   TestA",
			"    a_test.go:10: fine",
			"--- PASS: TestA (0.00s)",
			"=== RUN   TestB",
			"    b_test.go:20: got 1, want 2",
			"--- FAIL: TestB (0.00s)",
			...numbered(8),
		].join("\n");
		const prepared = prepareLines(text, OPTIONS);
		expect(prepared.lines.slice(0, 4).map((l) => l.text)).toEqual([
			"    a_test.go:10: fine",
			"=== RUN   TestB",
			"    b_test.go:20: got 1, want 2",
			"--- FAIL: TestB (0.00s)",
		]);
		expect(prepared.blocks).toEqual([{ start: 1, end: 3, rank: 4, header: 1, keys: [1, 2, 3] }]);
	});
	it("keeps short runs and blank runs as they are", () => {
		expect(prepareLines("a 1\na 2\n\n\n\nb", OPTIONS).lines.map((l) => l.text)).toEqual([
			"a 1",
			"a 2",
			"",
			"",
			"",
			"b",
		]);
	});
	it("hides routine lines, but never a failure or the last lines", () => {
		const text = [
			"   Compiling forth v0.1.0",
			"running 4 tests",
			"test parse::words ... ok",
			"test eval::stack ... FAILED",
			"=== RUN   TestEaster/1981",
			"    holiday_test.go:41: Easter(1981) = 1981-04-26, want 1981-04-19",
			"    --- PASS: TestEaster/1980 (0.00s)",
			"ok 12 - parses an error reply",
			"not ok 13 - rejects ::1.2.3",
			"alpha",
			"beta",
			"gamma",
			"delta",
			"ok 14 - last",
		].join("\n");
		const prepared = prepareLines(text, OPTIONS);
		expect(prepared.lines.map((l) => l.first)).toEqual([4, 6, 9, 10, 11, 12, 13, 14]);
		expect(prepared).toMatchObject({ totalLines: 14, routineLines: 6 });
		expect(prepareLines(text, { ...OPTIONS, hideRoutine: false }).routineLines).toBe(0);
	});
});

describe("selectLines and renderSelection", () => {
	it("keeps head, tail and error windows verbatim, marking each gap", () => {
		const lines = numbered(30);
		lines[15] = "src/lib.rs:4:2: error: boom";
		const result = trimLines(lines, OPTIONS);
		expect(result.text.split("\n")).toEqual([
			"line a0",
			"line b1",
			"line c2",
			"[… 11 lines omitted …]",
			"line o14",
			"src/lib.rs:4:2: error: boom",
			"line q16",
			"[… 11 lines omitted …]",
			"line c28",
			"line d29",
		]);
		expect(result).toMatchObject({ totalLines: 30, keptLines: 8 });
		expect(trimLines(lines, OPTIONS, true).text).toContain("line c2\n[… lines 4–14 omitted …]\nline o14");
	});

	it("names hidden routine lines and collapsed runs by their place in the full output", () => {
		const prepared = prepareLines("ok 1 - a\nnot ok 2 - b\nok 3 - c\nx 1\nx 2\nx 3\ny\nz\nw\nv\nu\nt", OPTIONS);
		const keep = new Set([0, 4, 5, 6, 7, 8]);
		const text = renderSelection(prepared, keep, { maxLineChars: 50, numbered: true }).text;
		expect(text.split("\n")).toEqual([
			"[… line 1 omitted …]",
			"not ok 2 - b",
			"[… lines 3–7 omitted …]",
			"z",
			"w",
			"v",
			"u",
			"t",
		]);
	});

	it("keeps an error's whole block: indented lines and the lines that continue a diagnostic", () => {
		const lines = numbered(60);
		lines.splice(
			20,
			7,
			"error[E0308]: mismatched types",
			"  --> src/lib.rs:4:2",
			"   |",
			' 4 |     let x: u8 = "a";',
			"   |                 ^^^ expected `u8`",
			"",
			"after the block",
		);
		lines.splice(
			40,
			7,
			"FAIL: test_tags (tests.test_catalog.ProductTest.test_tags)",
			"----------------------------------------------------------------------",
			"Traceback (most recent call last):",
			'  File "tests/test_catalog.py", line 50, in test_tags',
			"    self.assertEqual(tags, [])",
			"AssertionError: Lists differ",
			"unrelated",
		);
		const text = trimLines(lines, OPTIONS).text;
		expect(text).toContain("^^^ expected `u8`");
		expect(text).not.toContain("after the block");
		expect(text).toContain('  File "tests/test_catalog.py", line 50');
		// The traceback under the header ends in its exception line, which is not indented.
		expect(text).toContain("    self.assertEqual(tags, [])\nAssertionError: Lists differ\n[… ");
		expect(text).not.toContain("unrelated");
		// A long block keeps its start and its end.
		const long = [
			"error: x",
			...Array.from({ length: 20 }, (_, i) => `  note ${String.fromCharCode(97 + i)}`),
			...numbered(20),
		];
		const capped = trimLines(long, { ...OPTIONS, headLines: 0 }).text;
		expect(capped).toContain(
			"error: x\n  note a\n  note b\n  note c\n  note d\n[… 14 lines omitted …]\n  note s\n  note t\n",
		);
	});

	it("keeps a traceback's exception line however long the traceback, and a short block whole", () => {
		const frames = Array.from({ length: 12 }, (_, i) => [
			`  File "/srv/app/${String.fromCharCode(97 + i)}.py", line ${i + 3}, in step`,
			`    return next_${String.fromCharCode(97 + i)}(x)`,
		]).flat();
		const lines = [
			...numbered(10),
			"Traceback (most recent call last):",
			...frames,
			"app.errors.NotConfigured: no DATABASES setting",
			...numbered(10),
		];
		const text = trimLines(lines, { ...OPTIONS, headLines: 0, tailLines: 0 }).text;
		expect(text).toContain("Traceback (most recent call last):\n");
		expect(text).toContain(
			'  File "/srv/app/l.py", line 14, in step\n    return next_l(x)\napp.errors.NotConfigured: no DATABASES',
		);
		expect(text).not.toContain("/srv/app/f.py");
		// Down to nothing but the block's key lines.
		const least = trimLines(lines, { ...OPTIONS, headLines: 0, tailLines: 0, maxBlockLines: 0, contextLines: 0 });
		expect(least.text.split("\n")).toEqual([
			"[… 10 lines omitted …]",
			"Traceback (most recent call last):",
			"[… 22 lines omitted …]",
			'  File "/srv/app/l.py", line 14, in step',
			"    return next_l(x)",
			"app.errors.NotConfigured: no DATABASES setting",
			"[… 10 lines omitted …]",
		]);
	});

	it("shows a failure before any number of lines that only mention one, wherever they are (R2)", () => {
		const lines = numbered(200);
		for (let i = 5; i < 195; i += 3)
			lines[i] = `retry ${String.fromCharCode(97 + (i % 26))}: attempt failed, will retry`;
		lines[100] = "--- FAIL: TestSettle (0.00s)";
		lines[101] = "    settle_test.go:88: got 349, want 350";
		const text = trimLines(lines, { ...OPTIONS, headLines: 0, tailLines: 0, contextLines: 0 }).text;
		expect(text).toContain("--- FAIL: TestSettle (0.00s)\n    settle_test.go:88: got 349, want 350");
		expect(text.match(/attempt failed/g)).toHaveLength(3);
	});

	it("names the failures it has no room to show (R2)", () => {
		const lines = numbered(120);
		const failing = [10, 20, 30, 40, 50, 60, 70, 80];
		for (const i of failing) {
			lines[i] = `not ok ${i} - case ${String.fromCharCode(97 + i / 10)}`;
			lines[i + 1] = "  # got: 0";
		}
		const options = { ...OPTIONS, headLines: 0, tailLines: 0, contextLines: 0 };
		const text = trimLines(lines, options).text;
		for (const i of failing) expect(text).toContain(`not ok ${i} - `);
		// Four with what they said (three from the start, one from the end), four by name only.
		expect(text.match(/# got: 0/g)).toHaveLength(4);
		expect(text).toContain("not ok 30 - case d\n  # got: 0\n[… 8 lines omitted …]\nnot ok 40 - case e\n[… 9 lines");
		expect(text).toContain("not ok 80 - case i\n  # got: 0");
		const unnamed = trimLines(lines, { ...options, headerLines: false }).text;
		expect(unnamed.match(/^not ok /gm)).toHaveLength(4);
	});

	it("caps error windows, favoring the earliest, and cuts very long lines", () => {
		const lines = numbered(100, "x");
		for (const i of [10, 20, 30, 40, 50, 60]) lines[i] = `error: e${i}`;
		lines[1] = "y".repeat(80);
		const text = trimLines(lines, { ...OPTIONS, contextLines: 0, headerLines: false }).text;
		expect(text).toContain(`${"y".repeat(50)}…[+30 chars]`);
		expect(["e10", "e20", "e30", "e60"].every((e) => text.includes(e))).toBe(true);
		expect(text).not.toContain("e40");
		expect(text).not.toContain("e50");
	});

	it("prefers specific errors over generic mentions when over the cap", () => {
		const lines = numbered(60);
		lines[10] = "warning: something failed";
		for (const i of [20, 30, 40, 50]) lines[i] = `error[E0${i}]: x`;
		const text = trimLines(lines, { ...OPTIONS, contextLines: 0 }).text;
		expect(text).not.toContain("something failed");
		expect(text).toContain("error[E050]");
	});

	it("property: output lines are input lines or markers, in order, and never more than the input", () => {
		fc.assert(
			fc.property(
				fc.array(fc.oneof(fc.constant("error: x"), fc.string({ maxLength: 20 })), { maxLength: 200 }),
				(raw) => {
					const lines = raw.map((l) => l.replace(/\n/g, " "));
					const result = trimLines(lines, OPTIONS);
					const out = result.text === "" ? [] : result.text.split("\n");
					let cursor = 0;
					for (const line of out) {
						if (/^\[… \d+ lines? omitted …\]$/.test(line)) continue;
						const found = lines.indexOf(line, cursor);
						expect(found).toBeGreaterThanOrEqual(cursor);
						cursor = found + 1;
					}
					expect(result.keptLines).toBeLessThanOrEqual(lines.length);
				},
			),
		);
	});
});
