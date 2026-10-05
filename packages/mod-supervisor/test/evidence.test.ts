import { describe, expect, it } from "vitest";
import { asksUserQuestion, diffFingerprint, formatEvidence, touchedFiles } from "../src/evidence.ts";

const ok = { exitCode: 0, timedOut: false, durationMs: 5, outputTail: "all good" };

describe("asksUserQuestion", () => {
	it.each([
		["Which approach do you prefer?", true],
		["Done.\n\nShould I also update the docs", true],
		["Would you like me to add tests?**", true],
		["I fixed the bug. All tests pass.", false],
		["Let me know if anything else is needed.", false],
		["Done.\n```python\nif x == '?':\n```", false],
		["", false],
	])("%j -> %s", (text, expected) => {
		expect(asksUserQuestion(text)).toBe(expected);
	});
});

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
			checks: [{ command: "pytest", output: ok }],
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
