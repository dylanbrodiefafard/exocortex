import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatRequest, type CompactionRequest, type ExoModule, SIDECAR_THINKING_TOKENS } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply, TruncatedReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompaction } from "../src/compaction.ts";
import { grounded, parseSummary } from "../src/narrative.ts";

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

/** The text of the summary the module wrote, if it wrote one. */
async function summaryOf(module: ExoModule, req: CompactionRequest): Promise<string | undefined> {
	return (await module.compact?.(req, signal))?.summary;
}

function request(extra: Partial<CompactionRequest> = {}): CompactionRequest {
	return {
		reason: "threshold",
		conversation: "[User]: implement forth\n\n[Assistant]: on it",
		userMessages: ["implement forth"],
		previousSummary: null,
		previousDetails: null,
		filesRead: ["src/lib.rs", "README.md"],
		filesModified: ["src/lib.rs"],
		tokensBefore: 120_000,
		contextWindow: null,
		customInstructions: null,
		fork: null,
		conversationSince: () => "",
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
		bash("go test ./pkg | tail -5", 0, "ok  \texample.com/pkg\t0.21s");
		bash("cargo fmt", 0);
		bash("ls  -la", 0);
		bash("cargo fmt", 0);
		// Not a known run, and piped: its exit code was `tail`'s, so it is listed nowhere (D-077).
		bash("./integration.sh 2>&1 | tail -3", 0, "3 scenarios run");
		module.onToolResult?.({ toolName: "read", input: { path: "x" }, isError: false, exitCode: null, output: "" });

		const summary = await summaryOf(
			module,
			request({
				conversation: "[User]: implement forth in src/lib.rs",
				userMessages: ["implement forth", "(continuation)", "also support `: square dup * ;`"],
			}),
		);
		expect(summary).toBe(
			[
				SUMMARY,
				"## User requests (verbatim, oldest first)",
				"1. implement forth\n2. also support `: square dup * ;`",
				"## Files modified",
				"- src/lib.rs",
				"## Files read",
				"- README.md\n- x",
				"## Commands whose last run failed",
				[
					"- `cargo test` → exit 101: error[E0502]: cannot borrow `self.stack`",
					"- `go test ./... 2>&1 | tail -5` → errors in the output (exit code hidden by the pipe): --- FAIL: TestSteps (0.01s)",
				].join("\n"),
				"## Commands that last succeeded (no need to re-run unless something changed)",
				"- `go test ./pkg | tail -5`\n- `ls -la`\n- `cargo fmt`",
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
		// A summary judges what mattered: it thinks, with room for that on top of the summary (D-106).
		expect(t.requests[0]).toMatchObject({ thinking: true, maxTokens: 12_288 + SIDECAR_THINKING_TOKENS });
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
					unverified: 0,
					early: "none",
				},
			},
		]);
		// Counted once the summary is used.
		expect(module.status?.()).toBe("compaction");
	});

	it("merges the previous handover, keeps the latest conversation that fits the window and passes user focus", async () => {
		const prompts: string[] = [];
		const { module, t } = setup({}, (p) => {
			prompts.push(p);
			return SUMMARY;
		});
		const previousSummary = `${SUMMARY.replace("Fixing the borrow", "Was parsing")}\n\n${FACTS.replace("implement forth", "old")}`;
		// A window too small for it: the transcript keeps its newest 20,000 characters.
		const conversation = `${"x".repeat(25_000)}THE END src/lib.rs`;
		const summary = await summaryOf(
			module,
			request({
				previousSummary,
				conversation,
				contextWindow: 16_000,
				customInstructions: "the parser",
				userMessages: ["from the span"],
			}),
		);
		expect(t.logs).toContain(
			`summary from the transcript: its oldest ${conversation.length - 20_000} characters left out to fit the context window`,
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
		// The earlier requests are read from the previous summary; the span's follow them.
		expect(summary).toContain("1. old\n2. from the span");
		expect(t.records[0]?.data).toMatchObject({ updated: true });
	});

	it("carries a summary it did not write whole, and only the narrative of one from before D-067", async () => {
		const prior = async (previousSummary: string) => {
			const prompts: string[] = [];
			const { module } = setup({}, (p) => {
				prompts.push(p);
				return SUMMARY;
			});
			await summaryOf(module, request({ previousSummary, conversation: "[User]: src/lib.rs" }));
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

	it("hands over only the facts, for the harness's own summary to come first, when the sidecar cannot write one (D-111)", async () => {
		const facts = { summary: FACTS, part: "facts" };
		const failing = setup({}, () => new Error("down"));
		expect(await failing.module.compact?.(request(), signal)).toMatchObject({
			...facts,
			summary: `${FACTS}\n\n## Files modified\n\n- src/lib.rs\n\n## Files read\n\n- README.md`,
		});
		expect(failing.t.records[0]?.data).toMatchObject({ narrative: false, updated: false });
		expect(failing.t.logs.join("\n")).toContain("summary error");
		const noEngine = setup();
		expect(await noEngine.module.compact?.(request({ filesRead: [], filesModified: [] }), signal)).toMatchObject(facts);
		const chatty = setup({}, () => "Sure! I will keep implementing forth.");
		const chattyResult = await chatty.module.compact?.(request({ filesRead: [], filesModified: [] }), signal);
		expect(chattyResult).toMatchObject(facts);
		expect(chatty.t.logs).toContain("summary did not follow the template: not used");
		// The facts are kept with the compaction like any other summary's, for the next one.
		expect(chattyResult?.details?.["facts"]).toMatchObject({ requests: ["implement forth"] });
		// Settings retired by D-111 are read without them.
		expect(setup({ fallback: "deterministic", maxConversationChars: 60_000 }).t.logs).toEqual([]);
	});

	it("asks again at twice the limit for a summary cut off at it, and never uses one cut off (D-111)", async () => {
		const cut = (text: string) => new TruncatedReply(text);
		let calls = 0;
		const once = setup({ maxSummaryTokens: 1_000 }, () => {
			calls += 1;
			return calls === 1 ? cut(SUMMARY) : SUMMARY;
		});
		expect(await summaryOf(once.module, request())).toContain("## Objective");
		expect(once.t.requests.map((r) => r.maxTokens - SIDECAR_THINKING_TOKENS)).toEqual([1_000, 2_000]);

		const twice = setup({ maxSummaryTokens: 1_000 }, () => cut(SUMMARY));
		expect(await twice.module.compact?.(request(), signal)).toMatchObject({ part: "facts" });
		expect(twice.t.requests).toHaveLength(2);
		expect(twice.t.logs).toContain("summary was cut off at 20 tokens: not used");

		// No room in the window for the larger limit and the thinking room: asking again would be refused.
		const full = setup({ maxSummaryTokens: 1_000 }, () => cut(SUMMARY));
		await full.module.compact?.(request({ contextWindow: 100 + 2_000 + SIDECAR_THINKING_TOKENS - 1 }), signal);
		expect(full.t.requests).toHaveLength(1);
		expect(full.t.logs).toContain("summary was cut off at 20 tokens: not used");
		const roomy = setup({ maxSummaryTokens: 1_000 }, () => cut(SUMMARY));
		await roomy.module.compact?.(request({ contextWindow: 100 + 2_000 + SIDECAR_THINKING_TOKENS }), signal);
		expect(roomy.t.requests).toHaveLength(2);
	});

	it("lists the files changed, many of them, and the newest of those read, and reports invalid settings", async () => {
		const invalid = setup({ maxSummaryTokens: 5 });
		expect(invalid.t.logs.some((l) => l.startsWith("compaction /maxSummaryTokens"))).toBe(true);
		const { module } = setup({ maxUserMessageChars: 200 });
		const files = Array.from({ length: 105 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
		const read = Array.from({ length: 45 }, (_, i) => `r${String(i).padStart(2, "0")}.ts`);
		const summary =
			(await summaryOf(
				module,
				request({ userMessages: ["y".repeat(5_000)], filesModified: files, filesRead: read }),
			)) ?? "";
		expect(summary).toContain("… [truncated]");
		expect(summary).toContain("- f104.ts\n- … and 5 more");
		expect(summary).not.toContain("- f004.ts");
		// The newest read are kept.
		expect(summary).toContain("- r05.ts");
		expect(summary).not.toContain("- r04.ts");
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
	it("marks names found nowhere in the transcript or workspace, except in the objective, and keeps every bullet", () => {
		writeFileSync(join(dir, "real.rs"), "");
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
				"2. Create `fresh.rs` beside real.rs",
				"## Relevant Files",
				"A note that is not a bullet about other/ghost.rs",
			].join("\n"),
			"[Assistant]: I tried `RefCell` around `eval`",
			{ cwd: dir },
		);
		expect(kept.text).toBe(
			[
				"## Objective",
				"- Port `legacy_vm` to Rust.",
				"## Important Details",
				"- real.rs holds the entry point",
				"- see docs/none.md [unverified: docs/none.md]",
				"- `eval` is recursive",
				"## Work State",
				"### Completed",
				"- added Phantom [unverified: Phantom]",
				"",
				"### Blocked",
				"- tried `RefCell`: double borrow",
				"- tried made_up_fn: did not help [unverified: made_up_fn]",
				"## Next Move",
				// No `src` directory to create it in.
				"1. Edit src/ghost.rs [unverified: src/ghost.rs]",
				"2. Create `fresh.rs` beside real.rs",
				"## Relevant Files",
				"A note that is not a bullet about other/ghost.rs",
			].join("\n"),
		);
		expect(kept.unverified).toEqual(["docs/none.md", "Phantom", "made_up_fn", "src/ghost.rs"]);
		expect(grounded(SUMMARY, "src/lib.rs", { cwd: dir })).toEqual({ text: SUMMARY, unverified: [] });
	});

	it("does not take a path outside the workspace, or a symbol, for a file to create", () => {
		const next = (step: string) => grounded(`## Objective\n- x\n## Next Move\n1. ${step}`, "", { cwd: dir }).unverified;
		expect(next("Write ../outside.rs")).toEqual(["../outside.rs"]);
		expect(next("Call `new_fn`")).toEqual(["new_fn"]);
		expect(next("Write notes.md")).toEqual([]);
	});

	it("keeps accepted suggestions among the requests and gates the sidecar's summary", async () => {
		const { module, t } = setup({}, () =>
			SUMMARY.replace("1. Run cargo test", "1. Open `nowhere_fn`, then run cargo test"),
		);
		module.onUserTurn?.({ text: "implement forth", origin: "user" });
		module.onUserTurn?.({ text: "Not done yet. 1. Add the README", origin: "suggestion" });
		const summary = await summaryOf(
			module,
			request({
				conversation: "[User]: src/lib.rs",
				userMessages: ["implement forth", "Not done yet. 1. Add the README"],
			}),
		);
		expect(summary).toContain("2. Not done yet. 1. Add the README");
		expect(summary).toContain(
			"## Next Move\n1. Open nowhere_fn, then run cargo test after cloning the word body. [unverified: nowhere_fn]\n2. (none)\n\n## Relevant Files",
		);
		// The gate working is traced, not reported as a problem.
		expect(t.records[0]?.data).toMatchObject({ unverified: 1, unverifiedNames: ["nowhere_fn"] });
		expect(t.logs).toEqual([]);
	});
});

describe("the summary as a fork of the main agent's context (D-093)", () => {
	const fork = {
		body: {
			model: "m",
			messages: [
				{ role: "user", content: "implement forth" },
				{ role: "assistant", content: "editing src/kept_only.rs" },
			],
		},
	};
	const engine = { features: { cacheReadOnly: true, cachedTokens: true }, cachedTokens: 95 };
	function forked(settings: Record<string, unknown>, options: object, reply: (r: ChatRequest) => SidecarReply) {
		const t = createTestModuleContext({ cwd: dir, ...options, reply });
		return { t, module: createCompaction(settings, t.context) };
	}

	describe("the summary written early (D-098)", () => {
		const DONE = { outcome: "completed" as const, lastAssistantText: "done" };
		const at = (tokens: number) => ({ ...DONE, context: { tokens, compactAt: 100_000 } });
		const idle = () => new Promise((resolve) => setTimeout(resolve, 30));
		const EARLY = SUMMARY.replace(
			"Implement a Forth interpreter in Rust.",
			"Implement a Forth interpreter in Rust (written early).",
		);
		function early(reply: (r: ChatRequest) => SidecarReply = (r) => (r.fork ? EARLY : SUMMARY)) {
			const t = createTestModuleContext({ cwd: dir, ...engine, forkPrefix: fork, reply });
			return { t, module: createCompaction({}, t.context) };
		}

		it("is written in the background once the context passes the threshold, not before", async () => {
			const { module, t } = early();
			module.onSettled?.(at(60_000));
			await idle();
			expect(t.requests).toEqual([]);
			module.onSettled?.(at(75_000));
			await idle();
			expect(t.requests).toHaveLength(1);
			expect(t.requests[0]?.fork).toBe(fork);
			expect(t.records).toEqual([
				{ kind: "exo.compaction", data: { action: "early_summary", tokens: 75_000, compactAt: 100_000 } },
			]);
			// Not again until the context grew by a tenth of the threshold.
			module.onSettled?.(at(80_000));
			await idle();
			expect(t.requests).toHaveLength(1);
			module.onSettled?.(at(86_000));
			await idle();
			expect(t.requests).toHaveLength(2);
		});

		it("is used as written when nothing came after it, and updated with only what did", async () => {
			const { module, t } = early();
			module.onSettled?.(at(75_000));
			await idle();
			const asWritten = await module.compact?.(request({ conversationSince: () => "" }), signal);
			expect(asWritten?.summary).toContain("(written early)");
			expect(t.requests).toHaveLength(1);
			expect(t.records.at(-1)?.data).toMatchObject({ narrative: true, early: "as_written" });

			const since: number[] = [];
			const updated = await module.compact?.(
				request({
					conversationSince: (ms) => {
						since.push(ms);
						return "[User]: also add DROP";
					},
				}),
				signal,
			);
			expect(updated?.summary).toContain("## Objective");
			const prompt = String(t.requests.at(-1)?.messages[1]?.["content"]);
			expect(prompt).toContain("(written early)");
			expect(prompt).toContain("[User]: also add DROP");
			// Only what came after the fork, not the whole span.
			expect(prompt).not.toContain("[User]: implement forth\n\n[Assistant]: on it");
			expect(since).toHaveLength(1);
			expect(t.records.at(-1)?.data).toMatchObject({ early: "updated" });
		});

		it("is dropped once the context was compacted, and left alone by a summary with the user's own focus", async () => {
			const { module, t } = early();
			module.onSettled?.(at(75_000));
			await idle();
			const focused = await module.compact?.(request({ customInstructions: "the parser" }), signal);
			expect(focused?.summary).not.toContain("(written early)");
			module.onCompacted?.();
			const after = await module.compact?.(request({ conversationSince: () => "" }), signal);
			expect(after?.summary).not.toContain("(written early)");
			expect(t.records.at(-1)?.data).toMatchObject({ early: "none" });
		});

		it("is not used once a compaction happened while it was written, or on another branch", async () => {
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const { module, t } = early(async (r) => {
				if (r.fork) await gate;
				return r.fork ? EARLY : SUMMARY;
			});
			module.onSettled?.(at(75_000));
			// pi compacts before the early summary is back.
			module.onCompacted?.();
			release();
			await idle();
			const after = await module.compact?.(request({ conversationSince: () => "" }), signal);
			expect(after?.summary).not.toContain("(written early)");

			const fresh = early();
			fresh.module.onSettled?.(at(75_000));
			await idle();
			// The user moved to another branch: the context no longer begins with what the fork read.
			const other = { body: { model: "m", messages: [{ role: "user", content: "something else entirely" }] } };
			await fresh.module.compact?.(request({ fork: other, conversationSince: () => "" }), signal);
			// Written whole from the new branch's fork, not from the early summary.
			expect(fresh.t.records.at(-1)?.data).toMatchObject({ early: "none" });
			expect(fresh.t.requests.at(-1)?.fork).toBe(other);
			expect(t.records.at(-1)?.data).toMatchObject({ early: "none" });
		});

		it("is stopped when the agent starts again, when compaction comes, and with the module (D-111)", async () => {
			for (const stop of [
				(m: ExoModule) => m.onUserTurn?.({ text: "next", origin: "user" }),
				(m: ExoModule) =>
					m.onToolResult?.({ toolName: "read", input: { path: "x" }, isError: false, exitCode: null, output: "" }),
				(m: ExoModule) => m.dispose?.(),
				(m: ExoModule) => void m.compact?.(request({ conversationSince: () => "" }), signal),
			]) {
				// The fork's reply never comes: only stopping the call ends it.
				const { module, t } = early((r) => (r.fork ? new Promise<string>(() => {}) : SUMMARY));
				module.onSettled?.(at(75_000));
				await idle();
				expect(t.requests).toHaveLength(1);
				stop(module);
				await idle();
				// The fake engine answers a stopped call by failing it; nothing of it is kept or said.
				expect(t.records.filter((r) => r.data && (r.data as { action?: string }).action === "early_summary")).toEqual(
					[],
				);
				expect(t.logs).toEqual([]);
				// Not stuck: the next stop past the threshold writes it again.
				module.onSettled?.(at(90_000));
				await idle();
				expect(t.requests.filter((r) => r.fork).length).toBe(2);
			}
		});

		it("is not written when switched off or with no fork to be had", async () => {
			const off = createTestModuleContext({ cwd: dir, ...engine, forkPrefix: fork, reply: () => SUMMARY });
			createCompaction({ earlySummary: false }, off.context).onSettled?.(at(90_000));
			createCompaction({ fork: false }, off.context).onSettled?.(at(90_000));
			const none = createTestModuleContext({ cwd: dir, ...engine, reply: () => SUMMARY });
			const module = createCompaction({}, none.context);
			module.onSettled?.(at(90_000));
			await idle();
			module.onSettled?.(at(99_000));
			await idle();
			expect([...off.requests, ...none.requests]).toEqual([]);
			// Said once, not at every stop.
			expect(none.logs).toEqual(["early summary not written: no fork of the agent's context"]);
		});
	});

	it("shows the summary growing while the user waits, instead of a deadline (D-098)", async () => {
		const long = `${SUMMARY}\n${"- more detail on the parser\n".repeat(20)}`;
		const { module, t } = forked({}, engine, () => long);
		await summaryOf(module, request({ fork }));
		expect(t.progress).toEqual([
			"Writing the compaction summary…",
			`Writing the compaction summary… ${Math.round(long.length / 4)} tokens`,
		]);
	});

	it("continues the main agent's context with the instruction alone", async () => {
		const { module, t } = forked({}, engine, () => `${SUMMARY}\n- \`src/kept_only.rs\`: next`);
		const summary = await summaryOf(module, request({ fork, customInstructions: "the parser" }));
		expect(t.requests).toHaveLength(1);
		const [sent] = t.requests;
		expect(sent?.fork).toBe(fork);
		// A fork thinks as the agent does: the client changes it only where the engine keeps the prefix (F4, D-100).
		expect(sent?.thinking).toBe(true);
		expect(sent?.messages).toHaveLength(1);
		const prompt = String(sent?.messages[0]?.["content"]);
		expect(prompt).toContain("do not call a tool");
		expect(prompt).toContain("## Objective");
		expect(prompt).toContain("focus on: the parser");
		// The transcript is what the fork replaces.
		expect(prompt).not.toContain("[User]: implement forth");
		// A name only in the messages the harness keeps was read by the fork: it is not marked.
		expect(summary).toContain("- `src/kept_only.rs`: next");
	});

	it("asks with the transcript when there is no fork to be had", async () => {
		const transcript = (t: { requests: ChatRequest[] }) =>
			t.requests.filter((r) => !r.fork).map((r) => String(r.messages[1]?.["content"]));
		// The engine cannot fork, the setting is off, or the harness gave none.
		for (const [settings, options, req] of [
			[{}, {}, request({ fork })],
			[{ fork: false }, engine, request({ fork })],
			[{}, engine, request()],
		] as const) {
			const { module, t } = forked(settings, options, () => SUMMARY);
			expect(await summaryOf(module, req)).toContain("## Objective");
			expect(t.requests).toHaveLength(1);
			expect(transcript(t)[0]).toContain("[User]: implement forth");
		}
		// A fork that answered the conversation instead is not used.
		const { module, t } = forked({}, engine, (r) => (r.fork ? "Sure, running the tests now." : SUMMARY));
		expect(await summaryOf(module, request({ fork }))).toContain("## Objective");
		expect(t.requests.map((r) => r.fork !== undefined)).toEqual([true, false]);
		expect(t.logs.join("\n")).toContain("did not follow the template");
	});
});
