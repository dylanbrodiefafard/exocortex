import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultDraft } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareLines } from "../src/trim.ts";
import { createTrimmer, keepFromRanges, removeRetiredSaveDirs } from "../src/trimmer.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-trim-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;

function buildLog(lines = 600): string {
	const out = Array.from(
		{ length: lines },
		(_, i) => `   Generated crate-${letters(i)} v0.${i}.0 (registry+https://example.com/index/${i})`,
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
		status: null,
		...extra,
	};
}

function setup(settings: Record<string, unknown> = {}, reply?: (body: string) => SidecarReply, sessionId?: string) {
	const t = createTestModuleContext({
		cwd: dir,
		...(sessionId === undefined ? {} : { sessionId }),
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
		const saved = join(dir, "saved", "session-test-session", "call_1.log");
		expect(rewrite.text).toMatch(/\[exo trimmer: showing \d+ of 601 lines; full output: .*call_1\.log \(the line/);
		// Markers name the omitted lines of the saved file, and a diagnostic keeps the lines under it.
		expect(rewrite.text).toContain("[… lines 41–297 omitted …]");
		expect(readFileSync(saved, "utf8")).toBe(log);
		expect(rewrite.note).toMatch(/^trimmed 601→\d+ lines \(head\/tail\/errors\)$/);
		// The saved path goes to the trace, so the eval can tell when the agent reads it back.
		expect(rewrite.details).toEqual({ fullOutputPath: saved });
		expect(trimmer.status?.()).toMatch(/^trimmer \(1 trimmed, −\d+k chars\)$/);
	});

	it("trims from the harness's saved output, not from the tail the harness kept", async () => {
		const { trimmer } = setup();
		const log = buildLog(3000);
		const path = join(dir, "pi-full.log");
		writeFileSync(path, log);
		const status = "Command exited with code 101";
		const kept = `${log.split("\n").slice(-400).join("\n")}\n\n[Showing lines 2602-3001 of 3001. Full output: ${path}]\n\n${status}`;
		const rewrite = await trimmer.rewriteToolResult?.(draft(kept, { fullOutputPath: path, status }), signal);
		if (!rewrite) throw new Error("expected a rewrite");
		// The root error is on line 301, which the harness had cut.
		expect(kept).not.toContain("error[E0502]");
		expect(rewrite.text).toContain("error[E0502]: cannot borrow `self.items`");
		expect(rewrite.text).toContain(`crate-${letters(0)} `);
		expect(rewrite.text).not.toContain("[Showing lines");
		expect(rewrite.text).toMatch(
			/\n\nCommand exited with code 101\n\[exo trimmer: showing \d+ of 3001 lines; full output: /,
		);
		expect(rewrite.details).toEqual({ fullOutputPath: path });
		expect(existsSync(join(dir, "saved"))).toBe(false);
	});

	it("falls back to what the harness kept when its saved output is missing or too large", async () => {
		const log = buildLog();
		const path = join(dir, "pi-full.log");
		writeFileSync(path, buildLog(3000));
		for (const [settings, fullOutputPath] of [
			[{}, "/nonexistent/pi-full.log"],
			[{ maxFullOutputBytes: 10 }, path],
		] as const) {
			const rewrite = await setup(settings).trimmer.rewriteToolResult?.(draft(log, { fullOutputPath }), signal);
			// Line numbers would not match the file, so markers only count.
			expect(rewrite?.text).toMatch(/\[… \d+ lines omitted …\]/);
			expect(rewrite?.text).toMatch(/showing \d+ of 601 lines; full output: \S+ \(grep it/);
		}
	});

	it("hides routine lines first and shows everything else when that is enough", async () => {
		const tap = Array.from({ length: 900 }, (_, i) =>
			i % 100 === 50 ? `not ok ${i} - ${letters(i)}\n  #   got: 0\n  #   expected: 1` : `ok ${i} - check ${letters(i)}`,
		);
		const log = `${tap.join("\n")}\n# 891/900 checks passed`;
		const { trimmer } = setup();
		const rewrite = await trimmer.rewriteToolResult?.(draft(log, { input: { command: "make test" } }), signal);
		if (!rewrite) throw new Error("expected a rewrite");
		expect(rewrite.text.match(/^not ok /gm)).toHaveLength(9);
		expect(rewrite.text.match(/expected: 1/g)).toHaveLength(9);
		expect(rewrite.text.match(/^ok /gm)).toHaveLength(4);
		expect(rewrite.text).toContain("[… lines 1–50 omitted …]\nnot ok 50 - ");
		expect(rewrite.text).toContain("; 887 routine lines hidden; full output: ");
		expect(rewrite.note).toBe("trimmed 919→32 lines (routine lines hidden)");
		const off = await setup({ hideRoutine: false }).trimmer.rewriteToolResult?.(draft(log), signal);
		expect(off?.note).toContain("head/tail/errors");
		expect(off?.text).not.toContain("routine lines hidden");
	});

	it("leaves output the agent asked to read alone", async () => {
		const { trimmer } = setup();
		const log = buildLog();
		for (const command of ["cat build.log", "cd sub && git diff HEAD~1", "cargo test 2>&1 | tail -n 600"]) {
			expect(await trimmer.rewriteToolResult?.(draft(log, { input: { command } }), signal)).toBeUndefined();
		}
		expect(
			await trimmer.rewriteToolResult?.(draft(log, { input: { command: "make; cat build.log" } }), signal),
		).toBeDefined();
		const none = setup({ verbatimCommands: [] });
		expect(
			await none.trimmer.rewriteToolResult?.(draft(log, { input: { command: "cat build.log" } }), signal),
		).toBeDefined();
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
		expect(lines[0]).toBe("[… lines 1–4 omitted …]");
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
				: `   Generated crate-${letters(i)} v0.1.0`,
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

describe("maxChars is a ceiling (R5)", () => {
	const longLine = (i: number) => `${letters(i)} ${`${letters(i * 7)} `.repeat(120)}`.slice(0, 390);

	it("holds when every line is long and many are errors", async () => {
		const lines = Array.from({ length: 600 }, (_, i) =>
			i % 6 === 3 ? `src/mod_${letters(i)}.rs:${i}:1: error: mismatched types in ${longLine(i)}` : longLine(i),
		);
		for (const maxChars of [2_000, 3_000, 9_000]) {
			const rewrite = await setup({ maxChars }).trimmer.rewriteToolResult?.(draft(lines.join("\n")), signal);
			if (!rewrite) throw new Error("expected a rewrite");
			expect(rewrite.text.length).toBeLessThanOrEqual(maxChars);
			// The first error is still there, cut short, and so are the footer and the last line.
			expect(rewrite.text).toContain("src/mod_d.rs:3:1: error: mismatched types");
			expect(rewrite.text).toContain(longLine(599).slice(0, 20));
			expect(rewrite.text).toMatch(/\[exo trimmer: showing \d+ of 600 lines; full output: \S+call_1\.log \(the line/);
		}
	});

	it("holds when hiding routine lines leaves more markers than text", async () => {
		const lines = Array.from({ length: 2_400 }, (_, i) =>
			i % 2 === 0 ? `ok ${i} - ${"checks the parser ".repeat(4)}${letters(i)}` : letters(i),
		);
		const rewrite = await setup().trimmer.rewriteToolResult?.(draft(lines.join("\n")), signal);
		if (!rewrite) throw new Error("expected a rewrite");
		expect(rewrite.text.length).toBeLessThanOrEqual(24_000);
		expect(rewrite.note).toContain("head/tail/errors");
	});

	it("holds for a sidecar selection, which is dropped when it is over", async () => {
		const lines = Array.from({ length: 400 }, (_, i) => longLine(i));
		lines[200] = "error[E0502]: cannot borrow `self.items` as mutable";
		const reply = () => ({ ranges: [[1, 100]] });
		const rewrite = await setup(
			{ sidecar: true, maxChars: 12_000, sidecarMaxInputChars: 1_000_000 },
			reply,
		).trimmer.rewriteToolResult?.(draft(lines.join("\n")), signal);
		if (!rewrite) throw new Error("expected a rewrite");
		expect(rewrite.text.length).toBeLessThanOrEqual(12_000);
		expect(rewrite.note).toContain("head/tail/errors");
		expect(rewrite.text).toContain("error[E0502]");
		// One that fits is used.
		const small = await setup({ sidecar: true, maxChars: 12_000, sidecarMaxInputChars: 1_000_000 }, () => ({
			ranges: [[1, 3]],
		})).trimmer.rewriteToolResult?.(draft(lines.join("\n")), signal);
		expect(small?.note).toContain("sidecar selection");
		expect(small?.text.length).toBeLessThanOrEqual(12_000);
	});

	it("cuts the text itself when even the least selection is over, and says so", async () => {
		// A path so long that the footer leaves the output a few hundred characters, then none.
		for (const [depth, shown] of [
			[280, /^\[… \d+ lines omitted …\]\nerror\[E0502\]: cannot .*…\[\+\d+ chars\]\n/],
			[400, /^\n\[… cut here to fit maxChars …\]\n/],
		] as const) {
			const path = join(dir, `${"deep/".repeat(depth)}pi-full.log`);
			const rewrite = await setup({ maxChars: 2_000 }).trimmer.rewriteToolResult?.(
				draft(buildLog(), { fullOutputPath: path, status: "Command exited with code 101" }),
				signal,
			);
			if (!rewrite) throw new Error("expected a rewrite");
			expect(rewrite.text.length).toBeLessThanOrEqual(2_000);
			expect(rewrite.text).toMatch(shown);
		}
	});
});

describe("saved outputs (R6)", () => {
	afterEach(() => removeRetiredSaveDirs());

	it("keeps each session's outputs in its own directory, readable by the user only", async () => {
		const first = setup({}, undefined, "session/one");
		const second = setup({}, undefined, "session-two");
		const a = await first.trimmer.rewriteToolResult?.(draft(buildLog(600)), signal);
		const b = await second.trimmer.rewriteToolResult?.(draft(buildLog(700)), signal);
		const pathA = join(dir, "saved", "session-session_one", "call_1.log");
		const pathB = join(dir, "saved", "session-session-two", "call_1.log");
		expect(a?.details).toEqual({ fullOutputPath: pathA });
		expect(b?.details).toEqual({ fullOutputPath: pathB });
		// The same tool-call id in two sessions: neither overwrites the other's file.
		expect(readFileSync(pathA, "utf8")).toBe(buildLog(600));
		expect(readFileSync(pathB, "utf8")).toBe(buildLog(700));
		if (process.platform !== "win32") {
			expect(statSync(join(dir, "saved", "session-session_one")).mode & 0o777).toBe(0o700);
			expect(statSync(pathA).mode & 0o777).toBe(0o600);
		}
	});

	it("removes a disposed session's outputs when the process exits, not while the session can still read them", async () => {
		const first = setup({}, undefined, "one");
		const other = setup({}, undefined, "two");
		await first.trimmer.rewriteToolResult?.(draft(buildLog()), signal);
		await other.trimmer.rewriteToolResult?.(draft(buildLog()), signal);
		const saved = join(dir, "saved", "session-one", "call_1.log");
		await first.trimmer.dispose?.();
		// A reload or a settings change disposes the module too; the context still names the file.
		expect(existsSync(saved)).toBe(true);
		removeRetiredSaveDirs();
		expect(existsSync(join(dir, "saved", "session-one"))).toBe(false);
		// A session still running keeps its files, and so does the directory the user named.
		expect(existsSync(join(dir, "saved", "session-two", "call_1.log"))).toBe(true);
	});

	it("keeps the outputs of a session whose trimmer was rebuilt", async () => {
		const first = setup({}, undefined, "one");
		await first.trimmer.rewriteToolResult?.(draft(buildLog()), signal);
		await first.trimmer.dispose?.();
		const rebuilt = setup({ minChars: 9_000 }, undefined, "one");
		removeRetiredSaveDirs();
		const saved = join(dir, "saved", "session-one", "call_1.log");
		expect(existsSync(saved)).toBe(true);
		// The rebuilt one saved nothing itself; the directory is still its session's to remove.
		await rebuilt.trimmer.dispose?.();
		removeRetiredSaveDirs();
		expect(existsSync(saved)).toBe(false);
		// Nothing saved, nothing to remove.
		await setup({}, undefined, "three").trimmer.dispose?.();
		removeRetiredSaveDirs();
	});

	it("saves under the temp directory by default", async () => {
		const sessionId = `trimmer-test-${process.pid}-${Date.now()}`;
		const t = createTestModuleContext({ cwd: dir, sessionId });
		const trimmer = createTrimmer({}, t.context);
		const rewrite = await trimmer.rewriteToolResult?.(draft(buildLog()), signal);
		const saved = join(tmpdir(), "exocortex-trimmer", `session-${sessionId}`, "call_1.log");
		expect(rewrite?.details).toEqual({ fullOutputPath: saved });
		await trimmer.dispose?.();
		removeRetiredSaveDirs();
		expect(existsSync(saved)).toBe(false);
	});
});

describe("keepFromRanges", () => {
	const lines = prepareLines(["a", "error: x", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"].join("\n"), {
		collapseRuns: 99,
		hideRoutine: false,
	});
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
