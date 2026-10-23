import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultDraft } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSettings } from "../src/settings.ts";
import { createTriage } from "../src/triage.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-triage-"));
	writeFileSync(join(dir, "lib.rs"), "fn main() {}\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const RUST_ERROR =
	"   Compiling forth\nerror[E0502]: cannot borrow `self.stack` as mutable\n  --> src/lib.rs:42:9\nerror: could not compile";
const HINT = {
	diagnosis: "The borrow of `self.stack` outlives the push in lib.rs.",
	next_action: "Clone the value first.",
};

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

function setup(
	settings: Record<string, unknown> = {},
	reply?: (prompt: string) => SidecarReply | Promise<SidecarReply>,
) {
	const t = createTestModuleContext({
		cwd: dir,
		...(reply ? { reply: (request) => reply(String(request.messages[0]?.["content"])) } : {}),
	});
	return { t, triage: createTriage(settings, t.context) };
}

/** One tool result as the host delivers it, its rewrite used. */
async function fail(triage: ReturnType<typeof createTriage>, d: ToolResultDraft) {
	triage.onToolResult?.(d);
	const rewrite = await triage.rewriteToolResult?.(d, signal);
	rewrite?.commit?.();
	return rewrite;
}

/** Waits for the late help sent so far to number `n`. */
const sent = (t: { late: string[] }, n: number) => vi.waitFor(() => expect(t.late).toHaveLength(n));
const logged = (t: { logs: string[] }, start: string) =>
	vi.waitFor(() => expect(t.logs.some((l) => l.startsWith(start))).toBe(true));

describe("triage", () => {
	it("says nothing on a first failure or a success, and asks no sidecar", async () => {
		const { triage, t } = setup({}, () => HINT);
		expect(await fail(triage, draft("ok", { isError: false, exitCode: 0 }))).toBeUndefined();
		const noisy = `${Array.from({ length: 30 }, (_, i) => `note ${i}`).join("\n")}\n${RUST_ERROR}`;
		expect(await fail(triage, draft(noisy))).toBeUndefined();
		expect(t.requests).toEqual([]);
	});

	it("on the second sighting, adds nothing to the result and sends a diagnosis as late help (D-108)", async () => {
		const prompts: string[] = [];
		const { triage, t } = setup({}, (prompt) => {
			prompts.push(prompt);
			return HINT;
		});
		triage.onUserTurn?.({ text: "implement forth", origin: "user" });
		await fail(triage, draft(RUST_ERROR));
		expect(await fail(triage, draft(RUST_ERROR.replace("42:9", "57:3")))).toBeUndefined();
		await sent(t, 1);
		expect(t.late[0]).toBe(
			"[exo triage hint on `cargo build` (the same errors 2 times): The borrow of `self.stack` outlives the push in lib.rs. Clone the value first.]",
		);
		expect(prompts[0]).toContain("implement forth");
		expect(prompts[0]).toContain("- cargo build → exit 101");
		expect(prompts[0]).toContain("the same errors 2 times");
		expect(t.records).toContainEqual({
			kind: "exo.action",
			data: { action: "hint", toolCallId: "c1", reason: "the same errors 2 times" },
		});
		expect(t.progress).toEqual([]);
		expect(triage.status?.()).toBe("triage (1 repeats, 1 hints)");
	});

	it("never holds the result for the diagnosis, and a rerun waits for the one running", async () => {
		const { triage, t } = setup({}, () => new Promise<SidecarReply>(() => undefined));
		await fail(triage, draft(RUST_ERROR));
		await fail(triage, draft(RUST_ERROR));
		const started = Date.now();
		const third = await fail(triage, draft(RUST_ERROR));
		expect(Date.now() - started).toBeLessThan(500);
		expect(third?.note).toBe("repeat 3");
		expect(t.requests).toHaveLength(1);
		await triage.dispose?.();
	});

	it("warns at the loop threshold and asks for a hand-over at twice it", async () => {
		const { triage } = setup({ sidecar: false });
		const texts: string[] = [];
		for (let i = 0; i < 6; i++) texts.push((await fail(triage, draft(RUST_ERROR)))?.text ?? "");
		expect(texts[1]).toBe("");
		expect(texts[2]).toContain(
			"[exo triage: this has now failed 3 times with the same errors as before (first: error[E0502]: cannot borrow `self.stack` as mutable).",
		);
		expect(texts[2]).toContain("stop retrying it");
		expect(texts[4]).toContain("this has now failed 5 times");
		expect(texts[5]).toContain(
			"this has now failed 6 times with the same errors as before (first: error[E0502]: cannot borrow `self.stack` as mutable). Stop repeating it. If you cannot find a different approach, stop and tell the user what you tried and what is blocking you.]",
		);
	});

	it("shows the second diagnosis what the first said, and drops a hint that only repeats it", async () => {
		const prompts: string[] = [];
		const { triage, t } = setup({}, (prompt) => {
			prompts.push(prompt);
			return { ...HINT, next_action: prompts.length === 1 ? HINT.next_action : "Clone the value first, please." };
		});
		await fail(triage, draft(RUST_ERROR));
		await fail(triage, draft(RUST_ERROR));
		await sent(t, 1);
		await fail(triage, draft(RUST_ERROR));
		await logged(t, "dropped a hint that repeats");
		expect(prompts[0]).toContain("Advice already given for this failure:\n(none)");
		expect(prompts[1]).toContain(
			"Advice already given for this failure:\n- The borrow of `self.stack` outlives the push in lib.rs. Clone the value first.",
		);
		expect(t.late).toHaveLength(1);
		// The dropped hint was an answer: it counts toward the cap.
		await fail(triage, draft(RUST_ERROR));
		expect(prompts).toHaveLength(2);
	});

	it("gives back the allowance of a call that ended without an answer (D-108)", async () => {
		let calls = 0;
		const { triage, t } = setup({ maxHintsPerSignature: 1 }, () => {
			calls += 1;
			return calls === 1 ? new Error("down") : HINT;
		});
		await fail(triage, draft(RUST_ERROR));
		await fail(triage, draft(RUST_ERROR));
		await logged(t, "diagnosis error");
		await fail(triage, draft(RUST_ERROR));
		await sent(t, 1);
		expect(calls).toBe(2);
	});

	it("drops a hint over a name found nowhere and says which; a name in the workspace's code is fine (D-108)", async () => {
		writeFileSync(join(dir, "stack.rs"), "fn parser_state() {}\n");
		// Untracked files are searched too.
		execFileSync("git", ["init", "-q"], { cwd: dir });
		const replies = [
			{ diagnosis: "The bug is in `lexer_state` of src/parser.rs.", next_action: "Fix it." },
			{ diagnosis: "`parser_state` in stack.rs resets the stack.", next_action: "Keep it." },
		];
		let asked = 0;
		const { triage, t } = setup({}, () => replies[asked++] ?? {});
		await fail(triage, draft(RUST_ERROR));
		await fail(triage, draft(RUST_ERROR));
		await logged(t, "dropped a hint naming");
		expect(t.logs.find((l) => l.startsWith("dropped a hint naming"))).toContain("`lexer_state`, `src/parser.rs`");
		await fail(triage, draft(RUST_ERROR));
		await sent(t, 1);
		expect(t.late[0]).toContain("`parser_state` in stack.rs resets the stack.");
	});

	it("says nothing more when the sidecar is off, has no engine, or answers nothing", async () => {
		for (const [settings, reply] of [
			[{ sidecar: false }, HINT],
			[{}, { diagnosis: "", next_action: "" }],
		] as const) {
			const { triage, t } = setup(settings, () => reply);
			await fail(triage, draft(RUST_ERROR));
			expect(await fail(triage, draft(RUST_ERROR))).toBeUndefined();
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(t.late).toEqual([]);
		}
		const { triage } = setup();
		await fail(triage, draft(RUST_ERROR));
		expect(await fail(triage, draft(RUST_ERROR))).toBeUndefined();
	});

	it("treats a different error, fewer failing tests or another message as a new failure (D-073)", async () => {
		const { triage, t } = setup({}, () => HINT);
		await fail(triage, draft(RUST_ERROR));
		expect(await fail(triage, draft("error[E0308]: mismatched types"))).toBeUndefined();
		const run = (failing: readonly string[]) =>
			draft(
				[
					...failing.map((name) => `test ${name} ... FAILED`),
					"thread 'a' (4242) panicked at src/lib.rs:9:5:\n  left: 1",
					"error: test failed, to rerun pass `--lib`",
				].join("\n"),
				{ input: { command: "cargo test" } },
			);
		await fail(triage, run(["a", "b", "c"]));
		await fail(triage, run(["a", "b"]));
		await fail(triage, run(["a"]));
		expect(t.requests).toEqual([]);
		expect(triage.status?.()).toBe("triage");
	});

	it("ignores line numbers, run times, thread ids and sanitizer pids when comparing failures", async () => {
		const { triage } = setup({ sidecar: false, loopThreshold: 2 });
		const go = (line: number, id: number, time: string) =>
			draft(
				`--- FAIL: TestSteps (${time}s)\nthread 'a' (${id}) panicked at src/lib.rs:${line}:5:\nFAIL\tpkg\t${time}s`,
			);
		await fail(triage, go(9, 100, "0.01"));
		expect((await fail(triage, go(14, 2077, "0.32")))?.note).toBe("repeat 2");
		const asan = (pid: number) =>
			draft(
				`./build/t\n==${pid}==ERROR: AddressSanitizer: heap-use-after-free on address 0x60200000eff0\nSUMMARY: AddressSanitizer: heap-use-after-free src/manifest.cpp:52 in parse\nmake: *** [Makefile:24: test] Error 1`,
				{ input: { command: "make test" }, exitCode: 2 },
			);
		await fail(triage, asan(4242));
		expect((await fail(triage, asan(77)))?.note).toBe("repeat 2");
	});

	it("does not take two failures under `make` for one because make's own line is the same (D-108)", async () => {
		const { triage } = setup({ sidecar: false, loopThreshold: 2 });
		const make = (body: string) =>
			draft(`./build/test_graph\n${body}\nmake: *** [Makefile:24: test] Error 1`, {
				input: { command: "make test" },
				exitCode: 2,
			});
		await fail(triage, make("check failed: order mismatch, expected a,b got b,a"));
		const crash = make(
			"==1==ERROR: AddressSanitizer: heap-use-after-free on address 0x1\nSUMMARY: AddressSanitizer: heap-use-after-free src/x.cpp:52 in f",
		);
		expect(await fail(triage, crash)).toBeUndefined();
	});

	it("names the edited files a failure outlived, and shows the isolated diagnosis the edits, the code and the output", async () => {
		writeFileSync(
			join(dir, "calc.py"),
			["def add(a, b):", "    return a - b", "", "def sub(a, b):", "    return a - b"].join("\n"),
		);
		const prompts: string[] = [];
		const { triage, t } = setup({}, (prompt) => {
			prompts.push(prompt);
			return { diagnosis: "`add` subtracts in calc.py.", next_action: "Change line 2 of calc.py to add." };
		});
		const failure = draft(
			'FAIL: test_add (tests.test_calc.CalcTest.test_add)\nTraceback (most recent call last):\n  File "/usr/lib/python3/unittest/case.py", line 58, in run\n  File "calc.py", line 2, in add\nAssertionError: -1 != 3',
			{ input: { command: "python3 -m unittest" }, exitCode: 1 },
		);
		await fail(triage, failure);
		triage.onToolResult?.({
			toolName: "edit",
			input: { path: "calc.py", edits: [{ oldText: "def sub(a, b):", newText: "def sub(a: int, b: int):" }] },
			isError: false,
			exitCode: null,
			output: "ok",
		});
		await fail(triage, failure);
		await sent(t, 1);
		const third = await fail(triage, failure);
		expect(third?.text).toContain("The edits made since (calc.py) did not change it.");
		expect(prompts[0]).toContain("calc.py\n- def sub(a, b):\n+ def sub(a: int, b: int):");
		expect(prompts[0]).toContain("calc.py (lines 1-5):\n     1 | def add(a, b):\n>    2 |     return a - b");
		expect(prompts[0]).not.toContain("case.py (line");
		expect(prompts[0]).toContain('File "/usr/lib/python3/unittest/case.py", line 58, in run');
	});

	it("counts a test run that failed behind a pipe, and says whose exit code was shown", async () => {
		const piped = (output: string) =>
			draft(output, { input: { command: "cargo test 2>&1 | tail -5" }, isError: false, exitCode: 0 });
		const failing = "test parse ... FAILED\nerror: test failed, to rerun pass `--lib`";
		const { triage } = setup({ sidecar: false });
		expect(await fail(triage, piped("test result: ok. 4 passed"))).toBeUndefined();
		await fail(triage, piped(failing));
		await fail(triage, piped(failing));
		const third = await fail(triage, piped(failing));
		expect(third?.text).toContain(
			"this has now failed 3 times with the same errors as before (first: test parse ... FAILED)",
		);
		expect(third?.text).toContain("The exit code shown is the pipe's last command's, not this run's.");

		const off = setup({ sidecar: false, maskedFailures: false }).triage;
		for (let i = 0; i < 2; i++) expect(await fail(off, piped(failing))).toBeUndefined();
	});

	it("skips benign exit codes (no grep match) and counts failures with no error line", async () => {
		const { triage } = setup({ sidecar: false });
		const grep = draft("", { input: { command: "cd src && grep -rn foo ." }, exitCode: 1 });
		for (let i = 0; i < 2; i++) expect(await fail(triage, grep)).toBeUndefined();
		const silent = draft("nothing useful", { input: { command: "./run.sh" }, exitCode: 3, isError: false });
		await fail(triage, silent);
		await fail(triage, silent);
		expect((await fail(triage, silent))?.text).toContain("this has now failed 3 times the same way as before");
	});

	describe("a run that is not converging (D-108)", () => {
		const pytest = (failing: readonly string[], value: number, command = "pytest -q") =>
			draft(
				[
					...failing.map((name) => `FAILED tests/test_meal.py::${name} - assert ${value} == 4`),
					`=== ${failing.length} failed, 9 passed in 0.${value}s ===`,
				].join("\n"),
				{ input: { command }, exitCode: 1 },
			);

		it("says so once when the same tests keep failing with other messages, and asks for a diagnosis", async () => {
			const prompts: string[] = [];
			writeFileSync(join(dir, "meal.py"), "def plan_week(): pass\n");
			const { triage, t } = setup({}, (prompt) => {
				prompts.push(prompt);
				return { diagnosis: "`plan_week` returns nothing.", next_action: "Read the test first." };
			});
			const rewrites: Awaited<ReturnType<typeof fail>>[] = [];
			for (let value = 1; value <= 6; value++)
				rewrites.push(await fail(triage, pytest(["test_total", "test_days"], value)));
			expect(rewrites.map((r) => r?.note)).toEqual([
				undefined,
				undefined,
				undefined,
				"not converging ×4",
				undefined,
				undefined,
			]);
			expect(rewrites[3]?.text).toContain(
				"[exo triage: 4 runs since this last passed, and the same tests still fail (tests/test_meal.py::test_days, tests/test_meal.py::test_total): the messages change but none is fixed. Step back and find the cause before the next edit.]",
			);
			await sent(t, 1);
			expect(t.late[0]).toBe(
				"[exo triage hint on `pytest -q` (4 failing runs, the same tests failing each time): `plan_week` returns nothing. Read the test first.]",
			);
			expect(prompts[0]).toContain("has failed 4 times in a row since it last passed");
			expect(triage.status?.()).toBe("triage (0 repeats, 1 hints, 1 not converging)");
		});

		it("starts over when a test is fixed, and after a pass of any spelling of the tests", async () => {
			const { triage } = setup({ sidecar: false });
			const notes: (string | undefined)[] = [];
			const run = async (d: ToolResultDraft) => notes.push((await fail(triage, d))?.note);
			await run(pytest(["a", "b"], 1));
			await run(pytest(["a", "b"], 2));
			await run(pytest(["a", "b"], 3));
			// `b` is fixed: progress.
			await run(pytest(["a", "c"], 4));
			await run(pytest(["a", "c"], 5));
			await run(pytest(["a", "c"], 6));
			await run(draft("10 passed in 0.5s", { input: { command: "python -m pytest -x" }, isError: false, exitCode: 0 }));
			await run(pytest(["a", "c"], 7));
			await run(pytest(["a", "c"], 8));
			await run(pytest(["a", "c"], 9));
			expect(notes.every((n) => n === undefined)).toBe(true);
			expect((await fail(triage, pytest(["a", "c"], 10)))?.note).toBe("not converging ×4");
		});

		it("sees a test fixed past the first 64 of many (D-108 amendment)", async () => {
			const { triage } = setup({ sidecar: false });
			const names = Array.from({ length: 100 }, (_, i) => `t${String(i).padStart(3, "0")}`);
			const notes: (string | undefined)[] = [];
			for (let run = 0; run < 5; run++) {
				// One more of the last tests fixed each run.
				notes.push((await fail(triage, pytest(names.slice(0, 100 - run), run + 1)))?.note);
			}
			expect(notes.every((n) => n === undefined)).toBe(true);
		});

		it("gives only the repeat notice when both apply", async () => {
			const { triage } = setup({ sidecar: false });
			const notes: (string | undefined)[] = [];
			for (let i = 0; i < 5; i++) notes.push((await fail(triage, pytest(["a"], 1)))?.note);
			expect(notes).toEqual([undefined, undefined, "repeat 3", "repeat 4", "repeat 5"]);
		});

		it("ignores runs that name no test or error site", async () => {
			const { triage } = setup({ sidecar: false });
			for (let i = 0; i < 6; i++) {
				const out = draft(`something went wrong: ${i}`, { input: { command: "make test" }, exitCode: 2 });
				expect(await fail(triage, out)).toBeUndefined();
			}
		});
	});

	describe("loops without an error (D-069)", () => {
		const ok = (command: string, output: string) => draft(output, { input: { command }, isError: false, exitCode: 0 });
		const read = (path: string, output: string) =>
			draft(output, { toolName: "read", input: { path }, isError: false, exitCode: null });

		it("says once that the same call keeps returning the same result, then asks for a hand-over", async () => {
			const { triage, t } = setup({}, () => HINT);
			const results: Awaited<ReturnType<typeof fail>>[] = [];
			for (let i = 0; i < 7; i++) results.push(await fail(triage, read("src/lib.rs", "fn main() {} // same")));
			expect(results.map((r) => r?.note)).toEqual([
				undefined,
				undefined,
				"no progress ×3",
				undefined,
				undefined,
				"no progress ×6",
				undefined,
			]);
			expect(results[2]?.text).toBe(
				"fn main() {} // same\n[exo triage: this exact call has now returned the same result 3 times in a row. Running it again will not change the result: use what it already shows, or do something different.]",
			);
			expect(results[5]?.text).toContain(
				"returned the same result 6 times in a row. Stop repeating it. If you cannot find a different approach, stop and tell the user",
			);
			// Deterministic: no sidecar is asked.
			expect(t.requests).toEqual([]);
			expect(triage.status?.()).toBe("triage (0 repeats, 0 hints, 2 loops)");
		});

		it("ignores run times in the output, but not a result that changed", async () => {
			const { triage } = setup();
			await fail(triage, ok("npm test", "12 passed in 1.2s"));
			await fail(triage, ok("npm test", "12 passed in 0.9s"));
			expect((await fail(triage, ok("npm test", "12 passed in 1.4s")))?.note).toBe("no progress ×3");
			const changing = setup().triage;
			await fail(changing, ok("npm test", "10 passed"));
			await fail(changing, ok("npm test", "11 passed"));
			expect(await fail(changing, ok("npm test", "12 passed"))).toBeUndefined();
		});

		it("names a cycle of calls that keep ending the same way, on a result that is not a failure", async () => {
			const { triage } = setup({ sidecar: false });
			const edit = () =>
				draft("Could not find the exact text in src/lib.rs", {
					toolName: "edit",
					input: { path: "src/lib.rs", oldText: "a", newText: "b" },
					isError: false,
					exitCode: null,
				});
			const notes: (string | undefined)[] = [];
			for (let round = 0; round < 3; round++) {
				notes.push((await fail(triage, edit()))?.note);
				notes.push((await fail(triage, draft(RUST_ERROR)))?.note);
			}
			// The failing build gets the repeated-error notice; the loop is named on the next edit.
			expect(notes).toEqual([undefined, undefined, undefined, undefined, undefined, "repeat 3"]);
			const next = await fail(triage, edit());
			expect(next?.note).toBe("no progress ×3 (cycle of 2)");
			expect(next?.text).toContain(
				"[exo triage: the same 2 calls (cargo build → edit src/lib.rs) have now run 3 times in a row with the same results each time. This loop is not making progress: change the approach before running them again.]",
			);
			expect(await fail(triage, ok("git status", "clean"))).toBeUndefined();
		});

		it("starts over after the loop breaks or the user asks for something new, and can be turned off", async () => {
			const { triage } = setup();
			const same = () => fail(triage, read("a.rs", "x"));
			await same();
			await same();
			expect((await same())?.note).toBe("no progress ×3");
			await fail(triage, read("b.rs", "y"));
			await same();
			await same();
			expect((await same())?.note).toBe("no progress ×3");
			triage.onUserTurn?.({ text: "now do something else", origin: "user" });
			await same();
			expect(await same()).toBeUndefined();

			const off = setup({ loops: false }).triage;
			for (let i = 0; i < 5; i++) expect(await fail(off, read("a.rs", "x"))).toBeUndefined();
		});

		it("speaks only for the latest result when parallel calls finish out of order", async () => {
			const { triage } = setup();
			const a = read("a.rs", "x");
			for (let i = 0; i < 3; i++) triage.onToolResult?.(a);
			triage.onToolResult?.(read("b.rs", "y"));
			expect(await triage.rewriteToolResult?.(a, signal)).toBeUndefined();
		});
	});

	it("reports invalid settings", () => {
		const { t } = setup({ loopThreshold: 1 });
		expect(t.logs.some((l) => l.startsWith("triage /loopThreshold"))).toBe(true);
		expect(parseSettings({}).problems).toEqual([]);
	});
});
