import { describe, expect, it } from "vitest";
import { printsOnly } from "../src/commands.ts";
import { type Check, matchesGlob, mentionsFile, readCheck } from "../src/diagnostics.ts";
import { closestWindow, similarity, withoutLineNumbers } from "../src/edit-hints.ts";
import { editDistance } from "../src/paths.ts";
import { numberLines } from "../src/read-view.ts";

describe("helpers", () => {
	it("matches file patterns by name, or by path when they have a slash", () => {
		expect(matchesGlob("*.rs", "src/deep/lib.rs")).toBe(true);
		expect(matchesGlob("*.rs", "src/lib.rsx")).toBe(false);
		expect(matchesGlob("src/**/*.rs", "src/a/b/lib.rs")).toBe(true);
		expect(matchesGlob("src/**/*.rs", "src/lib.rs")).toBe(true);
		expect(matchesGlob("src/*.rs", "src/a/lib.rs")).toBe(false);
		expect(matchesGlob("test_?.py", "test_a.py")).toBe(true);
		expect(matchesGlob("**", "any/thing")).toBe(true);
		expect(matchesGlob("a+b.(c)", "a+b.(c)")).toBe(true);
	});

	it("strips line numbers only when every non-empty line has one", () => {
		expect(withoutLineNumbers(" 3\tfoo\n\n 4\tbar")).toBe("foo\n\nbar");
		expect(withoutLineNumbers("12: foo\n13| bar\n14│ baz")).toBe("foo\nbar\nbaz");
		expect(withoutLineNumbers("3\tfoo\nbar")).toBeUndefined();
		expect(withoutLineNumbers("\n")).toBeUndefined();
	});

	it("scores similarity and edit distance", () => {
		expect(similarity("abc", "abc")).toBe(1);
		expect(similarity("a", "b")).toBe(0);
		expect(similarity("night", "nacht")).toBeCloseTo(0.25);
		expect(editDistance("kitten", "sitting")).toBe(3);
		expect(editDistance("", "ab")).toBe(2);
	});

	it("finds no window for blank text, and places one by a matching line", () => {
		expect(closestWindow(["a", "b"], ["", "  "])).toBeUndefined();
		expect(closestWindow(["x", "let total = 0;", "y"], ["let total = 0;"])).toEqual({
			start: 1,
			length: 1,
			whitespaceOnly: true,
		});
	});

	it("numbers lines with a shared width and no number for a final newline", () => {
		expect(numberLines("a\nb\n", 99)).toBe(" 99\ta\n100\tb");
		expect(numberLines("", 1)).toBe("1\t");
	});

	it("reads what a linter prints when it names no error (D-110)", () => {
		const check: Check = { command: "lint", label: "lint", builtin: false, source: "lint" };
		const run = (outputTail: string, exitCode: number | null = 1) =>
			readCheck({ exitCode, timedOut: false, durationMs: 1, outputTail }, check);
		// shellcheck's default format has no position line: its last lines stand for its errors.
		const shellcheck =
			"\nIn a.sh line 3:\necho $1\n     ^-- SC2086 (info): Double quote to prevent globbing.\n\nFor more information:\n  https://www.shellcheck.net/wiki/SC2086";
		expect(run(shellcheck)).toEqual({
			kind: "errors",
			guessed: true,
			diagnostics: [
				expect.objectContaining({
					text: shellcheck
						.trim()
						.split("\n")
						.filter((l) => l.trim() !== "")
						.join("\n"),
				}),
			],
		});
		// Biome puts a blank line between the position and the message.
		const biome =
			"src/a.ts:3:7 lint/style/useConst  FIXABLE\n\n  × This let declares a variable that is only assigned once.\n\nChecked 1 file.";
		const read = run(biome);
		expect(read.kind === "errors" && read.diagnostics.map((d) => d.text)).toEqual([
			"src/a.ts:3:7 lint/style/useConst  FIXABLE\n\n  × This let declares a variable that is only assigned once.",
		]);
		// A compiler's own error lines win over position lines.
		const tsc = "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.";
		expect(run(tsc)).toMatchObject({ kind: "errors", guessed: false, diagnostics: [{ text: tsc }] });
		expect(run("")).toEqual({ kind: "unreadable", why: "it exited with 1 and printed nothing" });
		expect(run("x", null)).toMatchObject({ kind: "unreadable" });
		expect(readCheck({ exitCode: 0, timedOut: true, durationMs: 1, outputTail: "" }, check)).toMatchObject({
			kind: "unreadable",
			why: "it timed out",
		});
	});

	it("finds the edited file in an error, by whole path segments", () => {
		const cwd = "/w";
		expect(mentionsFile("  --> src/a.rs:3:5", "/w/src/a.rs", cwd)).toBe(true);
		expect(mentionsFile("crates/x/src/a.rs:3:5: error", "/w/src/a.rs", cwd)).toBe(true);
		expect(mentionsFile("a.rs(3,5): error", "/w/src/a.rs", cwd)).toBe(true);
		expect(mentionsFile("  --> src/ba.rs:3:5", "/w/src/a.rs", cwd)).toBe(false);
		expect(mentionsFile("  --> lib/a.rs:3:5", "/w/src/a.rs", cwd)).toBe(false);
	});

	it("tells a command that only prints from one that may change files", () => {
		for (const command of [
			"cat a | grep x",
			"git diff HEAD",
			"sed -n 1,5p a 2>&1",
			"ls > /dev/null",
			"rg x && wc -l a",
		]) {
			expect(printsOnly(command), command).toBe(true);
		}
		for (const command of [
			"cargo test",
			"sed -i s/a/b/ f",
			"cat a > b",
			"find . -delete",
			"git checkout x",
			"echo $(make)",
			"cat a | tee b",
		]) {
			expect(printsOnly(command), command).toBe(false);
		}
	});
});
