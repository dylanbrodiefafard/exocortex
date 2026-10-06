import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CompactionRequest, runShellCommand } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompaction, grounded, parseSummary } from "../src/compaction.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-compact-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const SUMMARY = [
	"## Objective",
	"- Implement a Forth interpreter in Rust.",
	"",
	"## Important Details",
	"- user-defined words are expanded at definition time",
	"",
	"## Work State",
	"### Completed",
	"- (none)",
	"",
	"### Active",
	"- Fixing the borrow in Interpreter::eval.",
	"",
	"### Blocked",
	"- tried RefCell: failed because of a double borrow at runtime",
	"",
	"## Next Move",
	"1. Run cargo test after cloning the word body.",
	"2. (none)",
	"",
	"## Relevant Files",
	"- src/lib.rs: the interpreter",
].join("\n");

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
		...(reply ? { reply: (r) => reply(String(r.messages[1]?.["content"])) } : {}),
	});
	return { t, module: createCompaction(settings, t.context) };
}

const FACTS = "## User requests (verbatim, oldest first)\n\n1. implement forth";

describe("compaction", () => {
	it("renders the sidecar's handover, then tracked facts verbatim", async () => {
		const prompts: string[] = [];
		const { module, t } = setup({}, (p) => {
			prompts.push(p);
			return `<template>\n${SUMMARY}\n</template>\n`;
		});
		module.onUserTurn?.({ text: "implement forth", origin: "user" });
		module.onUserTurn?.({ text: "(continuation)", origin: "extension" });
		module.onUserTurn?.({ text: "also support `: square dup * ;`", origin: "user" });
		const bash = (command: string, exitCode: number, output = "") =>
			module.onToolResult?.({ toolName: "bash", input: { command }, isError: exitCode !== 0, exitCode, output });
		bash("cargo test", 101, "running\nerror[E0502]: cannot borrow `self.stack`");
		bash("go test ./... 2>&1 | tail -5", 0, "--- FAIL: TestSteps (0.01s)\nFAIL\tpkg\t0.02s");
		bash("go vet ./... | tail -5", 0, "");
		bash("cargo fmt", 0);
		bash("ls  -la", 0);
		bash("cargo fmt", 0);
		module.onToolResult?.({ toolName: "read", input: { path: "x" }, isError: false, exitCode: null, output: "" });

		const summary = await module.compact?.(request({ conversation: "[User]: implement forth in src/lib.rs" }), signal);
		expect(summary).toBe(
			[
				SUMMARY,
				"## User requests (verbatim, oldest first)",
				"1. implement forth\n2. also support `: square dup * ;`",
				"## Files modified",
				"- src/lib.rs",
				"## Files read",
				"- README.md",
				"## Commands whose last run failed",
				[
					"- `cargo test` → exit 101: error[E0502]: cannot borrow `self.stack`",
					"- `go test ./... 2>&1 | tail -5` → errors in the output (exit code hidden by the pipe): --- FAIL: TestSteps (0.01s)",
				].join("\n"),
				"## Commands that last succeeded (no need to re-run unless something changed)",
				"- `go vet ./... | tail -5`\n- `ls -la`\n- `cargo fmt`",
			].join("\n\n"),
		);
		expect(String(t.requests[0]?.messages[0]?.["content"])).toMatch(/^You are a context summarization agent\./);
		expect(t.requests[0]?.messages[0]?.["role"]).toBe("system");
		expect(prompts[0]).toMatch(
			/^Here is the conversation so far:\n\n<conversation>\n\[User\]: implement forth in src\/lib\.rs\n<\/conversation>\n\nCreate a new anchored summary/,
		);
		expect(prompts[0]).toContain("## Relevant Files\n- [file or directory path: why it matters");
		expect(prompts[0]).toMatch(/Do not mention the summary process or that context was compacted\.$/);
		expect(prompts[0]).not.toContain("<prior-summary>");
		expect(t.requests[0]).toMatchObject({ thinking: false, maxTokens: 4_096 });
		expect(t.records).toEqual([
			{
				kind: "exo.compaction",
				data: {
					reason: "threshold",
					tokensBefore: 120_000,
					narrative: true,
					updated: false,
					userMessages: 2,
					commands: 5,
				},
			},
		]);
		expect(module.status?.()).toBe("compaction (1 summaries)");
	});

	it("merges the previous handover, keeps the latest conversation and passes user focus", async () => {
		const prompts: string[] = [];
		const { module, t } = setup({ maxConversationChars: 2_000 }, (p) => {
			prompts.push(p);
			return SUMMARY;
		});
		const previousSummary = `${SUMMARY.replace("Fixing the borrow", "Was parsing")}\n\n${FACTS.replace("implement forth", "old")}`;
		const conversation = `${"x".repeat(5_000)}THE END src/lib.rs`;
		const summary = await module.compact?.(
			request({ previousSummary, conversation, customInstructions: "the parser", userMessages: ["from the span"] }),
			signal,
		);
		expect(prompts[0]).toContain("<prior-summary>\n## Objective");
		expect(prompts[0]).toContain("- Was parsing in Interpreter::eval.");
		expect(prompts[0]).toContain(
			"- src/lib.rs: the interpreter\n</prior-summary>\n\nThe <prior-summary> summarizes everything",
		);
		// The facts are rendered again from what was tracked, not merged by the model.
		expect(prompts[0]).not.toContain("1. old");
		expect(prompts[0]).toMatch(/compacted\.\n\nThe user asked this summary to focus on: the parser$/);
		expect(prompts[0]).toContain("[… earlier transcript omitted …]");
		expect(prompts[0]).toContain("THE END");
		expect(summary).toContain("1. from the span");
		expect(t.records[0]?.data).toMatchObject({ updated: true });
	});

	it("carries a summary it did not write whole, and only the narrative of one from before D-067", async () => {
		const prior = async (previousSummary: string) => {
			const prompts: string[] = [];
			const { module } = setup({}, (p) => {
				prompts.push(p);
				return SUMMARY;
			});
			await module.compact?.(request({ previousSummary, conversation: "[User]: src/lib.rs" }), signal);
			return prompts[0] ?? "";
		};
		expect(await prior("The agent was adding a parser.")).toContain(
			"<prior-summary>\nThe agent was adding a parser.\n</prior-summary>",
		);
		expect(await prior(`${FACTS}\n\n## Current work\n\nWas parsing.`)).toContain(
			"<prior-summary>\n## Current work\n\nWas parsing.\n</prior-summary>",
		);
		// A facts-only summary holds nothing to merge.
		expect(await prior(FACTS)).not.toContain("<prior-summary>");
	});

	it("leaves compaction to the harness when the sidecar fails or ignores the template, unless the fallback is deterministic", async () => {
		const failing = setup({}, () => new Error("down"));
		expect(await failing.module.compact?.(request(), signal)).toBeUndefined();
		expect(failing.t.records).toEqual([]);
		const noEngine = setup();
		expect(await noEngine.module.compact?.(request(), signal)).toBeUndefined();
		const chatty = setup({}, () => "Sure! I will keep implementing forth.");
		expect(await chatty.module.compact?.(request(), signal)).toBeUndefined();
		expect(chatty.t.logs).toContain("summary did not follow the template: not used");
		const deterministic = setup({ fallback: "deterministic" }, () => "## Objective\n- cut off");
		const summary = await deterministic.module.compact?.(request({ filesRead: [], filesModified: [] }), signal);
		expect(summary).toBe(FACTS);
		expect(deterministic.t.records[0]?.data).toMatchObject({ narrative: false, updated: false });
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

describe("parseSummary", () => {
	it("takes the reply from the first section, without tags, a code fence or chatter before it", () => {
		expect(parseSummary(`Here is the summary:\n\`\`\`\n<template>\n${SUMMARY}  \n</template>\n\`\`\`\n`)).toBe(SUMMARY);
	});

	it("rejects a reply missing a section the agent cannot do without", () => {
		expect(parseSummary("")).toBeUndefined();
		expect(parseSummary(SUMMARY.slice(0, SUMMARY.indexOf("## Next Move")))).toBeUndefined();
		expect(parseSummary(SUMMARY.replace("## Objective", "Objective"))).toBeUndefined();
		// The last section may be lost to the token limit: the rest still hands the work over.
		const cut = SUMMARY.slice(0, SUMMARY.indexOf("## Relevant Files")).trimEnd();
		expect(parseSummary(cut)).toBe(cut);
	});
});

describe("grounded", () => {
	it("drops bullets that name things found nowhere in the transcript or workspace, except in the objective", () => {
		writeFileSync(join(dir, "real.rs"), "");
		const logs: string[] = [];
		const kept = grounded(
			[
				"## Objective",
				"- Port `legacy_vm` to Rust.",
				"## Important Details",
				"- real.rs holds the entry point",
				"- see docs/none.md",
				"- `eval` is recursive",
				"## Work State",
				"### Completed",
				"- added `Phantom`",
				"",
				"### Blocked",
				"- tried `RefCell`: double borrow",
				"- tried `made_up_fn`: did not help",
				"## Next Move",
				"1. Edit src/ghost.rs",
				"## Relevant Files",
				"A note that is not a bullet about other/ghost.rs",
			].join("\n"),
			"[Assistant]: I tried `RefCell` around `eval`",
			{ cwd: dir, log: (m) => logs.push(m) },
		);
		expect(kept).toBe(
			[
				"## Objective",
				"- Port `legacy_vm` to Rust.",
				"## Important Details",
				"- real.rs holds the entry point",
				"- `eval` is recursive",
				"## Work State",
				"### Completed",
				"- (none)",
				"",
				"### Blocked",
				"- tried `RefCell`: double borrow",
				"## Next Move",
				"- (none)",
				"## Relevant Files",
				"A note that is not a bullet about other/ghost.rs",
			].join("\n"),
		);
		expect(logs).toEqual(["dropped 4 ungrounded item(s)"]);
		expect(grounded(SUMMARY, "src/lib.rs", { cwd: dir, log: (m) => logs.push(m) })).toBe(SUMMARY);
		expect(logs).toHaveLength(1);
	});

	it("keeps accepted suggestions among the requests and gates the sidecar's summary", async () => {
		const { module } = setup({}, () =>
			SUMMARY.replace("1. Run cargo test", "1. Open `nowhere_fn`, then run cargo test"),
		);
		module.onUserTurn?.({ text: "implement forth", origin: "user" });
		module.onUserTurn?.({ text: "Not done yet. 1. Add the README", origin: "suggestion" });
		const summary = await module.compact?.(request({ conversation: "[User]: src/lib.rs" }), signal);
		expect(summary).toContain("2. Not done yet. 1. Add the README");
		expect(summary).toContain("## Next Move\n2. (none)\n\n## Relevant Files");
	});
});
