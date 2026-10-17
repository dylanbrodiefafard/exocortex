import { describe, expect, it } from "vitest";
import { matchesGlob } from "../src/diagnostics.ts";
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
});
