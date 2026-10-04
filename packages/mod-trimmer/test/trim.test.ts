import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { prepareLines, trimLines } from "../src/trim.ts";

const OPTIONS = { headLines: 3, tailLines: 2, contextLines: 1, maxErrorWindows: 4, collapseRuns: 3, maxLineChars: 50 };
const numbered = (n: number, prefix = "line") =>
	Array.from({ length: n }, (_, i) => `${prefix} ${String.fromCharCode(97 + (i % 26))}${i}`);

describe("prepareLines", () => {
	it("cleans terminal noise, drops trailing blank lines and collapses similar runs", () => {
		const text =
			"\u001b[32mok\u001b[0m\nDownloading 1%\rDownloading 100%\nstep 1/9\nstep 2/9\nstep 3/9\nstep 4/9\ndone\n\n\n";
		expect(prepareLines(text, OPTIONS)).toEqual([
			"ok",
			"Downloading 100%",
			"step 1/9",
			"[… 3 more similar lines …]",
			"done",
		]);
	});
	it("keeps short runs and blank runs as they are", () => {
		expect(prepareLines("a 1\na 2\n\n\n\nb", OPTIONS)).toEqual(["a 1", "a 2", "", "", "", "b"]);
	});
});

describe("trimLines", () => {
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
