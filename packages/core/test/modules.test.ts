import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runShellCommand } from "../src/modules/command.ts";
import { loadPrompt, renderPrompt } from "../src/modules/prompts.ts";

describe("renderPrompt", () => {
	it("fills placeholders and rejects missing values", () => {
		expect(renderPrompt("Goals:\n{{ goals }}\nDiff: {{diff}}", { goals: "- a", diff: "none" })).toBe(
			"Goals:\n- a\nDiff: none",
		);
		expect(() => renderPrompt("{{missing}}", {}, "t.v1.md")).toThrow("t.v1.md: no value for {{missing}}");
	});

	it("loads versioned prompt files", () => {
		const dir = mkdtempSync(join(tmpdir(), "exo-prompt-"));
		try {
			const file = join(dir, "verdict.v1.md");
			writeFileSync(file, "Judge {{x}}");
			const prompt = loadPrompt(pathToFileURL(file));
			expect(prompt.name).toBe("verdict.v1.md");
			expect(prompt.render({ x: "it" })).toBe("Judge it");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runShellCommand", () => {
	it("captures exit code and output tail", async () => {
		const result = await runShellCommand("echo hello; echo oops >&2; exit 3", { cwd: tmpdir(), timeoutMs: 5_000 });
		expect(result).toMatchObject({ exitCode: 3, timedOut: false });
		expect(result.outputTail).toContain("hello");
		expect(result.outputTail).toContain("oops");
	});

	it("kills the whole process group on timeout", async () => {
		const result = await runShellCommand("sleep 5 & sleep 5; wait", { cwd: tmpdir(), timeoutMs: 100 });
		expect(result).toMatchObject({ exitCode: null, timedOut: true });
		expect(result.durationMs).toBeLessThan(2_000);
	});

	it("keeps only the tail of long output", async () => {
		const result = await runShellCommand("seq 1 5000", { cwd: tmpdir(), timeoutMs: 5_000, tailChars: 20 });
		expect(result.outputTail.length).toBeLessThanOrEqual(20);
		expect(result.outputTail.trim().endsWith("5000")).toBe(true);
	});
});
