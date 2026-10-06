import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, ToolOutcome, ToolResultDraft } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach } from "vitest";
import { createMemory } from "../src/memory.ts";

/** A fresh directory (not a git repo: the scope is its path) and a store inside it, per test. */
export function workspace(): { readonly dir: () => string; readonly dbPath: () => string } {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "exo-mem-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	return { dir: () => dir, dbPath: () => join(dir, "memory", "cards.db") };
}

export const signal = new AbortController().signal;
export const SETTLED = { outcome: "completed", lastAssistantText: "Done." } as const;

export const ERROR = "   Compiling forth\nerror[E0502]: cannot borrow `self.stack` as mutable\n  --> lib.rs:4:9";

export const bash = (command: string, output = "", exitCode = 0): ToolOutcome => ({
	toolName: "bash",
	input: { command },
	isError: exitCode !== 0,
	exitCode,
	output,
});
export const fail = (command = "cargo build", output = ERROR): ToolOutcome => bash(command, output, 101);
export const pass = (command = "cargo build"): ToolOutcome => bash(command, "ok");
export const editOf = (path: string, oldText: string, newText: string): ToolOutcome => ({
	toolName: "edit",
	input: { path, edits: [{ oldText, newText }] },
	isError: false,
	exitCode: null,
	output: "",
});
export const writeOf = (path: string, content: string): ToolOutcome => ({
	toolName: "write",
	input: { path, content },
	isError: false,
	exitCode: null,
	output: "",
});
export const edit = editOf("lib.rs", "self.stack.push(x)", "let v = x.clone(); self.stack.push(v)");

export function draft(tool: ToolOutcome): ToolResultDraft {
	return { ...tool, toolCallId: "c", current: tool.output, fullOutputPath: null, status: null };
}

let sessions = 0;

/** One module instance. Each call is a new harness session unless `sessionId` says otherwise. */
export function setup(
	space: { dir: () => string; dbPath: () => string },
	settings: Record<string, unknown> = {},
	options: {
		readonly reply?: (prompt: string, index: number) => SidecarReply | Promise<SidecarReply>;
		readonly sessionId?: string;
		readonly savedState?: JsonValue | undefined;
	} = {},
) {
	const { reply } = options;
	const t = createTestModuleContext({
		cwd: space.dir(),
		sessionId: options.sessionId ?? `session-${++sessions}`,
		...(options.savedState === undefined ? {} : { savedState: options.savedState }),
		...(reply ? { reply: (r, index) => reply(String(r.messages[0]?.["content"]), index) } : {}),
	});
	const memory = createMemory({ dbPath: space.dbPath(), ...settings }, t.context);
	/** The rewrite for a failing result, taken as shown to the agent (the host commits what it hands over). */
	const recall = async (tool: ToolOutcome) => {
		const rewrite = await memory.rewriteToolResult?.(draft(tool), signal);
		rewrite?.commit?.();
		return rewrite;
	};
	const actions = () => t.records.map((r) => (r.data as { action: string; reason?: string }).action);
	const reasons = () => t.records.flatMap((r) => (r.data as { reason?: string }).reason ?? []);
	return { t, memory, recall, actions, reasons };
}

export async function until(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
}

/** Long enough for background learning that awaits nothing but the scope and the store. */
export const idle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));
