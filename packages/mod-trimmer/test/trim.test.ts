import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Line, prepareLines, renderSelection, selectLines, type TrimOptions } from "../src/trim.ts";

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
	return renderSelection({ lines, totalLines: lines.length, routineLines: 0 }, selectLines(lines, options), {
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
		expect(prepared.lines[3]).toMatchObject({ first: 4, last: 6 });
		expect(prepared).toMatchObject({ totalLines: 7, routineLines: 0 });
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
			5,
			"FAIL: test_tags (tests.test_catalog.ProductTest.test_tags)",
			"----------------------------------------------------------------------",
			"Traceback (most recent call last):",
			'  File "tests/test_catalog.py", line 50, in test_tags',
			"unrelated",
		);
		const text = trimLines(lines, OPTIONS).text;
		expect(text).toContain("^^^ expected `u8`");
		expect(text).not.toContain("after the block");
		expect(text).toContain('  File "tests/test_catalog.py", line 50');
		expect(text).not.toContain("unrelated");
		// The block is capped.
		const long = [
			"error: x",
			...Array.from({ length: 20 }, (_, i) => `  note ${String.fromCharCode(97 + i)}`),
			...numbered(20),
		];
		expect(trimLines(long, { ...OPTIONS, headLines: 0 }).text).toContain("  note f\n[… ");
	});

	it("caps error windows, favoring the earliest, and cuts very long lines", () => {
		const lines = numbered(100, "x");
		for (const i of [10, 20, 30, 40, 50, 60]) lines[i] = `error: e${i}`;
		lines[1] = "y".repeat(80);
		const text = trimLines(lines, { ...OPTIONS, contextLines: 0 }).text;
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
