import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultDraft } from "@exocortex/core";
import { createTestModuleContext } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrimmerSettingsSchema } from "../src/index.ts";
import { createTrimmer } from "../src/trimmer.ts";

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

function setup(settings: Record<string, unknown> = {}, sessionId?: string) {
	const t = createTestModuleContext({ cwd: dir, ...(sessionId === undefined ? {} : { sessionId }) });
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
		const { trimmer } = setup({ headLines: 40, tailLines: 80 });
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
			const { trimmer, t } = setup(settings);
			const rewrite = await trimmer.rewriteToolResult?.(draft(log, { fullOutputPath }), signal);
			expect(t.logs.join("\n")).toMatch(/could not read pi's saved output|over maxFullOutputBytes/);
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
		const { trimmer } = setup({ minChars: 8_000 });
		const rewrite = await trimmer.rewriteToolResult?.(draft(log, { input: { command: "make test" } }), signal);
		if (!rewrite) throw new Error("expected a rewrite");
		expect(rewrite.text.match(/^not ok /gm)).toHaveLength(9);
		expect(rewrite.text.match(/expected: 1/g)).toHaveLength(9);
		expect(rewrite.text.match(/^ok /gm)).toHaveLength(4);
		expect(rewrite.text).toContain("[… lines 1–50 omitted …]\nnot ok 50 - ");
		expect(rewrite.text).toContain("; 887 routine lines hidden; full output: ");
		expect(rewrite.note).toBe("trimmed 919→32 lines (routine lines hidden)");
		const off = await setup({ hideRoutine: false, minChars: 8_000, maxChars: 8_000 }).trimmer.rewriteToolResult?.(
			draft(log),
			signal,
		);
		expect(off?.note).toContain("head/tail/errors");
		expect(off?.text).not.toContain("routine lines hidden");
	});

	it("leaves long output that is not a log alone, unless pi cut it (D-110)", async () => {
		// What a script printed on request: numbers, no errors, no routine lines, exit 0.
		const rows = Array.from({ length: 1_900 }, (_, i) => `${letters(i)},${i * 37},${(i * 0.731).toFixed(3)}`).join(
			"\n",
		);
		const data = (extra: Partial<ToolResultDraft> = {}) =>
			draft(rows, { isError: false, exitCode: 0, input: { command: "python3 report.py" }, ...extra });
		expect(await setup({ minChars: 8_000 }).trimmer.rewriteToolResult?.(data(), signal)).toBeUndefined();
		// Pi cut it to its end: the start it dropped comes back from its saved copy.
		const path = join(dir, "pi-full.log");
		writeFileSync(path, rows);
		const kept = `${rows.split("\n").slice(-200).join("\n")}\n\n[Showing lines 1701-1900 of 1900. Full output: ${path}]`;
		const recovered = await setup().trimmer.rewriteToolResult?.(data({ current: kept, fullOutputPath: path }), signal);
		expect(recovered?.text).toContain(`${letters(0)},0,0.000\n`);
		expect(recovered?.text).toContain(rows.split("\n").at(-1));
		expect(recovered?.text).not.toContain("[Showing lines");
	});

	it("shows a cut output whole from pi's saved copy when it fits, with how the command ended", async () => {
		const lines = Array.from({ length: 2_400 }, (_, i) => `step ${letters(i)}`);
		const path = join(dir, "pi-full.log");
		writeFileSync(path, lines.join("\n"));
		const status = "Command timed out after 30 seconds";
		const kept = `${lines.slice(-2_000).join("\n")}\n\n[Showing lines 401-2400 of 2400. Full output: ${path}]\n\n${status}`;
		const rewrite = await setup().trimmer.rewriteToolResult?.(draft(kept, { fullOutputPath: path, status }), signal);
		if (!rewrite) throw new Error("expected a rewrite");
		expect(rewrite.note).toBe("trimmed 2400→2400 lines (all lines)");
		expect(rewrite.text.startsWith(`step a\nstep b\n`)).toBe(true);
		expect(rewrite.text).toContain(
			`${lines.at(-1)}\n\n${status}\n[exo trimmer: showing 2400 of 2400 lines; full output: ${path}`,
		);
	});

	it("shows everything that is not routine whenever it fits, however long (D-110)", async () => {
		// Far more than the old 8k threshold of what is left, all of it within the budget.
		const out = Array.from({ length: 3_000 }, (_, i) =>
			i < 2_600 ? `test tests::case_${letters(i)} ... ok` : `   note: ${letters(i)} ${"detail ".repeat(6)}`,
		);
		const rewrite = await setup().trimmer.rewriteToolResult?.(draft(out.join("\n")), signal);
		if (!rewrite) throw new Error("expected a rewrite");
		expect(rewrite.note).toContain("routine lines hidden");
		expect(rewrite.text.match(/^ {3}note: /gm)?.length).toBe(400);
	});

	it("never cuts a failure's own line short, however long (D-110)", async () => {
		const typeError = `src/a.ts(3,5): error TS2322: Type '{ ${"field: string; ".repeat(200)}}' is not assignable to type 'Row'.`;
		const blob = `data: ${"x".repeat(3_000)}`;
		const out = [
			...Array.from({ length: 2_000 }, (_, i) => `   Compiling crate-${letters(i)} v0.1.0`),
			blob,
			typeError,
		];
		const rewrite = await setup({ minChars: 500, maxChars: 20_000 }).trimmer.rewriteToolResult?.(
			draft(out.join("\n")),
			signal,
		);
		expect(rewrite?.text).toContain(typeError);
		expect(rewrite?.text).not.toContain(blob);
		expect(rewrite?.text).toContain("…[+1006 chars]");
	});

	it("retires the sidecar's settings (D-110)", () => {
		expect((TrimmerSettingsSchema as { retired?: readonly string[] }).retired).toEqual([
			"sidecar",
			"sidecarAboveChars",
			"sidecarMaxInputChars",
			"sidecarMaxLines",
			"sidecarTimeoutMs",
		]);
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

	it("halves the error windows while the result is over maxChars, keeping the first errors", async () => {
		// 120 long, distinct errors spread through 1,200 lines: every window is kept without a budget.
		const lines = Array.from({ length: 1_200 }, (_, i) =>
			i % 10 === 5
				? `src/mod_${letters(i)}.rs:${i}:1: error: mismatched types in ${letters(i).repeat(60)}`
				: `   Generated crate-${letters(i)} v0.1.0`,
		);
		const log = lines.join("\n");
		const loose = await setup().trimmer.rewriteToolResult?.(draft(log), signal);
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
		const rewrite = await setup({ maxChars: 12_000 }).trimmer.rewriteToolResult?.(draft(lines.join("\n")), signal);
		if (!rewrite) throw new Error("expected a rewrite");
		expect(rewrite.text.length).toBeLessThanOrEqual(12_000);
		expect(rewrite.note).toContain("head/tail/errors");
	});

	it("as the last resort, leaves out whole lines from the middle, never cutting a failure's own lines (D-110)", async () => {
		// Ten failures, each one line too long to cut and too long to fit together.
		const lines = Array.from({ length: 900 }, (_, i) =>
			i % 90 === 45
				? `src/mod_${letters(i)}.ts(${i},1): error TS2322: Type '{ ${"field: string; ".repeat(60)}}' is not assignable`
				: `   Generated crate-${letters(i)} v0.1.0`,
		);
		const rewrite = await setup({ maxChars: 4_000, minChars: 500 }).trimmer.rewriteToolResult?.(
			draft(lines.join("\n")),
			signal,
		);
		if (!rewrite) throw new Error("expected a rewrite");
		expect(rewrite.text.length).toBeLessThanOrEqual(4_000);
		expect(rewrite.text).not.toContain("…[+");
		expect(rewrite.text).toContain(lines[45]);
		expect(rewrite.text).toContain(lines.at(-1));
		expect(rewrite.text).toMatch(/\[… lines \d+–\d+ omitted …\]/);
		expect(rewrite.text).not.toContain("maxChars");
	});
});

describe("saved outputs (R6)", () => {
	it("keeps each session's outputs in its own directory, readable by the user only", async () => {
		const first = setup({}, "session/one");
		const second = setup({}, "session-two");
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

	it("keeps a session's outputs after it ends, and removes those untouched for a week when one starts (D-110)", async () => {
		const first = setup({}, "one");
		await first.trimmer.rewriteToolResult?.(draft(buildLog()), signal);
		await first.trimmer.dispose?.();
		// A resumed session's context still names the file.
		const saved = join(dir, "saved", "session-one", "call_1.log");
		expect(existsSync(saved)).toBe(true);
		const old = join(dir, "other", "session-old");
		const recent = join(dir, "other", "session-recent");
		for (const path of [old, recent]) mkdirSync(path, { recursive: true });
		const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		utimesSync(old, eightDaysAgo, eightDaysAgo);
		setup({ saveDir: join(dir, "other") }, "new");
		expect(existsSync(old)).toBe(false);
		expect(existsSync(recent)).toBe(true);
	});

	it("saves under the temp directory by default", async () => {
		const sessionId = `trimmer-test-${process.pid}-${Date.now()}`;
		const t = createTestModuleContext({ cwd: dir, sessionId });
		const trimmer = createTrimmer({}, t.context);
		const rewrite = await trimmer.rewriteToolResult?.(draft(buildLog()), signal);
		const saved = join(tmpdir(), "exocortex-trimmer", `session-${sessionId}`);
		expect(rewrite?.details).toEqual({ fullOutputPath: join(saved, "call_1.log") });
		rmSync(saved, { recursive: true, force: true });
	});
});
