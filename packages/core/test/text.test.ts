import { describe, expect, it } from "vitest";
import { startAndEnd } from "../src/modules/text.ts";

describe("startAndEnd", () => {
	it("leaves a text that fits alone", () => {
		expect(startAndEnd("short", 5)).toBe("short");
	});

	it("keeps the start and the end of a long one, with a line between them that says so", () => {
		const text = `${"a".repeat(50)}${"b".repeat(50)}${"c".repeat(50)}`;
		expect(startAndEnd(text, 30)).toBe(`${"a".repeat(20)}\n[…]\n${"c".repeat(10)}`);
		expect(startAndEnd(text, 40, { mark: "(cut)", startShare: 0.75 })).toBe(
			`${"a".repeat(30)}\n(cut)\n${"c".repeat(10)}`,
		);
	});
});
