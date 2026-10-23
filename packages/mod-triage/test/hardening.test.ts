import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, JsonValue, ToolOutcome, ToolResultDraft } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTriage } from "../src/triage.ts";

/** Regression tests for the hardening pass (HARDENING_PLAN section T, D-082) and for D-108. */

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-triage-"));
	writeFileSync(join(dir, "lib.rs"), "fn main() {}\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const E0502 = "error[E0502]: cannot borrow `self.stack` as mutable\n  --> src/lib.rs:42:9\nerror: could not compile";
const E0308 = "error[E0308]: mismatched types\n  --> src/lib.rs:7:1\nerror: could not compile";
const HINT = { diagnosis: "The borrow of `self.stack` outlives the push.", next_action: "Clone the value first." };

function draft(output: string, extra: Partial<ToolResultDraft> = {}): ToolResultDraft {
	return {
		toolName: "bash",
		toolCallId: "c1",
		input: { command: "cargo build" },
		isError: true,
		exitCode: 101,
		output,
		current: output,
		fullOutputPath: null,
		status: null,
		...extra,
	};
}

const passed = (command = "cargo build", output = "Finished") =>
	draft(output, { input: { command }, isError: false, exitCode: 0 });

const edited = (path: string): ToolOutcome => ({
	toolName: "edit",
	input: { path, edits: [{ oldText: "a", newText: "b" }] },
	isError: false,
	exitCode: null,
	output: "ok",
});

function setup(
	settings: Record<string, unknown> = {},
	reply?: (prompt: string) => SidecarReply | Promise<SidecarReply>,
	savedState?: JsonValue,
) {
	const t = createTestModuleContext({
		cwd: dir,
		...(savedState === undefined ? {} : { savedState }),
		...(reply ? { reply: (request) => reply(String(request.messages[0]?.["content"])) } : {}),
	});
	return { t, triage: createTriage(settings, t.context) };
}

type Triage = ReturnType<typeof createTriage>;

/** One tool result as the host delivers it, without telling the module its rewrite was used. */
async function offer(triage: Triage, d: ToolResultDraft) {
	triage.onToolResult?.(d);
	return triage.rewriteToolResult?.(d, signal);
}

/** One tool result whose rewrite reached the model. */
async function deliver(triage: Triage, d: ToolResultDraft) {
	const rewrite = await offer(triage, d);
	rewrite?.commit?.();
	return rewrite;
}

const sent = (t: { late: string[] }, n: number) => vi.waitFor(() => expect(t.late).toHaveLength(n));
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** A reply that waits until released, as a slow engine does. */
function gated() {
	const waiting: (() => void)[] = [];
	return {
		reply: () => new Promise<SidecarReply>((resolve) => waiting.push(() => resolve(HINT))),
		release: () => {
			for (const go of waiting.splice(0)) go();
		},
		waiting,
	};
}

describe("hints from a fork of the agent's context (D-099, the default since D-108)", () => {
	const engine = { features: { cacheReadOnly: true, cachedTokens: true }, cachedTokens: 95 };
	const toolCall = (id: string) => ({ id, type: "function", function: { name: "bash", arguments: "{}" } });
	// As pi serializes a context mid-batch: the calls, each answered "No result provided" (D-099).
	const fork = (...ids: string[]) => ({
		body: {
			model: "m",
			messages: [
				{ role: "user", content: "make the interpreter compile; keep `self.stack` a Vec" },
				{ role: "assistant", content: null, tool_calls: ids.map(toolCall) },
				...ids.map((id) => ({ role: "tool", tool_call_id: id, content: "No result provided" })),
			],
		},
	});
	function forked(forkPrefix: ReturnType<typeof fork>, reply: (request: ChatRequest) => SidecarReply) {
		const t = createTestModuleContext({ cwd: dir, ...engine, forkPrefix, reply: (request) => reply(request) });
		return { t, triage: createTriage({}, t.context) };
	}
	const FORK_HINT = {
		diagnosis: "The push borrows `self.stack` while it is borrowed.",
		next_action: "Clone the word first, as the user asked to keep `self.stack` a Vec.",
	};

	it("asks the fork, answering the pending tool calls first, and sends its hint", async () => {
		const { triage, t } = forked(fork("c1", "c9"), (r) => (r.fork ? FORK_HINT : HINT));
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502));
		await sent(t, 1);
		expect(t.late[0]).toContain("Clone the word first");
		const [asked] = t.requests;
		expect(asked?.fork?.body["messages"]).toEqual([
			expect.objectContaining({ role: "user" }),
			expect.objectContaining({ role: "assistant" }),
			{ role: "tool", tool_call_id: "c1", content: expect.stringContaining("E0502") },
			{ role: "tool", tool_call_id: "c9", content: "(this tool's result is not available yet)" },
		]);
		expect(String(asked?.messages[0]?.["content"])).toContain("Stop working on the task for a moment");
		// The JSON shape is asked of the prompt, not of the engine: a fork's tools rule that out on ninfer.
		expect(String(asked?.messages.at(-1)?.["content"])).toContain("JSON");
		expect(t.requests).toHaveLength(1);
	});

	it("shows the fork the result as the agent sees it, notice included", async () => {
		const { triage, t } = forked(fork("c1"), () => FORK_HINT);
		for (let i = 0; i < 2; i++) await deliver(triage, draft(E0502));
		await sent(t, 1);
		await deliver(triage, draft(E0502));
		await vi.waitFor(() => expect(t.requests).toHaveLength(2));
		const tool = (t.requests[1]?.fork?.body["messages"] as { content: string }[] | undefined)?.at(-1);
		expect(tool?.content).toContain("[exo triage: this has now failed 3 times");
	});

	it("asks with the isolated prompt when the fork is not of this call, or its reply cannot be used", async () => {
		const other = forked(fork("c7"), () => HINT);
		await deliver(other.triage, draft(E0502));
		await deliver(other.triage, draft(E0502));
		await sent(other.t, 1);
		expect(other.t.requests.map((r) => r.fork !== undefined)).toEqual([false]);

		const chatty = forked(fork("c1"), (r) => (r.fork ? "Sure, I will run cargo build again." : HINT));
		await deliver(chatty.triage, draft(E0502));
		await deliver(chatty.triage, draft(E0502));
		await sent(chatty.t, 1);
		expect(chatty.t.requests.map((r) => r.fork !== undefined)).toEqual([true, true, false]);
	});
});

describe("T1: a failure that was fixed is forgotten", () => {
	it("starts over when the command passes, so a regression is a first failure again", async () => {
		const { triage } = setup({ sidecar: false });
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502));
		triage.onToolResult?.(edited("lib.rs"));
		expect(await deliver(triage, passed())).toBeUndefined();
		for (let i = 0; i < 40; i++) await deliver(triage, passed(`ls ${i}`, "x"));
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502));
		const third = await deliver(triage, draft(E0502));
		expect(third?.note).toBe("repeat 3");
		// The edit made before the pass is not one this failure outlived.
		expect(third?.text).not.toContain("did not change it");
	});

	it("takes a pass of the same run behind a pipe, and no other command's pass", async () => {
		const failing = "test parse ... FAILED\nerror: test failed, to rerun pass `--lib`";
		const run = (command: string, output: string, ok: boolean) =>
			draft(output, { input: { command }, isError: !ok, exitCode: ok ? 0 : 101 });
		const { triage } = setup({ sidecar: false, loopThreshold: 2 });
		await deliver(triage, run("cargo test", failing, false));
		await deliver(triage, run("cargo fmt", "", true));
		expect((await deliver(triage, run("cargo test", failing, false)))?.note).toBe("repeat 2");
		await deliver(triage, run("cargo test 2>&1 | tail -5", "test result: ok. 4 passed", true));
		expect(await deliver(triage, run("cargo test", failing, false))).toBeUndefined();
	});

	it("forgets every test command's failures when any test run passes (D-108)", async () => {
		const failing = "FAILED tests/test_a.py::test_x - assert 1 == 2\n=== 1 failed in 0.1s ===";
		const run = (command: string, output: string, ok: boolean) =>
			draft(output, { input: { command }, isError: !ok, exitCode: ok ? 0 : 1 });
		const { triage } = setup({ sidecar: false, loopThreshold: 2 });
		await deliver(triage, run("pytest tests/ 2>&1 | tail -20", failing, false));
		await deliver(triage, run("python -m pytest -q", "1 passed in 0.1s", true));
		// Not "the same errors as before": what failed before passed since.
		expect(await deliver(triage, run("pytest tests/", failing, false))).toBeUndefined();
		// A build passing forgets only its own failures.
		await deliver(triage, run("pytest tests/", failing, false));
		await deliver(triage, run("make", "", true));
		expect((await deliver(triage, run("pytest tests/", failing, false)))?.note).toBe("repeat 3");
	});

	it("keeps the failures on a narrowed pass of other tests, or a pass that ran no test (D-108 amendment)", async () => {
		const failing = "FAILED tests/test_a.py::test_x - assert 1 == 2\n=== 1 failed in 0.1s ===";
		const run = (command: string, output: string, ok: boolean) =>
			draft(output, { input: { command }, isError: !ok, exitCode: ok ? 0 : 1 });
		const { triage } = setup({ sidecar: false, loopThreshold: 2 });
		await deliver(triage, run("pytest tests/", failing, false));
		await deliver(triage, run("pytest tests/test_b.py::test_y", "1 passed in 0.1s", true));
		await deliver(triage, run("python -m pytest -k nothing_here", "1 passed in 0.1s", true));
		await deliver(
			triage,
			run("cargo test nomatch", "running 0 tests\ntest result: ok. 0 passed; 0 failed; 5 filtered out", true),
		);
		await deliver(triage, run("go test -run TestNone ./...", "ok  \tpkg\t0.01s [no tests to run]", true));
		expect((await deliver(triage, run("pytest tests/", failing, false)))?.note).toBe("repeat 2");
		// A narrowed pass that names the failing test fixes it.
		await deliver(triage, run("pytest tests/test_a.py::test_x", "1 passed in 0.1s", true));
		expect(await deliver(triage, run("pytest tests/", failing, false))).toBeUndefined();
	});

	it("gives a new hint allowance and forgets the old hints after a pass", async () => {
		const prompts: string[] = [];
		const { triage, t } = setup({ maxHintsPerSignature: 1 }, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502));
		await sent(t, 1);
		await deliver(triage, passed());
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502));
		await sent(t, 2);
		expect(prompts[1]).toContain("Advice already given for this failure:\n(none)");
	});

	it("does not say the edits changed nothing when the failure went away and came back", async () => {
		const prompts: string[] = [];
		const { triage, t } = setup({}, (prompt) => {
			prompts.push(prompt);
			return { ...HINT, next_action: `Try ${prompts.length}.` };
		});
		await deliver(triage, draft(E0502));
		triage.onToolResult?.(edited("lib.rs"));
		// Another failure: the edit did change what the build reports.
		expect(await deliver(triage, draft(E0308))).toBeUndefined();
		triage.onToolResult?.(edited("other.rs"));
		expect(await deliver(triage, draft(E0502))).toBeUndefined();
		await sent(t, 1);
		expect(prompts[0]).toContain("but not in a row");
		expect(prompts[0]).not.toContain("did not change them");
		expect(prompts[0]).toContain("Edits made since this failure was last seen");

		// From here it stands: only what was edited since it came back is said to have changed nothing.
		triage.onToolResult?.(edited("third.rs"));
		const standing = await deliver(triage, draft(E0502));
		expect(standing?.text).toContain("with the same errors as before");
		expect(standing?.text).toContain("The edits made since (third.rs) did not change it.");
		await vi.waitFor(() => expect(prompts).toHaveLength(2));
		expect(prompts[1]).toContain("did not change them");
	});
});

describe("T2: a failed edit is known by the text it looked for", () => {
	const failedEdit = (oldText: string, newText = "x") =>
		draft("Could not find the exact text in lib.rs. The old text must match exactly.", {
			toolName: "edit",
			input: { path: "lib.rs", edits: [{ oldText, newText }] },
			exitCode: null,
		});

	it("does not call an edit with other text a repeat", async () => {
		const { triage } = setup({ sidecar: false });
		expect(await deliver(triage, failedEdit("fn main() {"))).toBeUndefined();
		expect(await deliver(triage, failedEdit("fn main()  {"))).toBeUndefined();
		expect(await deliver(triage, failedEdit("fn  main() {"))).toBeUndefined();
		expect(triage.status?.()).toBe("triage");
	});

	it("still calls the same text a repeat, whatever it was to be replaced with", async () => {
		const { triage } = setup({ sidecar: false, loopThreshold: 2 });
		await deliver(triage, failedEdit("fn main() {", "a"));
		expect((await deliver(triage, failedEdit("fn main() {", "b")))?.note).toBe("repeat 2");
	});
});

describe("T3: a message from the user does not start a new task", () => {
	it("keeps counting, and shows the sidecar the request and the follow-up", async () => {
		const prompts: string[] = [];
		const { triage, t } = setup({}, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		triage.onUserTurn?.({ text: "implement the forth interpreter", origin: "user" });
		await deliver(triage, draft(E0502));
		triage.onUserTurn?.({ text: "try again", origin: "user" });
		await deliver(triage, draft(E0502));
		await sent(t, 1);
		expect(prompts[0]).toContain("[1] implement the forth interpreter");
		expect(prompts[0]).toContain("[2] try again");
	});

	it("keeps the latest messages within the limit, the newest whole when it fits", async () => {
		const prompts: string[] = [];
		const { triage, t } = setup({}, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		triage.onUserTurn?.({ text: `first ${"a".repeat(9_000)} end-of-first`, origin: "user" });
		for (let i = 0; i < 8; i++) triage.onUserTurn?.({ text: `follow-up ${i}`, origin: "user" });
		triage.onUserTurn?.({ text: "ignored", origin: "suggestion" });
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502));
		await sent(t, 1);
		const goal = /<<<\n([\s\S]*?)\n>>>/.exec(prompts[0] ?? "")?.[1] ?? "";
		expect(goal.length).toBeLessThan(6_200);
		expect(goal).toContain("follow-up 7");
		expect(goal).toContain("follow-up 2");
		expect(goal).not.toContain("follow-up 1");
		expect(goal).not.toContain("ignored");
	});

	it("asks for a hand-over again only after more failures since the user spoke", async () => {
		const { triage } = setup({ sidecar: false });
		const texts: string[] = [];
		const run = async () => texts.push((await deliver(triage, draft(E0502)))?.text ?? "");
		for (let i = 0; i < 6; i++) await run();
		expect(texts[5]).toContain("tell the user what you tried");
		triage.onUserTurn?.({ text: "try the other approach", origin: "user" });
		await run();
		await run();
		expect(texts[6]).toContain("this has now failed 7 times");
		expect(texts[6]).not.toContain("tell the user");
		expect(texts[7]).not.toContain("tell the user");
		await run();
		expect(texts[8]).toContain("this has now failed 9 times");
		expect(texts[8]).toContain("tell the user what you tried");
	});
});

describe("T4: after a compaction", () => {
	it("forgets the hints it gave and its hint allowance, and keeps the counts", async () => {
		const prompts: string[] = [];
		const { triage, t } = setup({ maxHintsPerSignature: 1 }, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502));
		await sent(t, 1);
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 3");
		await pause();
		expect(prompts).toHaveLength(1);
		triage.onCompacted?.();
		// The same hint again: the first is no longer in the context.
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 4");
		await sent(t, 2);
		expect(prompts[1]).toContain("Advice already given for this failure:\n(none)");
	});

	it("repeats a loop notice that is no longer in the context", async () => {
		const loop = setup().triage;
		const read = draft("x", { toolName: "read", input: { path: "a.rs" }, isError: false, exitCode: null });
		const same = () => deliver(loop, read);
		await same();
		await same();
		expect((await same())?.note).toBe("no progress ×3");
		expect(await same()).toBeUndefined();
		loop.onCompacted?.();
		expect((await same())?.note).toBe("no progress ×5");
	});
});

describe("T5: a diagnosis never holds the agent, and is stopped only when it can no longer help (D-108)", () => {
	it("is kept through a rerun that fails again, which starts no second one", async () => {
		const engine = gated();
		const { triage, t } = setup({}, engine.reply);
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502));
		await vi.waitFor(() => expect(engine.waiting).toHaveLength(1));
		// The same command again, failing the same way and then another way: the diagnosis goes on.
		await deliver(triage, draft(E0502, { toolCallId: "c3" }));
		await deliver(triage, draft(E0308, { toolCallId: "c4" }));
		engine.release();
		await sent(t, 1);
		expect(t.requests).toHaveLength(1);
		expect(t.late[0]).toContain("(the same errors 2 times)");
	});

	it("is stopped when the command passes, the user speaks or the context is compacted", async () => {
		for (const stop of [
			(triage: Triage) => deliver(triage, passed()),
			async (triage: Triage) => triage.onUserTurn?.({ text: "stop", origin: "user" }),
			async (triage: Triage) => triage.onCompacted?.(),
		]) {
			const engine = gated();
			const { triage, t } = setup({}, engine.reply);
			await deliver(triage, draft(E0502));
			await deliver(triage, draft(E0502));
			await vi.waitFor(() => expect(t.requests).toHaveLength(1));
			await stop(triage);
			engine.release();
			await pause();
			expect(t.late).toEqual([]);
		}
	});

	it("stops the diagnosis of every test command when a test run passes", async () => {
		const engine = gated();
		const { triage, t } = setup({}, engine.reply);
		const failing = (command: string) =>
			draft("FAILED tests/t.py::test_x - assert 1 == 2", { input: { command }, exitCode: 1 });
		await deliver(triage, failing("pytest tests/"));
		await deliver(triage, failing("pytest tests/"));
		await vi.waitFor(() => expect(t.requests).toHaveLength(1));
		await deliver(triage, passed("python -m pytest -x", "3 passed in 0.2s"));
		engine.release();
		await pause();
		expect(t.late).toEqual([]);
	});

	it("keeps a diagnosis through a narrowed pass of other tests", async () => {
		const engine = gated();
		const { triage, t } = setup({}, engine.reply);
		const failing = draft("FAILED tests/t.py::test_x - assert 1 == 2", { input: { command: "pytest" }, exitCode: 1 });
		await deliver(triage, failing);
		await deliver(triage, failing);
		await vi.waitFor(() => expect(t.requests).toHaveLength(1));
		await deliver(triage, passed("pytest tests/t.py::test_other", "1 passed in 0.1s"));
		engine.release();
		await sent(t, 1);
	});

	it("starts no diagnosis when the host gave up on the result while the fork was taken", async () => {
		const t = createTestModuleContext({ cwd: dir, reply: () => HINT });
		const host = new AbortController();
		const context = {
			...t.context,
			forkPrefix: async () => {
				host.abort();
				return undefined;
			},
		};
		const triage = createTriage({}, context);
		await deliver(triage, draft(E0502));
		triage.onToolResult?.(draft(E0502));
		await triage.rewriteToolResult?.(draft(E0502), host.signal);
		await pause();
		expect(t.requests).toEqual([]);
	});

	it("gives back the allowance when the idle agent cannot take the hint", async () => {
		let calls = 0;
		const { triage, t } = setup({ maxHintsPerSignature: 1 }, () => {
			calls += 1;
			return { ...HINT, next_action: `Try ${calls}.` };
		});
		t.idle = true;
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502));
		await vi.waitFor(() => expect(calls).toBe(1));
		await pause();
		t.idle = false;
		await deliver(triage, draft(E0502));
		await sent(t, 1);
		expect(calls).toBe(2);
		expect(triage.status?.()).toBe("triage (2 repeats, 1 hints)");
	});

	it("counts a failure whose rewrite the host never asked for", async () => {
		const { triage } = setup({ sidecar: false, loopThreshold: 2 });
		triage.onToolResult?.(draft(E0502));
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 2");
	});

	it("gives a loop notice again when the first one was dropped", async () => {
		const { triage } = setup();
		const same = draft("x", { toolName: "read", input: { path: "a.rs" }, isError: false, exitCode: null });
		await deliver(triage, same);
		await deliver(triage, same);
		expect((await offer(triage, same))?.note).toBe("no progress ×3");
		expect(triage.status?.()).toBe("triage");
		expect((await deliver(triage, same))?.note).toBe("no progress ×4");
		expect(await deliver(triage, same)).toBeUndefined();
		expect(triage.status?.()).toBe("triage (0 repeats, 0 hints, 1 loops)");
	});
});

describe("T6: counts outlive the instance", () => {
	it("picks up the counts, the hints and the hint allowance after a reload", async () => {
		const prompts: string[] = [];
		const reply = (prompt: string) => {
			prompts.push(prompt);
			return HINT;
		};
		const first = setup({}, reply);
		await deliver(first.triage, draft(E0502));
		await deliver(first.triage, draft(E0502));
		await sent(first.t, 1);
		expect(first.t.states.length).toBeGreaterThan(0);

		const second = setup({}, reply, first.t.states.at(-1));
		const third = await deliver(second.triage, draft(E0502));
		expect(third?.text).toContain("this has now failed 3 times with the same errors as before");
		await vi.waitFor(() => expect(prompts).toHaveLength(2));
		expect(prompts[1]).toContain("Advice already given for this failure:\n- The borrow of");
		await pause();
		expect(await deliver(second.triage, passed())).toBeUndefined();

		const afterPass = setup({ sidecar: false }, undefined, second.t.states.at(-1));
		expect(await deliver(afterPass.triage, draft(E0502))).toBeUndefined();
	});

	it("picks up a stretch that is not converging", async () => {
		const run = (value: number) =>
			draft(`FAILED tests/t.py::test_x - assert ${value} == 2`, { input: { command: "pytest" }, exitCode: 1 });
		const first = setup({ sidecar: false });
		for (let i = 1; i <= 3; i++) await deliver(first.triage, run(i));
		const second = setup({ sidecar: false }, undefined, first.t.states.at(-1));
		expect((await deliver(second.triage, run(4)))?.note).toBe("not converging ×4");
	});

	it("saves only when what it keeps changed", async () => {
		const { triage, t } = setup({ sidecar: false });
		for (let i = 0; i < 5; i++) await deliver(triage, passed(`ls ${i}`, "x"));
		triage.onUserTurn?.({ text: "hello", origin: "user" });
		expect(t.states).toEqual([]);
		await deliver(triage, draft(E0502));
		expect(t.states).toHaveLength(1);
		await deliver(triage, passed("ls", "x"));
		expect(t.states).toHaveLength(1);
	});

	it("ignores saved state it cannot read, an older version's included", async () => {
		for (const saved of [
			"garbage",
			{ v: 99 },
			{ v: 1, edited: 0, failures: [], last: [] },
			{ v: 2, edited: "x", failures: [{ id: 3 }], last: [], stretches: [] },
			null,
		]) {
			const { triage } = setup({ sidecar: false, loopThreshold: 2 }, undefined, saved as JsonValue);
			expect(await deliver(triage, draft(E0502))).toBeUndefined();
			expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 2");
		}
	});

	it("keeps a bounded number of failures", async () => {
		const { triage, t } = setup({ sidecar: false, loopThreshold: 2 });
		for (let i = 0; i < 100; i++) await deliver(triage, draft(`error: thing_${i} is undefined`));
		const saved = t.states.at(-1) as { failures: unknown[] };
		expect(saved.failures.length).toBeLessThanOrEqual(64);
		// The oldest was dropped; a recent one is still known.
		expect(await deliver(triage, draft("error: thing_0 is undefined"))).toBeUndefined();
		expect((await deliver(triage, draft("error: thing_99 is undefined")))?.note).toBe("repeat 2");
	});
});
