import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultDraft } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTrimmer, keepFromRanges } from "../src/trimmer.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-trim-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;

function buildLog(lines = 600): string {
	const out = Array.from(
		{ length: lines },
		(_, i) => `   Compiling crate-${letters(i)} v0.${i}.0 (registry+https://example.com/index/${i})`,
	);
	out[300] = "error[E0502]: cannot borrow `self.items` as mutable because it is also borrowed as immutable";
	out[301] = "  --> src/lib.rs:42:9";
	out.push("error: could not compile `forth` (lib) due to 1 previous error");
	return out.join("\n");
}

/** Distinct letters per index, so lines differ in shape (digits alone would collapse as similar). */
function letters(n: number): string {
	let s = "";
	let i = n;
	do {
		s = String.fromCharCode(97 + (i % 26)) + s;
		i = Math.floor(i / 26) - 1;
	} while (i >= 0);
	return s;
}

function draft(current: string, extra: Partial<ToolResultDraft> = {}): ToolResultDraft {
	return {
		toolName: "bash",
		toolCallId: "call/1",
		input: { command: "cargo build" },
		isError: true,
		exitCode: 101,
		output: current,
		current,
		fullOutputPath: null,
		...extra,
	};
}

function setup(settings: Record<string, unknown> = {}, reply?: (body: string) => SidecarReply) {
	const t = createTestModuleContext({
		cwd: dir,
		...(reply ? { reply: (request) => reply(String(request.messages[0]?.["content"])) } : {}),
	});
	const trimmer = createTrimmer({ saveDir: join(dir, "saved"), ...settings }, t.context);
	return { t, trimmer };
}

describe("trimmer", () => {
	it("leaves short results and never-trimmed tools alone", async () => {
		const { trimmer } = setup({ tools: ["bash", "read"] });
		expect(await trimmer.rewriteToolResult?.(draft("short"), signal)).toBeUndefined();
		expect(await trimmer.rewriteToolResult?.(draft(buildLog(), { toolName: "read" }), signal)).toBeUndefined();
		expect(await trimmer.rewriteToolResult?.(draft(buildLog(), { toolName: "grep" }), signal)).toBeUndefined();
	});

	it("trims deterministically, keeping the root error, and saves the full output", async () => {
		const { trimmer } = setup();
		const log = buildLog();
		const rewrite = await trimmer.rewriteToolResult?.(draft(log), signal);
		if (!rewrite) throw new Error("expected a rewrite");
		expect(rewrite.text.length).toBeLessThan(log.length / 3);
		expect(rewrite.text).toContain("error[E0502]: cannot borrow `self.items`");
		expect(rewrite.text).toContain("  --> src/lib.rs:42:9");
		expect(rewrite.text).toContain("could not compile `forth`");
		const saved = join(dir, "saved", "call_1.log");
		expect(rewrite.text).toMatch(/\[exo trimmer: showing \d+ of 601 lines; full output: .*call_1\.log/);
		expect(readFileSync(saved, "utf8")).toBe(log);
		expect(rewrite.note).toMatch(/^trimmed 601→\d+ lines \(head\/tail\/errors\)$/);
		// The saved path goes to the trace, so the eval can tell when the agent reads it back.
		expect(rewrite.details).toEqual({ fullOutputPath: saved });
		expect(trimmer.status?.()).toMatch(/^trimmer \(1 trimmed, −\d+k chars\)$/);
	});

	it("points at the harness's saved output instead of saving its own", async () => {
		const { trimmer } = setup();
		const rewrite = await trimmer.rewriteToolResult?.(
			draft(buildLog(), { fullOutputPath: "/tmp/pi-full.log" }),
			signal,
		);
		expect(rewrite?.text).toContain("full output: /tmp/pi-full.log");
		expect(existsSync(join(dir, "saved"))).toBe(false);
	});

	it("uses the sidecar's line ranges verbatim, always adding the tail and the root error", async () => {
		const prompts: string[] = [];
		const { trimmer, t } = setup({ sidecar: true, headLines: 200, tailLines: 200 }, (body) => {
			prompts.push(body);
			return { ranges: [[5, 6]] };
		});
		trimmer.onUserTurn?.({ text: "make forth compile", origin: "user" });
		trimmer.onUserTurn?.({ text: "(continuation)", origin: "extension" });
		const rewrite = await trimmer.rewriteToolResult?.(draft(buildLog()), signal);
		if (!rewrite) throw new Error("expected a rewrite");
		expect(prompts[0]).toContain("make forth compile");
		expect(prompts[0]).toContain("Command: cargo build");
		expect(prompts[0]).toContain("301: error[E0502]");
		expect(rewrite.note).toContain("sidecar selection");
		const lines = rewrite.text.split("\n");
		expect(lines[0]).toBe("[… 4 lines omitted …]");
		expect(lines[1]).toContain(`crate-${letters(4)} `);
		expect(rewrite.text).toContain("error[E0502]");
		expect(rewrite.text).toContain("could not compile");
		expect(t.requests[0]?.thinking).toBe(false);
	});

	it("falls back to the deterministic tier when the sidecar fails or answers badly", async () => {
		for (const reply of [new Error("down"), { ranges: [] }, { ranges: [[1, 1000]] }, "not json"] as SidecarReply[]) {
			const { trimmer } = setup({ sidecar: true }, () => reply);
			const rewrite = await trimmer.rewriteToolResult?.(draft(buildLog(3000)), signal);
			expect(rewrite?.note).toContain("head/tail/errors");
		}
	});

	it("skips the sidecar without an engine, for huge outputs, and when the deterministic tier suffices", async () => {
		const calls: string[] = [];
		const noEngine = setup({ sidecar: true });
		expect((await noEngine.trimmer.rewriteToolResult?.(draft(buildLog(3000)), signal))?.note).toContain("head/tail");
		const huge = setup({ sidecar: true, sidecarMaxInputChars: 1_000 }, (b) => {
			calls.push(b);
			return { ranges: [[1, 2]] };
		});
		await huge.trimmer.rewriteToolResult?.(draft(buildLog(3000)), signal);
		const small = setup({ sidecar: true, sidecarAboveChars: 100_000 }, (b) => {
			calls.push(b);
			return { ranges: [[1, 2]] };
		});
		await small.trimmer.rewriteToolResult?.(draft(buildLog(3000)), signal);
		expect(calls).toEqual([]);
	});

	it("halves the error windows while the result is over maxChars, keeping the first errors", async () => {
		// 120 long, distinct errors spread through 1,200 lines: every window is kept without a budget.
		const lines = Array.from({ length: 1_200 }, (_, i) =>
			i % 10 === 5
				? `src/mod_${letters(i)}.rs:${i}:1: error: mismatched types in ${letters(i).repeat(60)}`
				: `   Compiling crate-${letters(i)} v0.1.0`,
		);
		const log = lines.join("\n");
		const loose = await setup({ maxChars: 1_000_000 }).trimmer.rewriteToolResult?.(draft(log), signal);
		const tight = await setup({ maxChars: 6_000 }).trimmer.rewriteToolResult?.(draft(log), signal);
		if (!loose || !tight) throw new Error("expected rewrites");
		expect(loose.text.length).toBeGreaterThan(12_000);
		expect(tight.text.length).toBeLessThan(loose.text.length / 2);
		expect(tight.text).toContain("src/mod_f.rs:5:1: error: mismatched types");
		expect(tight.text).toContain(lines.at(-1));
	});

	it("does not rewrite when trimming would not shrink the output", async () => {
		const { trimmer } = setup({ minChars: 500, headLines: 1000 });
		expect(await trimmer.rewriteToolResult?.(draft(buildLog(50)), signal)).toBeUndefined();
	});

	it("survives an unwritable save dir", async () => {
		const { trimmer, t } = setup({ saveDir: "/dev/null/x" });
		const rewrite = await trimmer.rewriteToolResult?.(draft(buildLog()), signal);
		expect(rewrite?.text).toMatch(/showing \d+ of 601 lines\]$/);
		expect(t.logs.some((l) => l.startsWith("could not save"))).toBe(true);
	});

	it("reports invalid settings and falls back to defaults", () => {
		const { trimmer, t } = setup({ minChars: "lots" });
		expect(t.logs.some((l) => l.startsWith("trimmer /minChars"))).toBe(true);
		expect(trimmer.status?.()).toBe("trimmer");
	});
});

describe("keepFromRanges", () => {
	const lines = ["a", "error: x", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
	it("converts 1-based inclusive ranges, clamps, ignores reversed ones, adds tail and first error", () => {
		const keep = keepFromRanges(
			[
				[1, 1],
				[9, 3],
				[0, 0],
			],
			lines,
			50,
		);
		expect([...(keep ?? [])].sort((a, b) => a - b)).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	});
	it("rejects empty and over-budget selections", () => {
		expect(keepFromRanges([], lines, 5)).toBeUndefined();
		expect(keepFromRanges([[1, 13]], lines, 5)).toBeUndefined();
	});
});
