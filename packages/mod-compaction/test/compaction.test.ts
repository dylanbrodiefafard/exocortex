import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CompactionRequest, runShellCommand } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompaction, grounded } from "../src/compaction.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-compact-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const NARRATIVE = {
	current_work: "Fixing the borrow in Interpreter::eval.",
	next_step: "Run cargo test after cloning the word body.",
	dead_ends: ["tried RefCell: failed because of a double borrow at runtime"],
	key_facts: ["user-defined words are expanded at definition time"],
};

function request(extra: Partial<CompactionRequest> = {}): CompactionRequest {
	return {
		reason: "threshold",
		conversation: "[User]: implement forth\n\n[Assistant]: on it",
		userMessages: ["implement forth"],
		previousSummary: null,
		filesRead: ["src/lib.rs", "README.md"],
		filesModified: ["src/lib.rs"],
		tokensBefore: 120_000,
		customInstructions: null,
		...extra,
	};
}

function setup(settings: Record<string, unknown> = {}, reply?: (prompt: string) => SidecarReply) {
	const t = createTestModuleContext({
		cwd: dir,
		...(reply ? { reply: (r) => reply(String(r.messages[0]?.["content"])) } : {}),
	});
	return { t, module: createCompaction(settings, t.context) };
}

describe("compaction", () => {
	it("renders tracked facts verbatim plus the sidecar narrative", async () => {
		const prompts: string[] = [];
		const { module, t } = setup({}, (p) => {
			prompts.push(p);
			return NARRATIVE;
		});
		module.onUserTurn?.({ text: "implement forth", origin: "user" });
		module.onUserTurn?.({ text: "(continuation)", origin: "extension" });
		module.onUserTurn?.({ text: "also support `: square dup * ;`", origin: "user" });
		const bash = (command: string, exitCode: number, output = "") =>
			module.onToolResult?.({ toolName: "bash", input: { command }, isError: exitCode !== 0, exitCode, output });
		bash("cargo test", 101, "running\nerror[E0502]: cannot borrow `self.stack`");
		bash("cargo fmt", 0);
		bash("ls  -la", 0);
		bash("cargo fmt", 0);
		module.onToolResult?.({ toolName: "read", input: { path: "x" }, isError: false, exitCode: null, output: "" });

		const summary = await module.compact?.(request(), signal);
		expect(summary).toBe(
			[
				"## User requests (verbatim, oldest first)",
				"1. implement forth\n2. also support `: square dup * ;`",
				"## Files modified",
				"- src/lib.rs",
				"## Files read",
				"- README.md",
				"## Commands whose last run failed",
				"- `cargo test` → exit 101: error[E0502]: cannot borrow `self.stack`",
				"## Commands that last succeeded (no need to re-run unless something changed)",
				"- `ls -la`\n- `cargo fmt`",
				"## Current work",
				"Fixing the borrow in Interpreter::eval.\nNext: Run cargo test after cloning the word body.",
				"## Dead ends (do not retry)",
				"- tried RefCell: failed because of a double borrow at runtime",
				"## Key facts",
				"- user-defined words are expanded at definition time",
			].join("\n\n"),
		);
		expect(prompts[0]).toContain("[User]: implement forth");
		expect(prompts[0]).not.toContain("previous compaction");
		expect(t.requests[0]?.thinking).toBe(false);
		expect(t.records).toEqual([
			{
				kind: "exo.compaction",
				data: { reason: "threshold", tokensBefore: 120_000, narrative: true, userMessages: 2, commands: 3 },
			},
		]);
		expect(module.status?.()).toBe("compaction (1 summaries)");
	});

	it("updates the previous narrative, keeps the latest conversation and passes user focus", async () => {
		const prompts: string[] = [];
		const { module } = setup({ maxConversationChars: 2_000 }, (p) => {
			prompts.push(p);
			return { ...NARRATIVE, dead_ends: [], key_facts: [] };
		});
		const previousSummary = "## User requests (verbatim, oldest first)\n\n1. old\n\n## Current work\n\nWas parsing.";
		const conversation = `${"x".repeat(5_000)}THE END`;
		const summary = await module.compact?.(
			request({ previousSummary, conversation, customInstructions: "the parser", userMessages: ["from the span"] }),
			signal,
		);
		expect(prompts[0]).toContain("## Current work\n\nWas parsing.");
		expect(prompts[0]).not.toContain("1. old");
		expect(prompts[0]).toContain("focus on: the parser");
		expect(prompts[0]).toContain("[… earlier transcript omitted …]");
		expect(prompts[0]).toContain("THE END");
		expect(summary).toContain("1. from the span");
		expect(summary).not.toContain("Dead ends");
	});

	it("leaves compaction to the harness when the sidecar fails, unless the fallback is deterministic", async () => {
		const failing = setup({}, () => new Error("down"));
		expect(await failing.module.compact?.(request(), signal)).toBeUndefined();
		expect(failing.t.records).toEqual([]);
		const noEngine = setup();
		expect(await noEngine.module.compact?.(request(), signal)).toBeUndefined();
		const deterministic = setup({ fallback: "deterministic" });
		const summary = await deterministic.module.compact?.(request({ filesRead: [], filesModified: [] }), signal);
		expect(summary).toBe("## User requests (verbatim, oldest first)\n\n1. implement forth");
	});

	it("adds git diff stats for modified files", async () => {
		writeFileSync(join(dir, "a.txt"), "one\n");
		await runShellCommand("git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm base", {
			cwd: dir,
			timeoutMs: 10_000,
		});
		writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
		const { module } = setup({ fallback: "deterministic" });
		const summary = await module.compact?.(request({ filesModified: ["b.txt"] }), signal);
		expect(summary).toContain("## Files modified\n\n- a.txt (+2 −0)\n- b.txt");
	});

	it("truncates huge user messages and long file lists, and reports invalid settings", async () => {
		const invalid = setup({ timeoutMs: 5 });
		expect(invalid.t.logs.some((l) => l.startsWith("compaction /timeoutMs"))).toBe(true);
		const { module } = setup({ fallback: "deterministic", maxUserMessageChars: 200 });
		const files = Array.from({ length: 45 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
		const summary = await module.compact?.(
			request({ userMessages: ["y".repeat(5_000)], filesModified: files }),
			signal,
		);
		expect(summary).toContain("… [truncated]");
		expect(summary).toContain("- … and 5 more");
	});
});

describe("grounded", () => {
	it("drops list items and a next step that name things found nowhere in the transcript or workspace", () => {
		writeFileSync(join(dir, "real.rs"), "");
		const logs: string[] = [];
		const kept = grounded(
			{
				current_work: "Fixing `eval`.",
				next_step: "Edit src/ghost.rs to add `Phantom`.",
				dead_ends: ["tried `RefCell`: double borrow", "tried `made_up_fn`: did not help"],
				key_facts: ["real.rs holds the entry point", "`eval` is recursive", "see docs/none.md"],
			},
			"[Assistant]: I tried `RefCell` around `eval`",
			{ cwd: dir, log: (m) => logs.push(m) },
		);
		expect(kept).toEqual({
			current_work: "Fixing `eval`.",
			next_step: "",
			dead_ends: ["tried `RefCell`: double borrow"],
			key_facts: ["real.rs holds the entry point", "`eval` is recursive"],
		});
		expect(logs).toEqual(["dropped 2 ungrounded item(s) and the next step"]);
	});

	it("keeps accepted suggestions among the requests and leaves out an empty next step", async () => {
		const { module } = setup({}, () => ({ ...NARRATIVE, next_step: "Open `nowhere_fn`." }));
		module.onUserTurn?.({ text: "implement forth", origin: "user" });
		module.onUserTurn?.({ text: "Not done yet. 1. Add the README", origin: "suggestion" });
		const summary = await module.compact?.(request(), signal);
		expect(summary).toContain("2. Not done yet. 1. Add the README");
		expect(summary).toContain("## Current work\n\nFixing the borrow in Interpreter::eval.\n\n## Dead ends");
		expect(summary).not.toContain("Next:");
	});
});
