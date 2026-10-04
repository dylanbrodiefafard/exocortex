import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellCommand, type ToolOutcome } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEpisodeTracker } from "../src/episodes.ts";
import { createMemory, deterministicLesson } from "../src/memory.ts";
import { openMemoryStore } from "../src/store.ts";

let dir: string;
let dbPath: string;
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "exo-mem-"));
	dbPath = join(dir, "memory", "cards.db");
	writeFileSync(join(dir, "lib.rs"), "fn main() {}\n");
	await runShellCommand("git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm base", {
		cwd: dir,
		timeoutMs: 10_000,
	});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const ERROR = "   Compiling forth\nerror[E0502]: cannot borrow `self.stack` as mutable\n  --> lib.rs:4:9";
const fail = (command = "cargo build", output = ERROR): ToolOutcome => ({
	toolName: "bash",
	input: { command },
	isError: true,
	exitCode: 101,
	output,
});
const pass = (command = "cargo build"): ToolOutcome => ({
	toolName: "bash",
	input: { command },
	isError: false,
	exitCode: 0,
	output: "ok",
});
const edit: ToolOutcome = {
	toolName: "edit",
	input: {
		path: "lib.rs",
		edits: [{ oldText: "self.stack.push(x)", newText: "let v = x.clone(); self.stack.push(v)" }],
	},
	isError: false,
	exitCode: null,
	output: "",
};

function draft(tool: ToolOutcome) {
	return { ...tool, toolCallId: "c", current: tool.output, fullOutputPath: null };
}

function setup(settings: Record<string, unknown> = {}, reply?: (prompt: string) => SidecarReply) {
	const t = createTestModuleContext({
		cwd: dir,
		...(reply ? { reply: (r) => reply(String(r.messages[0]?.["content"])) } : {}),
	});
	return { t, memory: createMemory({ dbPath, ...settings }, t.context) };
}

async function until(predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe("episode tracker", () => {
	it("emits a fix only for fail → edit → pass of the same command", () => {
		const tracker = createEpisodeTracker();
		expect(tracker.observe(fail())).toBeUndefined();
		expect(tracker.observe(edit)).toBeUndefined();
		expect(tracker.observe(pass("cargo test"))).toBeUndefined();
		const episode = tracker.observe(pass());
		expect(episode).toMatchObject({
			command: "cargo build",
			errorLine: "error[E0502]: cannot borrow `self.stack` as mutable",
			edits: [{ path: "lib.rs", before: "self.stack.push(x)", after: "let v = x.clone(); self.stack.push(v)" }],
		});
		expect(tracker.observe(pass())).toBeUndefined();
	});

	it("ignores passes without edits, non-verifying commands, and restarts when the error changes", () => {
		const tracker = createEpisodeTracker();
		tracker.observe(fail());
		expect(tracker.observe(pass())).toBeUndefined();
		tracker.observe(fail("grep -r foo .", "error: nope"));
		tracker.observe(edit);
		expect(tracker.observe(pass("grep -r foo ."))).toBeUndefined();
		tracker.observe(fail());
		tracker.observe(edit);
		tracker.observe(fail("cargo build", "error[E0308]: mismatched types"));
		expect(tracker.observe(pass())).toBeUndefined();
		tracker.observe(fail("cargo build", "no error line here"));
		tracker.observe({ ...edit, toolName: "write", input: { path: "a.rs", content: "x" } });
		tracker.reset();
		expect(tracker.observe(pass())).toBeUndefined();
	});
});

describe("memory module", () => {
	it("learns a grounded lesson from a verified fix and recalls it in a later session", async () => {
		const { memory, t } = setup({}, () => ({
			lesson: "In lib.rs, clone the value before pushing onto `self.stack`.",
			applies_when: "pushing while borrowed",
		}));
		memory.onUserTurn?.({ text: "make it build", origin: "user" });
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await until(() => t.records.some((r) => r.kind === "exo.memory"));
		expect(t.records.at(-1)?.data).toMatchObject({ action: "learned" });
		expect(t.requests[0]?.messages[0]?.["content"]).toContain("let v = x.clone()");

		const later = setup();
		const rewrite = await later.memory.rewriteToolResult?.(
			draft(fail("cargo build", ERROR.replace("4:9", "9:1"))),
			signal,
		);
		expect(rewrite?.text).toContain("[exo memory: this error was fixed before in this repo]");
		expect(rewrite?.text).toContain("clone the value before pushing onto `self.stack`. (when: pushing while borrowed)");
		expect(later.memory.status?.()).toMatch(/memory \(1 cards · 0 learned · 1 recalled\)/);
		// Recalled once per task.
		expect(await later.memory.rewriteToolResult?.(draft(fail()), signal)).toBeUndefined();
	});

	it("credits helped when the error does not recur, hurt when it does", async () => {
		const { memory } = setup({ distill: false });
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await new Promise((r) => setTimeout(r, 50));

		const helped = setup();
		await helped.memory.rewriteToolResult?.(draft(fail()), signal);
		await helped.memory.onSettle?.({ outcome: "completed", lastAssistantText: "" }, signal);

		const hurt = setup();
		await hurt.memory.rewriteToolResult?.(draft(fail()), signal);
		hurt.memory.onToolResult?.(fail());
		hurt.memory.onUserTurn?.({ text: "next", origin: "user" });

		const cards = openMemoryStore(dbPath).cards();
		expect(cards[0]).toMatchObject({ injected: 2, helped: 1, hurt: 1 });
		expect(cards[0]?.lesson).toBe(
			"Fixed before by editing lib.rs: `self.stack.push(x)` → `let v = x.clone(); self.stack.push(v)`",
		);
	});

	it("falls back to a deterministic lesson when the sidecar's lesson names unknown things", async () => {
		const { memory, t } = setup({}, () => ({
			lesson: "Call `rebalance_tree` in src/tree.rs first.",
			applies_when: "",
		}));
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await until(() => t.records.some((r) => r.kind === "exo.memory"));
		expect(String((t.records.at(-1)?.data as { lesson?: string } | undefined)?.lesson)).toMatch(
			/^Fixed before by editing lib\.rs/,
		);
	});

	it("merges a repeat of a known fix without asking the sidecar again", async () => {
		const { memory, t } = setup({}, () => ({
			lesson: "Clone before pushing onto `self.stack` in lib.rs.",
			applies_when: "",
		}));
		for (let i = 0; i < 2; i++) {
			memory.onToolResult?.(fail());
			memory.onToolResult?.(edit);
			memory.onToolResult?.(pass());
			await until(() => t.records.length > i);
		}
		expect(t.records.map((r) => (r.data as { action: string }).action)).toEqual(["learned", "merged"]);
		expect(t.requests).toHaveLength(1);
		expect(openMemoryStore(dbPath).cards()[0]?.seen).toBe(2);
	});

	it("does not learn or inject when switched off, and ignores successes", async () => {
		const { memory, t } = setup({ learn: false, inject: false });
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await new Promise((r) => setTimeout(r, 30));
		expect(t.records).toEqual([]);
		expect(await memory.rewriteToolResult?.(draft(fail()), signal)).toBeUndefined();
		expect(await setup().memory.rewriteToolResult?.(draft(pass()), signal)).toBeUndefined();
	});

	it("reports invalid settings", () => {
		const { t } = setup({ maxCards: 99 });
		expect(t.logs.some((l) => l.startsWith("memory /maxCards"))).toBe(true);
	});
});

describe("deterministicLesson", () => {
	it("names the files and the first change", () => {
		expect(
			deterministicLesson({
				command: "make",
				signature: "s",
				errorLine: "e",
				excerpt: "",
				edits: [
					{ path: "a.cpp", before: "int x", after: "long x" },
					{ path: "b.cpp", before: "", after: "" },
				],
			}),
		).toBe("Fixed before by editing a.cpp, b.cpp: `int x` → `long x`");
	});
});
