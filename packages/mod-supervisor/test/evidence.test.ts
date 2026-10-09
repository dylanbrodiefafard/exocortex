import { describe, expect, it } from "vitest";
import { diffFingerprint, fitDiff, formatEvidence, touchedFiles } from "../src/evidence.ts";

const ok = { exitCode: 0, timedOut: false, durationMs: 5, outputTail: "all good" };

describe("formatEvidence", () => {
	it("orders checks, changes, commands, then the diff, within the budget", () => {
		const text = formatEvidence({
			diffStat: " app.py | 2 +-",
			diff: "diff --git a/app.py b/app.py\n-print('v1')\n+print('v2')",
			untracked: ["README.md"],
			tools: [
				{ toolName: "bash", input: { command: "pytest" }, isError: true, exitCode: 1, output: "1 failed" },
				{ toolName: "write", input: { path: "README.md" }, isError: false, exitCode: null, output: "" },
			],
			checks: [{ command: "pytest", output: ok, source: "config" }],
			maxChars: 10_000,
		});
		const order = ["## Check commands", "## Changes since", "## Commands the agent ran", "## Diff"].map((h) =>
			text.indexOf(h),
		);
		expect(order.every((i, k) => i >= 0 && (k === 0 || i > (order[k - 1] ?? -1)))).toBe(true);
		expect(text).toContain("README.md (new, untracked)");
		expect(text).toContain("$ pytest  → exit 1");
		expect(text).toContain("Output of the last failing command (it did not pass again):\n1 failed");
	});

	it("leaves out a failure's output once the same command has passed", () => {
		const run = (command: string, exitCode: number, output: string) => ({
			toolName: "bash",
			input: { command },
			isError: exitCode !== 0,
			exitCode,
			output,
		});
		const text = formatEvidence({
			diffStat: "",
			diff: "",
			untracked: [],
			tools: [run("pytest", 1, "1 failed"), run("ruff check", 1, "E501"), run("pytest", 0, "1 passed")],
			checks: [],
			maxChars: 10_000,
		});
		expect(text).toContain("Output of the last failing command (it did not pass again):\nE501");
		const fixed = formatEvidence({
			diffStat: "",
			diff: "",
			untracked: [],
			tools: [run("pytest", 1, "1 failed"), run("pytest", 0, "1 passed")],
			checks: [],
			maxChars: 10_000,
		});
		expect(fixed).toContain("$ pytest  → exit 1");
		expect(fixed).not.toContain("last failing command");
	});

	it("drops the diff first and hard-caps the length", () => {
		const text = formatEvidence({
			diffStat: " a | 1 +",
			diff: "x".repeat(50_000),
			untracked: [],
			tools: [],
			checks: [],
			maxChars: 1_000,
		});
		expect(text.length).toBeLessThanOrEqual(1_002);
	});

	it("says so outside git and when nothing changed", () => {
		const base = { diff: undefined, untracked: [], tools: [], checks: [], maxChars: 1_000 };
		expect(formatEvidence({ ...base, diffStat: undefined })).toContain("Not a git repository");
		expect(formatEvidence({ ...base, diffStat: "" })).toContain("No changes in the working tree.");
	});
});

describe("helpers", () => {
	it("collects written paths and fingerprints changes", () => {
		expect(
			touchedFiles([
				{ toolName: "edit", input: { path: "a.ts" }, isError: false, exitCode: null, output: "" },
				{ toolName: "read", input: { path: "b.ts" }, isError: false, exitCode: null, output: "" },
				{ toolName: "write", input: { path: "c.ts" }, isError: true, exitCode: null, output: "" },
			]),
		).toEqual(["a.ts"]);
		expect(diffFingerprint("d", ["x"])).toBe(diffFingerprint("d", ["x"]));
		expect(diffFingerprint("d", ["x"])).not.toBe(diffFingerprint("d", ["y"]));
	});
});

describe("fitDiff", () => {
	const file = (path: string, lines: number) =>
		`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${Array.from({ length: lines }, (_, i) => `+${path} line ${i}`).join("\n")}`;

	it("leaves a diff that fits alone", () => {
		const diff = [file("a.rs", 3), file("b.rs", 3)].join("\n");
		expect(fitDiff(diff, 10_000)).toBe(diff);
	});

	it("shows every file when the diff is too long, cutting only the long ones, code before tests", () => {
		const diff = [file("tests/test_big.py", 400), file("src/big.rs", 400), file("src/small.rs", 5)].join("\n");
		const fitted = fitDiff(diff, 3_000);
		expect(fitted.length).toBeLessThanOrEqual(3_000);
		// The small file is whole; a plain cut at 3,000 characters would never have reached it.
		expect(fitted).toContain("+src/small.rs line 4");
		expect(fitted).toContain("+src/big.rs line 0");
		expect(fitted).toContain("+tests/test_big.py line 0");
		expect(fitted).toMatch(/… \(\d+ more lines of this file's diff not shown\)/);
		expect(fitted.indexOf("a/src/big.rs")).toBeLessThan(fitted.indexOf("a/tests/test_big.py"));
	});
});
