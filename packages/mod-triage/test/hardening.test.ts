import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, ToolOutcome, ToolResultDraft } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../src/settings.ts";
import { createTriage } from "../src/triage.ts";

/** Regression tests for the hardening pass (HARDENING_PLAN section T, D-082). */

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
async function offer(triage: Triage, d: ToolResultDraft, sig: AbortSignal = signal) {
	triage.onToolResult?.(d);
	return triage.rewriteToolResult?.(d, sig);
}

/** One tool result whose rewrite reached the model. */
async function deliver(triage: Triage, d: ToolResultDraft) {
	const rewrite = await offer(triage, d);
	rewrite?.commit?.();
	return rewrite;
}

const never = () => new Promise<SidecarReply>(() => undefined);

describe("T1: a failure that was fixed is forgotten", () => {
	it("starts over when the command passes, so a regression is a first failure again", async () => {
		const { triage } = setup({ sidecar: false });
		await deliver(triage, draft(E0502));
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 2");
		triage.onToolResult?.(edited("lib.rs"));
		expect(await deliver(triage, passed())).toBeUndefined();
		for (let i = 0; i < 40; i++) await deliver(triage, passed(`ls ${i}`, "x"));
		expect(await deliver(triage, draft(E0502))).toBeUndefined();
		const again = await deliver(triage, draft(E0502));
		expect(again?.note).toBe("repeat 2");
		// The edit made before the pass is not one this failure outlived.
		expect(again?.text).not.toContain("did not change it");
	});

	it("takes a pass of the same run behind a pipe, and no other command's pass", async () => {
		const failing = "test parse ... FAILED\nerror: test failed, to rerun pass `--lib`";
		const run = (command: string, output: string, ok: boolean) =>
			draft(output, { input: { command }, isError: !ok, exitCode: ok ? 0 : 101 });
		const { triage } = setup({ sidecar: false });
		await deliver(triage, run("cargo test", failing, false));
		await deliver(triage, run("cargo fmt", "", true));
		expect((await deliver(triage, run("cargo test", failing, false)))?.note).toBe("repeat 2");
		await deliver(triage, run("cargo test 2>&1 | tail -5", "test result: ok. 4 passed", true));
		expect(await deliver(triage, run("cargo test", failing, false))).toBeUndefined();
	});

	it("gives a new hint allowance and forgets the old hints after a pass", async () => {
		const prompts: string[] = [];
		const { triage } = setup({ maxHintsPerSignature: 1 }, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		await deliver(triage, draft(E0502));
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 2 + hint");
		await deliver(triage, passed());
		await deliver(triage, draft(E0502));
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 2 + hint");
		expect(prompts[1]).toContain("Advice already given for this failure:\n(none)");
	});

	it("does not say the edits changed nothing when the failure went away and came back", async () => {
		const prompts: string[] = [];
		const { triage } = setup({}, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		await deliver(triage, draft(E0502));
		triage.onToolResult?.(edited("lib.rs"));
		// Another failure: the edit did change what the build reports.
		expect(await deliver(triage, draft(E0308))).toBeUndefined();
		triage.onToolResult?.(edited("other.rs"));
		const back = await deliver(triage, draft(E0502));
		expect(back?.note).toBe("repeat 2 + hint");
		expect(back?.text).toContain(
			"[exo triage: this failed with the same errors as an earlier run (first: error[E0502]: cannot borrow `self.stack` as mutable), after other results in between; it has now failed this way 2 times.",
		);
		expect(back?.text).not.toContain("did not change it");
		expect(back?.text).not.toContain("as before");
		expect(prompts[0]).toContain("but not in a row");
		expect(prompts[0]).not.toContain("did not change them");
		expect(prompts[0]).toContain("Edits made since this failure was last seen");

		// From here it stands: only what was edited since it came back is said to have changed nothing.
		triage.onToolResult?.(edited("third.rs"));
		const standing = await deliver(triage, draft(E0502));
		expect(standing?.text).toContain("with the same errors as before");
		expect(standing?.text).toContain("The edits made since (third.rs) did not change it.");
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
		const { triage } = setup({ sidecar: false });
		await deliver(triage, failedEdit("fn main() {", "a"));
		expect((await deliver(triage, failedEdit("fn main() {", "b")))?.note).toBe("repeat 2");
	});
});

describe("T3: a message from the user does not start a new task", () => {
	it("keeps counting, and shows the sidecar the request and the follow-up", async () => {
		const prompts: string[] = [];
		const { triage } = setup({}, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		triage.onUserTurn?.({ text: "implement the forth interpreter", origin: "user" });
		await deliver(triage, draft(E0502));
		triage.onUserTurn?.({ text: "try again", origin: "user" });
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 2 + hint");
		expect(prompts[0]).toContain("[1] implement the forth interpreter");
		expect(prompts[0]).toContain("[2] try again");
	});

	it("keeps the latest messages within the limit, the newest whole when it fits", async () => {
		const prompts: string[] = [];
		const { triage } = setup({}, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		triage.onUserTurn?.({ text: `first ${"a".repeat(9_000)} end-of-first`, origin: "user" });
		for (let i = 0; i < 8; i++) triage.onUserTurn?.({ text: `follow-up ${i}`, origin: "user" });
		triage.onUserTurn?.({ text: "ignored", origin: "suggestion" });
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502));
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
		const { triage } = setup({ maxHintsPerSignature: 1 }, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		await deliver(triage, draft(E0502));
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 2 + hint");
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 3");
		expect(triage.onCompacted).toBeTypeOf("function");
		triage.onCompacted?.();
		// The same hint again: the first is no longer in the context.
		const after = await deliver(triage, draft(E0502));
		expect(after?.note).toBe("repeat 4 + hint");
		expect(prompts[1]).toContain("Advice already given for this failure:\n(none)");
	});

	it("offers hypotheses again and repeats a loop notice that is no longer in the context", async () => {
		const answers = [
			{ hypothesis: "The borrow of `self.stack` in lib.rs outlives the push.", check: "Read lib.rs." },
			{ hypothesis: "Cargo builds a stale target.", check: "Run cargo clean." },
		];
		let asked = 0;
		const { triage } = setup({ hypotheses: 2, sidecar: false }, () => answers[asked++ % 2] ?? {});
		for (let i = 0; i < 2; i++) await deliver(triage, draft(E0502));
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 3 + 2 hypotheses");
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 4");
		triage.onCompacted?.();
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 5 + 2 hypotheses");

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

describe("T5: the notice does not wait on the sidecar, and state follows what was used", () => {
	it("refuses timeouts longer than its share of the host's time for a rewrite", () => {
		expect(parseSettings({ hintTimeoutMs: 6_000, hypothesisTimeoutMs: 6_000 }).problems).toEqual([]);
		expect(parseSettings({ hintTimeoutMs: 20_000 }).problems.join()).toContain("/hintTimeoutMs");
		expect(parseSettings({ hypothesisTimeoutMs: 20_000 }).problems.join()).toContain("/hypothesisTimeoutMs");
		const { settings } = parseSettings({});
		expect(Math.max(settings.hintTimeoutMs, settings.hypothesisTimeoutMs)).toBeLessThanOrEqual(6_000);
	});

	it("skips the diagnosis when the hypotheses used the time, and still gives the notice", async () => {
		const { triage, t } = setup({ hypotheses: 2, hypothesisTimeoutMs: 500, hintTimeoutMs: 500 }, never);
		await deliver(triage, draft(E0502));
		await deliver(triage, draft(E0502, { toolCallId: "c2" }));
		const asked = t.requests.length;
		const started = Date.now();
		const third = await deliver(triage, draft(E0502));
		expect(third?.note).toBe("repeat 3");
		expect(third?.text).toContain("this has now failed 3 times");
		expect(t.requests.length - asked).toBe(2);
		expect(Date.now() - started).toBeLessThan(900);
	});

	it("gives the notice at its own deadline however long the sidecar call is held", async () => {
		const { triage } = setup({ hintTimeoutMs: 500 }, never);
		await deliver(triage, draft(E0502));
		const started = Date.now();
		const second = await deliver(triage, draft(E0502));
		expect(second?.note).toBe("repeat 2");
		expect(Date.now() - started).toBeLessThan(900);
	});

	it("returns the notice at once when the host aborts", async () => {
		const { triage } = setup({}, never);
		await deliver(triage, draft(E0502));
		const host = new AbortController();
		setTimeout(() => host.abort(), 30);
		const started = Date.now();
		expect((await offer(triage, draft(E0502), host.signal))?.note).toBe("repeat 2");
		expect(Date.now() - started).toBeLessThan(400);
	});

	it("counts a failure whose rewrite the host never asked for", async () => {
		const { triage } = setup({ sidecar: false });
		triage.onToolResult?.(draft(E0502));
		expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 2");
	});

	it("does not remember a hint the model never saw", async () => {
		const prompts: string[] = [];
		const { triage } = setup({}, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		await deliver(triage, draft(E0502));
		// Dropped by the host: over budget, or the user interrupted.
		expect((await offer(triage, draft(E0502)))?.note).toBe("repeat 2 + hint");
		expect(triage.status?.()).toBe("triage (1 repeats, 0 hints)");
		const third = await deliver(triage, draft(E0502));
		expect(prompts[1]).toContain("Advice already given for this failure:\n(none)");
		expect(third?.note).toBe("repeat 3 + hint");
		expect(triage.status?.()).toBe("triage (2 repeats, 1 hints)");
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
		expect((await deliver(first.triage, draft(E0502)))?.note).toBe("repeat 2 + hint");
		expect(first.t.states.length).toBeGreaterThan(0);

		const second = setup({}, reply, first.t.states.at(-1));
		const third = await deliver(second.triage, draft(E0502));
		// The same hint again is dropped, as it would have been without the reload.
		expect(third?.note).toBe("repeat 3");
		expect(third?.text).toContain("this has now failed 3 times with the same errors as before");
		expect(prompts[1]).toContain("Advice already given for this failure:\n- The borrow of");
		expect(await deliver(second.triage, passed())).toBeUndefined();

		const afterPass = setup({ sidecar: false }, undefined, second.t.states.at(-1));
		expect(await deliver(afterPass.triage, draft(E0502))).toBeUndefined();
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

	it("ignores saved state it cannot read", async () => {
		for (const saved of ["garbage", { v: 99 }, { v: 1, edited: "x", failures: [{ id: 3 }], last: [] }, null]) {
			const { triage } = setup({ sidecar: false }, undefined, saved as JsonValue);
			expect(await deliver(triage, draft(E0502))).toBeUndefined();
			expect((await deliver(triage, draft(E0502)))?.note).toBe("repeat 2");
		}
	});

	it("keeps a bounded number of failures", async () => {
		const { triage, t } = setup({ sidecar: false });
		for (let i = 0; i < 100; i++) await deliver(triage, draft(`error: thing_${i} is undefined`));
		const saved = t.states.at(-1) as { failures: unknown[] };
		expect(saved.failures.length).toBeLessThanOrEqual(64);
		// The oldest was dropped; a recent one is still known.
		expect(await deliver(triage, draft("error: thing_0 is undefined"))).toBeUndefined();
		expect((await deliver(triage, draft("error: thing_99 is undefined")))?.note).toBe("repeat 2");
	});
});
