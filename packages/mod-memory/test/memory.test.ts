import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorSignature, runShellCommand, type ToolOutcome, type UserTurnContext } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cardDetail, detailShare, FAILURE_DETAIL_LINES, failureDetail } from "../src/detail.ts";
import { createEpisodeTracker } from "../src/episodes.ts";
import { createMemory, deterministicLesson, recall } from "../src/memory.ts";
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
/** The note the module adds to a prompt, taken as shown: the host commits what it hands to the harness (D-078). */
const shown = async (context: Promise<UserTurnContext | undefined> | undefined): Promise<string | undefined> => {
	const added = await context;
	added?.commit?.();
	return added?.text;
};
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
	return { ...tool, toolCallId: "c", current: tool.output, fullOutputPath: null, status: null };
}

type Embed = (texts: readonly string[]) => number[][] | undefined;

function setup(settings: Record<string, unknown> = {}, reply?: (prompt: string) => SidecarReply, embed?: Embed) {
	const t = createTestModuleContext({
		cwd: dir,
		...(reply ? { reply: (r) => reply(String(r.messages[0]?.["content"])) } : {}),
		...(embed ? { embed } : {}),
	});
	return { t, memory: createMemory({ dbPath, ...settings }, t.context) };
}

async function until(predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe("episode tracker", () => {
	it("emits a fix only for fail → edit → pass of the same command", () => {
		const tracker = createEpisodeTracker();
		expect(tracker.observe(fail())).toEqual([]);
		expect(tracker.observe(edit)).toEqual([]);
		expect(tracker.observe(pass("cargo test"))).toEqual([]);
		// Redirecting the output does not make it another command.
		const episodes = tracker.observe(pass("cargo build 2>&1"));
		expect(episodes).toMatchObject([
			{
				command: "cargo build",
				errorLine: "error[E0502]: cannot borrow `self.stack` as mutable",
				detail: ["stack", "e0502"],
				steps: [
					{
						edits: [{ path: "lib.rs", before: "self.stack.push(x)", after: "let v = x.clone(); self.stack.push(v)" }],
						retries: 0,
					},
				],
			},
		]);
		expect(tracker.observe(pass())).toEqual([]);
	});

	it("ignores passes without edits and non-verifying commands", () => {
		const tracker = createEpisodeTracker();
		tracker.observe(fail());
		expect(tracker.observe(pass())).toEqual([]);
		tracker.observe(fail("grep -r foo .", "error: nope"));
		tracker.observe(edit);
		expect(tracker.observe(pass("grep -r foo ."))).toEqual([]);
		tracker.observe(fail());
		tracker.observe(edit);
		tracker.observe(fail("cargo build", "no error line here"));
		expect(tracker.observe(pass())).toEqual([]);
		tracker.observe(fail());
		tracker.observe({ ...edit, toolName: "write", input: { path: "a.rs", content: "x" } });
		tracker.reset();
		expect(tracker.observe(pass())).toEqual([]);
	});

	it("keeps the first error when the error changes, and gives an episode for it and for the last (D-072)", () => {
		const tracker = createEpisodeTracker();
		const other = { ...edit, input: { path: "b.rs", edits: [{ oldText: "a", newText: "b" }] } };
		tracker.observe(fail());
		tracker.observe(edit);
		tracker.observe(fail());
		tracker.observe(edit);
		tracker.observe(fail("cargo build", "error[E0308]: mismatched types"));
		tracker.observe(other);
		const episodes = tracker.observe(pass());
		expect(
			episodes.map((e) => [e.errorLine, e.steps.map((s) => s.edits.map((x) => x.path)), e.steps[0]?.retries]),
		).toEqual([
			["error[E0502]: cannot borrow `self.stack` as mutable", [["lib.rs", "lib.rs"], ["b.rs"]], 1],
			["error[E0308]: mismatched types", [["b.rs"]], 0],
		]);
	});

	it("does not keep an error that went away with nothing edited", () => {
		const tracker = createEpisodeTracker();
		tracker.observe(fail());
		tracker.observe(fail("cargo build", "error[E0308]: mismatched types"));
		tracker.observe(edit);
		expect(tracker.observe(pass()).map((e) => e.errorLine)).toEqual(["error[E0308]: mismatched types"]);
	});
});

describe("failure detail (D-072)", () => {
	const TABLE = [
		"simple_table --- FAILED",
		"thread 'simple_table' (207059) panicked at tests/render.rs:8:5:",
		"assertion `left == right` failed",
		"error: test failed, to rerun pass `--test render`",
	].join("\n");
	const INI = [
		"thread 'empty_input' (31) panicked at tests/parser.rs:4:5:",
		"error: test failed, to rerun pass `--test parser`",
	].join("\n");

	it("keeps the names a failure mentions and drops what every failure prints", () => {
		expect(cardDetail(TABLE)).toEqual(["simple_table", "render"]);
		expect(cardDetail("all good")).toEqual([]);
	});

	it("tells two failures with one signature apart, and finds a card's problem further down the output", () => {
		const table = cardDetail(TABLE);
		expect(detailShare(table, new Set(failureDetail(INI, FAILURE_DETAIL_LINES)))).toBe(0);
		const later = `thread 'aaa' (1) panicked at tests/other.rs:1:1:\n${TABLE}`;
		expect(detailShare(table, new Set(failureDetail(later, FAILURE_DETAIL_LINES)))).toBe(1);
		expect(detailShare([], new Set())).toBe(1);
	});
});

describe("memory module", () => {
	it("learns from a test run behind a pipe by reading its output, and not from one it cannot read (D-075)", async () => {
		const piped = (output: string, hidden?: "passed" | "failed" | "unknown"): ToolOutcome => ({
			toolName: "bash",
			input: { command: "cargo test 2>&1 | tail -5" },
			isError: false,
			exitCode: 0,
			output,
			...(hidden ? { hidden } : {}),
		});
		const failing = "test parse_ini ... FAILED\nerror: test failed, to rerun pass `--lib`";
		const { memory, t } = setup({}, () => ({
			lesson: "In lib.rs, clone the value before pushing onto `self.stack`.",
			applies_when: "pushing while borrowed",
		}));
		memory.onUserTurn?.({ text: "make the tests pass", origin: "user" });
		memory.onToolResult?.(piped(failing));
		memory.onToolResult?.(edit);
		// Nothing in the output says how the run ended: no card.
		memory.onToolResult?.(piped("warning: unused import"));
		await new Promise((r) => setTimeout(r, 30));
		expect(t.records).toEqual([]);
		// The same run cut differently, with the runner's summary in what was kept.
		memory.onToolResult?.({
			...piped("test result: ok. 9 passed; 0 failed"),
			input: { command: "cargo test | tail -2" },
		});
		await until(() => t.records.some((r) => r.kind === "exo.memory"));
		expect(t.records.at(-1)?.data).toMatchObject({ action: "learned" });

		// A later session's piped failure recalls it; the harness's reading counts too.
		const later = setup();
		const recalled = await later.memory.rewriteToolResult?.(draft(piped(failing)), signal);
		expect(recalled?.text).toContain("exo memory");
		const viaHarness = setup();
		expect(await viaHarness.memory.rewriteToolResult?.(draft(piped("1 failing", "unknown")), signal)).toBeUndefined();
	});

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
		expect(rewrite?.text).toContain("check a note against the current code before relying on it.]");
		expect(rewrite?.text).toContain(
			"- (this error, this repo; the fix edited lib.rs) In lib.rs, clone the value before pushing onto `self.stack`. (when: pushing while borrowed)",
		);
		expect(later.memory.status?.()).toMatch(/memory \(1 cards · 0 learned · 1 recalled\)/);
		// Recalled once per task.
		expect(await later.memory.rewriteToolResult?.(draft(fail()), signal)).toBeUndefined();
	});

	it("credits a card by what its command did next: helped on a pass, hurt when the problem keeps coming back", async () => {
		const { memory } = setup({ distill: false });
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await new Promise((r) => setTimeout(r, 50));
		const settle = { outcome: "completed", lastAssistantText: "" } as const;

		// One more failure, then the command passes: the card helped.
		const helped = setup();
		await helped.memory.rewriteToolResult?.(draft(fail()), signal);
		helped.memory.onToolResult?.(fail());
		helped.memory.onToolResult?.(pass());
		await helped.memory.onSettle?.(settle, signal);
		expect(helped.t.records.at(-1)?.data).toMatchObject({ action: "credited", outcome: "helped" });

		// The problem came back and the command never passed.
		const hurt = setup();
		await hurt.memory.rewriteToolResult?.(draft(fail()), signal);
		hurt.memory.onToolResult?.(fail());
		hurt.memory.onUserTurn?.({ text: "next", origin: "user" });

		// It came back twice before the pass.
		const slow = setup();
		await slow.memory.rewriteToolResult?.(draft(fail()), signal);
		slow.memory.onToolResult?.(fail());
		slow.memory.onToolResult?.(fail());
		slow.memory.onToolResult?.(pass());
		await slow.memory.onSettle?.(settle, signal);

		// The command was never run again, or failed with another problem: no evidence either way.
		const unknown = setup();
		await unknown.memory.rewriteToolResult?.(draft(fail()), signal);
		unknown.memory.onToolResult?.(fail("cargo build", "error[E0502]: cannot borrow `other.queue` as immutable"));
		unknown.memory.onToolResult?.(pass("cargo test"));
		await unknown.memory.onSettle?.(settle, signal);
		expect(unknown.t.records.some((r) => (r.data as { action?: string }).action === "credited")).toBe(false);

		const cards = openMemoryStore(dbPath).cards();
		expect(cards[0]).toMatchObject({ injected: 4, helped: 1, hurt: 2 });
		expect(cards[0]?.lesson).toBe(
			"Fixed before by editing lib.rs: `self.stack.push(x)` → `let v = x.clone(); self.stack.push(v)`",
		);
	});

	it("keeps a card per problem when two problems share a signature, and recalls only the one that failed (D-072)", async () => {
		const STACK = "error[E0502]: cannot borrow `self.stack` as mutable\n  --> lib.rs:4:9";
		const QUEUE = "error[E0502]: cannot borrow `jobs.queue` as immutable\n  --> lib.rs:40:9";
		const { memory, t } = setup({ distill: false });
		for (const output of [STACK, QUEUE, STACK]) {
			memory.onToolResult?.(fail("cargo build", output));
			memory.onToolResult?.(edit);
			memory.onToolResult?.(pass());
		}
		await until(() => t.records.length === 3);
		expect(t.records.map((r) => (r.data as { action: string }).action)).toEqual(["learned", "learned", "merged"]);
		const store = openMemoryStore(dbPath);
		expect(store.cards().map((c) => [c.seen, c.detail.includes("queue")])).toEqual([
			[2, false],
			[1, true],
		]);

		const later = setup();
		const rewrite = await later.memory.rewriteToolResult?.(draft(fail("cargo build", QUEUE)), signal);
		expect(rewrite?.note).toBe("recalled 1 card(s)");
		expect(later.t.records.at(-1)?.data).toMatchObject({ cards: [store.cards()[1]?.id], matches: ["same"] });
		// A third problem of the same kind names neither card's things: the signature alone recalls nothing.
		const third = "error[E0502]: cannot borrow `cache.entries` as mutable\n  --> lib.rs:90:9";
		expect(await setup().memory.rewriteToolResult?.(draft(fail("cargo build", third)), signal)).toBeUndefined();
		expect(
			recall(store, "elsewhere", store.cards()[0]?.signature ?? "", third, {
				maxCards: 2,
				minOverlap: 0.6,
				minDetail: 0,
			}),
		).toEqual([]);
	});

	it("recalls a problem fixed in two other repos, and says where it comes from", () => {
		const store = openMemoryStore(dbPath);
		const output = "ModuleNotFoundError: No module named 'yaml'";
		const signature = errorSignature("bash", 1, output);
		const base = { signature, detail: cardDetail(output), files: ["setup.cfg"], trigger: output, evidence: "{}" };
		store.add({ ...base, scope: "repo-a", lesson: "Install pyyaml." });
		const settings = { maxCards: 2, minOverlap: 0.6, minDetail: 0.6 };
		expect(recall(store, "repo-z", signature, output, settings)).toEqual([]);
		store.add({ ...base, scope: "repo-b", lesson: "Add pyyaml to the dev requirements." });
		expect(recall(store, "repo-z", signature, output, settings).map((r) => r.match)).toEqual([
			"elsewhere",
			"elsewhere",
		]);
		// The same signature, another module.
		const other = "ModuleNotFoundError: No module named 'requests'";
		expect(errorSignature("bash", 1, other)).toBe(signature);
		expect(recall(store, "repo-z", signature, other, settings)).toEqual([]);
	});

	it("shows the lesson sidecar the whole route when the error changed on the way to the pass", async () => {
		const { memory, t } = setup({}, () => ({ lesson: "", applies_when: "" }));
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(fail("cargo build", "error[E0308]: mismatched types"));
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await until(() => t.requests.length === 2);
		const first = String(t.requests[0]?.messages[0]?.["content"]);
		expect(first).toContain("1. The command failed:");
		expect(first).toContain("(The command failed with this same error 1 more time(s) during these edits.)");
		expect(first).toContain("2. The command then failed with a different error:");
		expect(first).toContain("3. The command passed.");
		expect(String(t.requests[1]?.messages[0]?.["content"])).toContain("2. The command passed.");
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

	it("makes no card when the sidecar finds nothing reusable in the fix", async () => {
		const { memory, t } = setup({}, () => ({ lesson: "", applies_when: "" }));
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await until(() => t.records.length > 0);
		expect(t.records.map((r) => r.data)).toEqual([
			{ action: "skipped", reason: "not_reusable", signature: expect.stringContaining("cannot borrow") },
		]);
		expect(openMemoryStore(dbPath).cards()).toEqual([]);
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
	it("names the files and the change that was in place when the command passed", () => {
		const step = { errorLine: "e", excerpt: "", retries: 0 };
		expect(
			deterministicLesson({
				command: "make",
				signature: "s",
				errorLine: "e",
				detail: [],
				steps: [
					{ ...step, edits: [{ path: "a.cpp", before: "int y", after: "short y" }] },
					{ ...step, edits: [{ path: "b.cpp", before: "int x", after: "long x" }] },
				],
			}),
		).toBe("Fixed before by editing a.cpp, b.cpp: `int x` → `long x`");
	});
});

describe("preferences (D-060)", () => {
	const TDD = "Write the failing test before the implementation.";
	const DONE = { outcome: "completed" as const, lastAssistantText: "Done." };
	const proposal = (extra: Record<string, unknown>) => ({
		preferences: [
			{
				rule: TDD,
				quote: "",
				standing: false,
				applies_to: "any",
				correction: false,
				same_as: 0,
				replaces: 0,
				...extra,
			},
		],
	});
	const actions = (t: { records: { data: unknown }[] }) => t.records.map((r) => (r.data as { action: string }).action);

	/** One session: the user says `text`, the agent settles, the sidecar proposes `reply`. */
	async function session(text: string, reply: object) {
		const s = setup({ preferences: true }, () => reply);
		s.memory.onUserTurn?.({ text, origin: "user" });
		await s.memory.onSettle?.(DONE, signal);
		await until(() => s.t.requests.length > 0);
		await new Promise((r) => setTimeout(r, 20));
		return s;
	}
	const ask = (memory: ReturnType<typeof createMemory>, text: string, origin: "user" | "suggestion" = "user") =>
		shown(memory.contextForUserTurn?.({ text, origin }, signal));

	it("learns a standing rule from the user's words and adds it to a later prompt that leaves it unsaid", async () => {
		const first = await session(
			"Add a parser for dates. And always write the failing test first, please.",
			proposal({ quote: "always write the failing test first" }),
		);
		expect(actions(first.t)).toEqual(["preference_learned"]);
		expect(String(first.t.requests[0]?.messages[0]?.["content"])).toContain("Known preferences:\n(none)");

		const { memory, t } = setup({ preferences: true });
		expect(await ask(memory, "thanks a lot")).toBeUndefined();
		expect(await ask(memory, "Add durations, and write the failing test before the implementation")).toBeUndefined();
		expect(await ask(memory, "Not done yet. Please finish the README.", "suggestion")).toBeUndefined();
		const added = await ask(memory, "Add a function that parses durations");
		expect(added).toBe(
			`[exo memory: standing preferences from this user's earlier sessions. This request does not repeat them: follow them where they apply. If the request conflicts with one, the request wins.]\n- ${TDD}`,
		);
		expect(t.records.at(-1)?.data).toEqual({ action: "preferences_added", preferences: [1] });
		// Once per conversation, until a compaction may have dropped it.
		expect(await ask(memory, "Now add a function that parses intervals")).toBeUndefined();
		memory.onCompacted?.();
		expect(await ask(memory, "Now add a function that parses intervals")).toContain(TDD);
		expect(memory.status?.()).toContain("1 preferences");
		expect(openMemoryStore(dbPath).preferences()[0]).toMatchObject({ injected: 2, rule: TDD });
	});

	it("waits for a second session when the user did not say it as a standing rule", async () => {
		const said = "Write the tests first for the parser, then implement it.";
		await session(said, proposal({ quote: "Write the tests first" }));
		expect(await ask(setup({ preferences: true }).memory, "Add a function that parses durations")).toBeUndefined();

		// Said again elsewhere: the sidecar recognises it, or failing that the wording does.
		const second = await session(said, proposal({ quote: "Write the tests first", same_as: 1 }));
		expect(actions(second.t)).toEqual(["preference_seen"]);
		const third = await session(said, proposal({ rule: `${TDD.slice(0, -1)} code.`, quote: "Write the tests first" }));
		expect(actions(third.t)).toEqual(["preference_seen"]);
		expect(await ask(setup({ preferences: true }).memory, "Add a function that parses durations")).toContain(
			`- ${TDD} (said in 3 sessions)`,
		);
	});

	it("admits only what the user said: no invented quotes, one-offs or unknown names", async () => {
		const text = "Fix the date parser. Skip the tests this time, and keep the change small.";
		for (const item of [
			{ quote: "always write tests before code" },
			{ quote: "Skip the tests this time", rule: "Do not write tests." },
			{ quote: "keep the change small", rule: "Keep changes small and update `docs/STYLE.md`." },
			{ quote: "keep the change small", rule: "x" },
		]) {
			const s = await session(text, proposal(item));
			expect(s.t.records).toEqual([]);
		}
		expect(openMemoryStore(dbPath).preferences()).toEqual([]);
	});

	it("retires a preference the user withdraws, but not for a one-off exception", async () => {
		await session("From now on write the failing test first.", proposal({ quote: "write the failing test first" }));
		const oneOff = await session(
			"Skip the tests this time, just patch the config file quickly.",
			proposal({ rule: "", quote: "Skip the tests this time", replaces: 1 }),
		);
		expect(oneOff.t.records).toEqual([]);
		const withdrawn = await session(
			"Stop writing tests first, I do not want that anymore.",
			proposal({ rule: "", quote: "Stop writing tests first", replaces: 1 }),
		);
		expect(actions(withdrawn.t)).toEqual(["preference_retired"]);
		expect(String(withdrawn.t.requests[0]?.messages[0]?.["content"])).toContain(`Known preferences:\n1. ${TDD}`);
		expect(await ask(setup({ preferences: true }).memory, "Add a function that parses durations")).toBeUndefined();
	});

	it("lists and forgets preferences on command", async () => {
		const { memory } = await session(
			"I prefer small commits with one change each.",
			proposal({ rule: "Keep each commit to one change.", quote: "I prefer small commits with one change each" }),
		);
		expect(memory.command?.("preferences")).toBe(
			"1. Keep each commit to one change. (said in 1 session; applies here; added 0×)",
		);
		expect(memory.command?.("forget x")).toBe("Usage: /exo memory forget <id>");
		expect(memory.command?.("forget 7")).toBe("No preference 7.");
		expect(memory.command?.("forget 1")).toContain("Forgot preference 1.");
		expect(memory.command?.("preferences")).toBe(
			"No preferences learned yet. /exo memory interview asks a few questions to start from.",
		);
		expect(memory.command?.("on")).toBeUndefined();
		expect(setup().memory.command?.("preferences")).toBe("Preference learning is off (memory.preferences).");
	});

	it("is off by default, skips short messages and survives a failing sidecar", async () => {
		const off = setup({}, () => proposal({ quote: "always write the failing test first" }));
		off.memory.onUserTurn?.({ text: "Always write the failing test first, please.", origin: "user" });
		await off.memory.onSettle?.(DONE, signal);
		expect(await ask(off.memory, "Add a function that parses durations")).toBeUndefined();
		await new Promise((r) => setTimeout(r, 30));
		expect(off.t.requests).toEqual([]);

		const short = setup({ preferences: true }, () => proposal({}));
		short.memory.onUserTurn?.({ text: "yes, continue", origin: "user" });
		short.memory.onUserTurn?.({ text: "Not done yet. Please finish the README file.", origin: "suggestion" });
		await short.memory.onSettle?.(DONE, signal);
		await new Promise((r) => setTimeout(r, 30));
		expect(short.t.requests).toEqual([]);

		const broken = await session("Always write the failing test first, please.", new Error("down"));
		expect(broken.t.logs.some((l) => l.startsWith("preferences "))).toBe(true);
		expect(openMemoryStore(dbPath).preferences()).toEqual([]);
	});
});

describe("expectations from corrections (D-064)", () => {
	const SCOPE = "Do not refactor nearby code.";
	const CORRECTION = "No, don't refactor the code around it when you fix a bug. Put it back.";
	const QUOTE = "don't refactor the code around it when you fix a bug";
	const DONE = { outcome: "completed" as const, lastAssistantText: "Fixed the off-by-one and tidied the module." };
	const item = (extra: Record<string, unknown> = {}) => ({
		rule: SCOPE,
		quote: QUOTE,
		standing: false,
		applies_to: "fix",
		correction: true,
		same_as: 0,
		replaces: 0,
		...extra,
	});
	const actions = (t: { records: { data: unknown }[] }) => t.records.map((r) => (r.data as { action: string }).action);
	const settled = async (s: ReturnType<typeof setup>, requests: number) => {
		await s.memory.onSettle?.(DONE, signal);
		await until(() => s.t.requests.length >= requests);
		await new Promise((r) => setTimeout(r, 20));
	};

	/** One session: a request, the agent's answer, then the user's correction of it. */
	async function corrected(proposed: object = item()) {
		const s = setup({ preferences: true, preferenceSelect: false }, (prompt) => ({
			preferences: prompt.includes(`Developer's message:\n<<<\n${CORRECTION}`) ? [proposed] : [],
		}));
		s.memory.onUserTurn?.({ text: "Fix the off-by-one in the date parser.", origin: "user" });
		await settled(s, 1);
		s.memory.onUserTurn?.({ text: CORRECTION, origin: "user" });
		await settled(s, 2);
		return s;
	}
	const ask = (memory: ReturnType<typeof createMemory>, text: string) =>
		shown(memory.contextForUserTurn?.({ text, origin: "user" }, signal));

	it("learns what the user expects of one kind of task from a correction, and says so on later prompts", async () => {
		const first = await corrected();
		expect(first.t.records.map((r) => r.data)).toEqual([
			{ action: "preference_learned", preference: 1, rule: SCOPE, correction: true },
		]);
		// The sidecar is shown what the agent said, to tell a correction from a new request.
		expect(String(first.t.requests[1]?.messages[0]?.["content"])).toContain(DONE.lastAssistantText);
		expect(first.memory.command?.("preferences")).toBe(
			`1. For bug fixes: ${SCOPE} (said in 1 session; 1 as a correction; not yet established; added 0×)`,
		);
		// One correction is one task's instruction (D-060); the second session makes it an expectation.
		expect(await ask(setup({ preferences: true }).memory, "Fix the crash on empty input")).toBeUndefined();
		expect(actions((await corrected(item({ same_as: 1 }))).t)).toEqual(["preference_seen"]);
		const later = setup({ preferences: true, preferenceSelect: false });
		expect(await ask(later.memory, "Fix the crash on empty input")).toContain(
			`- For bug fixes: ${SCOPE} (said in 2 sessions)`,
		);
		expect(openMemoryStore(dbPath).preferences()[0]).toMatchObject({ taskKind: "fix", injected: 1 });
	});

	it("does not count a session's first message as a correction", async () => {
		const s = setup({ preferences: true }, () => ({ preferences: [item()] }));
		s.memory.onUserTurn?.({ text: CORRECTION, origin: "user" });
		await settled(s, 1);
		expect(s.t.records.map((r) => r.data)).toEqual([{ action: "preference_learned", preference: 1, rule: SCOPE }]);
		expect(openMemoryStore(dbPath).preferences()[0]?.sightings[0]?.correction).toBe(false);
	});

	it("widens an expectation the user states for a second kind of task", async () => {
		await corrected();
		await corrected(item({ same_as: 1, applies_to: "feature" }));
		expect(openMemoryStore(dbPath).preferences()[0]).toMatchObject({ taskKind: "any" });
	});

	it("counts a correction on a preference that was already in the conversation", async () => {
		await corrected(item({ standing: true }));
		const s = setup({ preferences: true, preferenceSelect: false }, () => ({ preferences: [item({ same_as: 1 })] }));
		expect(await ask(s.memory, "Fix the crash on empty input")).toContain(SCOPE);
		s.memory.onUserTurn?.({ text: "Fix the crash on empty input", origin: "user" });
		await settled(s, 1);
		s.memory.onUserTurn?.({ text: CORRECTION, origin: "user" });
		await settled(s, 2);
		// The agent had been told, and the user still had to say it.
		expect(actions(s.t)).toEqual(["preferences_added", "preference_seen", "preference_repeated"]);
		expect(openMemoryStore(dbPath).preferences()[0]).toMatchObject({ repeated: 1 });
		expect(s.memory.command?.("preferences")).toContain("corrected again after being added 1×");
	});
});

describe("embeddings (D-062)", () => {
	/** A toy embedding space: borrow errors point one way, everything else another. */
	const embed: Embed = (texts) =>
		texts.map((t) => (/borrow/i.test(t) ? [1, 0.1] : /mutabl/i.test(t) ? [1, 0.3] : [0, 1]));
	const REWORDED = "error: `self.stack` is already mutably held here\n  --> lib.rs:9:1";
	const UNRELATED = "error: linker `cc` not found";

	async function learnCard(embedder: Embed | undefined) {
		const s = setup({ distill: false }, undefined, embedder);
		s.memory.onToolResult?.(fail());
		s.memory.onToolResult?.(edit);
		s.memory.onToolResult?.(pass());
		await until(() => s.t.records.length > 0);
		await new Promise((r) => setTimeout(r, 20));
		return s;
	}
	const recallFor = (memory: ReturnType<typeof createMemory>, output: string) =>
		memory.rewriteToolResult?.(draft(fail("cargo build", output)), signal);

	it("recalls a card for the same error in other words, which keywords miss", async () => {
		await learnCard(embed);
		expect(await recallFor(setup().memory, REWORDED)).toBeUndefined();
		const rewrite = await recallFor(setup({}, undefined, embed).memory, REWORDED);
		expect(rewrite?.text).toContain(
			"- (a similar error, this repo; the fix edited lib.rs) Fixed before by editing lib.rs",
		);
		expect(await recallFor(setup({}, undefined, embed).memory, UNRELATED)).toBeUndefined();
		expect(await recallFor(setup({ minSimilarity: 0.99 }, undefined, embed).memory, REWORDED)).toBeUndefined();
	});

	it("embeds cards learned before a server existed, and falls back to keywords when the server fails", async () => {
		await learnCard(undefined);
		const { memory } = setup({}, undefined, embed);
		// The first failure finds no vectors and starts the backfill; the next one can use them.
		expect(await recallFor(memory, REWORDED)).toBeUndefined();
		await until(() => openMemoryStore(dbPath).vectors("card", "test-embed").size === 1);
		expect((await recallFor(memory, REWORDED))?.note).toBe("recalled 1 card(s)");

		const down = setup({}, undefined, () => undefined).memory;
		expect(await recallFor(down, REWORDED)).toBeUndefined();
		expect((await recallFor(down, ERROR))?.note).toBe("recalled 1 card(s)");
	});

	it("recognises a preference said in other words as the one it already knows", async () => {
		const prefer: Embed = (texts) => texts.map((t) => (/test|tdd/i.test(t) ? [1, 0] : [0, 1]));
		const DONE = { outcome: "completed" as const, lastAssistantText: "" };
		const say = async (text: string, rule: string, quote: string, embedder: Embed | undefined) => {
			const proposal = {
				preferences: [{ rule, quote, standing: false, applies_to: "any", correction: false, same_as: 0, replaces: 0 }],
			};
			const s = setup({ preferences: true }, () => proposal, embedder);
			s.memory.onUserTurn?.({ text, origin: "user" });
			await s.memory.onSettle?.(DONE, signal);
			await until(() => s.t.records.length > 0);
			return (s.t.records[0]?.data as { action?: string } | undefined)?.action;
		};
		const first = "Write the tests first for the parser, then implement it.";
		const second = "Do this one TDD style like we usually do in the parser.";
		expect(await say(first, "Write the failing test before the implementation.", "Write the tests first", prefer)).toBe(
			"preference_learned",
		);
		expect(await say(second, "Work in TDD style.", "TDD style", prefer)).toBe("preference_seen");
		expect(await say(second, "Keep functions short.", "TDD style", prefer)).toBe("preference_learned");
		// Without embeddings the reworded rule shares too few words to be recognised.
		expect(await say(second, "Work in TDD style.", "TDD style", undefined)).toBe("preference_learned");
		const stored = openMemoryStore(dbPath);
		expect(stored.preferences().map((p) => p.sightings.length)).toEqual([2, 1, 1]);
		expect(stored.vectors("preference", "test-embed").size).toBe(2);
	});
});

describe("preference selection and standing rules by sidecar (D-062)", () => {
	const DONE = { outcome: "completed" as const, lastAssistantText: "" };
	const RULES = ["Write the failing test before the implementation.", "Keep each commit to one change."];

	function seed() {
		const store = openMemoryStore(dbPath);
		for (const rule of RULES) {
			const id = store.addPreference(rule);
			store.addSighting(id, { scope: "a", session: "s1", standing: false, correction: false, quote: "q" });
			store.addSighting(id, { scope: "b", session: "s2", standing: false, correction: false, quote: "q" });
		}
	}

	it("counts a preference as shown only when the host says the note reached the prompt (D-078, B4)", async () => {
		seed();
		const { memory, t } = setup({ preferences: true, preferenceSelect: false });
		const injected = () =>
			openMemoryStore(dbPath)
				.preferences()
				.map((p) => p.injected);
		const turn = { text: "Add a parser for durations", origin: "user" as const };
		// The note lost its time budget: the host never calls commit.
		const dropped = await memory.contextForUserTurn?.(turn, signal);
		expect(dropped?.text).toContain(`- ${RULES[0]}`);
		expect(injected()).toEqual([0, 0]);
		expect(t.records).toEqual([]);
		// So the same preferences are offered again, and counted once they are shown.
		const again = await memory.contextForUserTurn?.(turn, signal);
		expect(again?.text).toBe(dropped?.text);
		again?.commit?.();
		expect(injected()).toEqual([1, 1]);
		expect(t.records.map((r) => (r.data as { action: string }).action)).toEqual(["preferences_added"]);
		expect(await memory.contextForUserTurn?.(turn, signal)).toBeUndefined();
	});

	it("asks a sidecar which preferences fit the prompt, and keeps the rest for a later prompt", async () => {
		seed();
		const prompts: string[] = [];
		// The sidecar answers with the number the rule has in the list it was shown (9 is not in it).
		const numberOf = (prompt: string, rule: string) => Number(new RegExp(`(\\d+)\\. ${rule}`).exec(prompt)?.[1]);
		const picks = [RULES[1], undefined, RULES[0]];
		const { memory, t } = setup({ preferences: true }, (prompt) => {
			prompts.push(prompt);
			const rule = picks[prompts.length - 1];
			return { apply: rule === undefined ? [] : [numberOf(prompt, rule), 9] };
		});
		const ask = (text: string) => shown(memory.contextForUserTurn?.({ text, origin: "user" }, signal));
		const first = await ask("Commit the config change you just made");
		expect(first).toContain(`- ${RULES[1]}`);
		expect(first).not.toContain(RULES[0]);
		expect(prompts[0]).toContain(`. ${RULES[0]}\n`);
		expect(prompts[0]).toContain("Commit the config change you just made");
		expect(t.progress).toEqual(["Recalling your preferences…"]);
		// Nothing fits a question; the unused preference is offered again on the next prompt.
		expect(await ask("How does the parser handle nested quotes?")).toBeUndefined();
		expect(prompts[1]).not.toContain(RULES[1]);
		expect(await ask("Add support for escaped quotes to it")).toContain(`- ${RULES[0]}`);
		expect(await ask("Add support for tabs as well")).toBeUndefined();
		expect(prompts).toHaveLength(3);
	});

	it("falls back to keyword filtering when the sidecar fails or selection is off", async () => {
		seed();
		const failing = setup({ preferences: true }, () => new Error("down"));
		const text = "Add durations, keeping each commit to one change";
		const added = await shown(failing.memory.contextForUserTurn?.({ text, origin: "user" }, signal));
		expect(added).toContain(`- ${RULES[0]}`);
		expect(added).not.toContain(RULES[1]);
		expect(failing.t.logs.some((l) => l.startsWith("preference selection "))).toBe(true);

		const off = setup({ preferences: true, preferenceSelect: false }, () => ({ apply: [] }));
		expect(await shown(off.memory.contextForUserTurn?.({ text, origin: "user" }, signal))).toContain(`- ${RULES[0]}`);
		expect(off.t.requests).toEqual([]);
	});

	it("lets the sidecar call a rule standing when the wording has no fixed cue", async () => {
		const proposal = (standing: boolean) => ({
			preferences: [
				{
					rule: RULES[0],
					quote: "a TDD person",
					standing,
					applies_to: "any",
					correction: false,
					same_as: 0,
					replaces: 0,
				},
			],
		});
		for (const [standing, applies] of [
			[false, false],
			[true, true],
		] as const) {
			rmSync(dbPath, { force: true });
			const s = setup({ preferences: true, preferenceSelect: false }, () => proposal(standing));
			s.memory.onUserTurn?.({ text: "Fix the date parser. You know me, a TDD person.", origin: "user" });
			await s.memory.onSettle?.(DONE, signal);
			await until(() => s.t.records.length > 0);
			const next = setup({ preferences: true, preferenceSelect: false });
			const added = await shown(
				next.memory.contextForUserTurn?.({ text: "Add a parser for durations", origin: "user" }, signal),
			);
			expect(added !== undefined).toBe(applies);
		}
	});
});
