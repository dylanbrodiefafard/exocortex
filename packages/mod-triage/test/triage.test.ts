import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolResultDraft, ungroundedReferences } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../src/settings.ts";
import { createTriage, dedupe, errorExcerpt, isBenign } from "../src/triage.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-triage-"));
	writeFileSync(join(dir, "lib.rs"), "fn main() {}\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const RUST_ERROR =
	"   Compiling forth\nerror[E0502]: cannot borrow `self.stack` as mutable\n  --> src/lib.rs:42:9\nerror: could not compile";

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

function setup(settings: Record<string, unknown> = {}, reply?: (prompt: string) => SidecarReply) {
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

describe("triage", () => {
	it("ignores successes and leaves a first failure alone when its error is near the top", async () => {
		const { triage, t } = setup({}, () => ({ diagnosis: "x", next_action: "y" }));
		expect(await fail(triage, draft("ok", { isError: false, exitCode: 0 }))).toBeUndefined();
		expect(await fail(triage, draft(RUST_ERROR))).toBeUndefined();
		expect(t.requests).toEqual([]);
	});

	it("surfaces a buried first error at the top on the first failure", async () => {
		const { triage } = setup();
		const noisy = `${Array.from({ length: 30 }, (_, i) => `note ${i}`).join("\n")}\n${RUST_ERROR}`;
		const rewrite = await fail(triage, draft(noisy));
		expect(rewrite?.text.split("\n")[0]).toBe(
			"[exo triage: first error (line 32 below): error[E0502]: cannot borrow `self.stack` as mutable]",
		);
		expect(rewrite?.note).toBe("surfaced the first error");
	});

	it("measures burial in the text the model sees, after earlier rewrites", async () => {
		const { triage } = setup();
		const noisy = `${Array.from({ length: 30 }, (_, i) => `note ${i}`).join("\n")}\n${RUST_ERROR}`;
		expect(await fail(triage, draft(noisy, { current: RUST_ERROR }))).toBeUndefined();
	});

	it("on a repeat, appends a runtime notice and a grounded hint", async () => {
		const prompts: string[] = [];
		const { triage } = setup({}, (prompt) => {
			prompts.push(prompt);
			return {
				diagnosis: "The borrow of `self.stack` outlives the push in lib.rs.",
				next_action: "Clone the value before mutating.",
			};
		});
		triage.onUserTurn?.({ text: "implement forth", origin: "user" });
		await fail(triage, draft(RUST_ERROR));
		const second = draft(RUST_ERROR.replace("42:9", "57:3"));
		const rewrite = await fail(triage, second);
		expect(rewrite?.text.startsWith(RUST_ERROR.replace("42:9", "57:3"))).toBe(true);
		expect(rewrite?.text).toContain(
			"[exo triage: this failed again with the same errors as before (first: error[E0502]: cannot borrow `self.stack` as mutable); it has now failed this way 2 times.",
		);
		expect(rewrite?.text).toContain(
			"[exo triage hint: The borrow of `self.stack` outlives the push in lib.rs. Clone the value before mutating.]",
		);
		expect(rewrite?.note).toBe("repeat 2 + hint");
		expect(prompts[0]).toContain("implement forth");
		expect(prompts[0]).toContain("- cargo build → exit 101");
		expect(prompts[0]).toContain("the same errors 2 times");
		expect(triage.status?.()).toBe("triage (1 repeats, 1 hints)");
	});

	it("escalates at the loop threshold and caps hints per signature", async () => {
		let calls = 0;
		const { triage } = setup({ maxHintsPerSignature: 1 }, () => {
			calls += 1;
			return { diagnosis: "Still the borrow.", next_action: "Restructure it." };
		});
		await fail(triage, draft(RUST_ERROR));
		await fail(triage, draft(RUST_ERROR));
		const third = await fail(triage, draft(RUST_ERROR));
		expect(third?.text).toContain("this has now failed 3 times");
		expect(third?.text).toContain("stop retrying it");
		expect(third?.text).not.toContain("hint:");
		expect(calls).toBe(1);
	});

	it("asks for a hand-over to the user once the failure has outlived the loop warning", async () => {
		const { triage } = setup({ sidecar: false });
		const texts: string[] = [];
		for (let i = 0; i < 6; i++) texts.push((await fail(triage, draft(RUST_ERROR)))?.text ?? "");
		expect(texts[4]).toContain("this has now failed 5 times");
		expect(texts[4]).toContain("stop retrying it");
		expect(texts[5]).toContain(
			"this has now failed 6 times with the same errors as before (first: error[E0502]: cannot borrow `self.stack` as mutable). Stop repeating it. If you cannot find a different approach, stop and tell the user what you tried and what is blocking you.]",
		);
	});

	it("shows the second hint what the first one said, and drops it when it only repeats it", async () => {
		const prompts: string[] = [];
		const replies = [
			{ diagnosis: "The borrow of `self.stack` outlives the push.", next_action: "Clone the value before mutating." },
			{
				diagnosis: "The borrow of `self.stack` outlives the push.",
				next_action: "Clone the value before mutating it.",
			},
		];
		const { triage, t } = setup({}, (prompt) => {
			prompts.push(prompt);
			return replies[prompts.length - 1] ?? {};
		});
		await fail(triage, draft(RUST_ERROR));
		expect((await fail(triage, draft(RUST_ERROR)))?.note).toBe("repeat 2 + hint");
		const third = await fail(triage, draft(RUST_ERROR));
		expect(prompts[0]).toContain("Advice already given for this failure:\n(none)");
		expect(prompts[1]).toContain(
			"Advice already given for this failure:\n- The borrow of `self.stack` outlives the push. Clone the value before mutating.",
		);
		expect(third?.note).toBe("repeat 3");
		expect(third?.text).not.toContain("hint:");
		expect(t.logs).toContain("dropped a hint that repeats an earlier one");
		// The dropped call still counts toward the cap: no third sidecar call.
		await fail(triage, draft(RUST_ERROR));
		expect(prompts).toHaveLength(2);
	});

	it("keeps a second hint that says something new, and tells the sidecar which files were edited", async () => {
		const prompts: string[] = [];
		const replies = [
			{ diagnosis: "The borrow of `self.stack` outlives the push.", next_action: "Clone the value before mutating." },
			{ diagnosis: "The iterator still holds `self.stack`.", next_action: "Collect the items into a Vec first." },
		];
		const { triage, t } = setup({}, (prompt) => {
			prompts.push(prompt);
			return replies[prompts.length - 1] ?? {};
		});
		await fail(triage, draft(RUST_ERROR));
		expect(t.progress).toEqual([]);
		await fail(triage, draft(RUST_ERROR));
		triage.onToolResult?.({ toolName: "edit", input: { path: "lib.rs" }, isError: false, exitCode: null, output: "" });
		const third = await fail(triage, draft(RUST_ERROR));
		expect(third?.note).toBe("repeat 3 + hint");
		expect(third?.text).toContain("Collect the items into a Vec first.");
		expect(t.progress).toEqual(["Diagnosing the repeated failure…", "Diagnosing the repeated failure…"]);
		expect(prompts[1]).toContain("- edit lib.rs → ok");
	});

	it("drops hints naming files or symbols absent from the evidence and workspace", async () => {
		const { triage, t } = setup({}, () => ({
			diagnosis: "The bug is in `parser_state` of src/parser.rs.",
			next_action: "Fix it.",
		}));
		await fail(triage, draft(RUST_ERROR));
		const rewrite = await fail(triage, draft(RUST_ERROR));
		expect(rewrite?.text).not.toContain("hint:");
		expect(rewrite?.note).toBe("repeat 2");
		expect(t.logs.some((l) => l.includes("parser_state") && l.includes("src/parser.rs"))).toBe(true);
	});

	it("degrades to the notice when the sidecar fails, is empty, is disabled or has no engine", async () => {
		for (const [settings, reply] of [
			[{}, new Error("down")],
			[{}, { diagnosis: "", next_action: "" }],
			[{ sidecar: false }, { diagnosis: "a", next_action: "b" }],
		] as const) {
			const { triage } = setup(settings, () => reply);
			await fail(triage, draft(RUST_ERROR));
			expect((await fail(triage, draft(RUST_ERROR)))?.note).toBe("repeat 2");
		}
		const { triage } = setup();
		await fail(triage, draft(RUST_ERROR));
		expect((await fail(triage, draft(RUST_ERROR)))?.note).toBe("repeat 2");
	});

	it("goes on counting through a continuation and through a message from the user (D-082)", async () => {
		const { triage } = setup({ sidecar: false });
		await fail(triage, draft(RUST_ERROR));
		triage.onUserTurn?.({ text: "keep going", origin: "extension" });
		expect((await fail(triage, draft(RUST_ERROR)))?.note).toBe("repeat 2");
		triage.onUserTurn?.({ text: "something else", origin: "user" });
		expect((await fail(triage, draft(RUST_ERROR)))?.note).toBe("repeat 3");
	});

	it("treats a different error as a new failure", async () => {
		const { triage } = setup({ sidecar: false });
		await fail(triage, draft(RUST_ERROR));
		expect(await fail(triage, draft("error[E0308]: mismatched types"))).toBeUndefined();
	});

	it("does not call fewer failing tests, or a different message, a repeat (D-073)", async () => {
		const { triage, t } = setup({}, () => ({ diagnosis: "x", next_action: "y" }));
		const run = (failing: readonly string[], message = "left: 1") =>
			draft(
				[
					...failing.map((name) => `test ${name} ... FAILED`),
					`thread 'a' (4242) panicked at src/lib.rs:9:5:\n  ${message}`,
					"error: test failed, to rerun pass `--lib`",
				].join("\n"),
				{ input: { command: "cargo test" } },
			);
		expect(await fail(triage, run(["a", "b", "c"]))).toBeUndefined();
		// One test fixed: every run still ends in the same cargo line, but the failure moved.
		expect(await fail(triage, run(["a", "b"]))).toBeUndefined();
		expect(await fail(triage, run(["a"]))).toBeUndefined();
		expect(t.requests).toEqual([]);
		expect(triage.status?.()).toBe("triage");
		// Back to a failure seen before (an edit was undone): that is a repeat, and said to be a return.
		const back = await fail(triage, run(["a", "b"]));
		expect(back?.text).toContain("this failed with the same errors as an earlier run");
	});

	it("ignores line numbers, run times and thread ids when comparing failures", async () => {
		const { triage } = setup({ sidecar: false });
		const run = (line: number, id: number, time: string) =>
			draft(
				`--- FAIL: TestSteps (${time}s)\nthread 'a' (${id}) panicked at src/lib.rs:${line}:5:\nFAIL\tpkg\t${time}s`,
			);
		await fail(triage, run(9, 100, "0.01"));
		expect((await fail(triage, run(14, 2077, "0.32")))?.note).toBe("repeat 2");
	});

	it("names the edited files a failure outlived, and shows the sidecar the edits and the code", async () => {
		writeFileSync(
			join(dir, "calc.py"),
			["def add(a, b):", "    return a - b", "", "def sub(a, b):", "    return a - b"].join("\n"),
		);
		const prompts: string[] = [];
		const { triage } = setup({}, (prompt) => {
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
		const rewrite = await fail(triage, failure);
		expect(rewrite?.text).toContain("The edits made since (calc.py) did not change it.");
		expect(rewrite?.text).toContain("[exo triage hint: `add` subtracts in calc.py.");
		expect(prompts[0]).toContain("calc.py\n- def sub(a, b):\n+ def sub(a: int, b: int):");
		expect(prompts[0]).toContain("calc.py (line 2):\n     1 | def add(a, b):\n>    2 |     return a - b");
		expect(prompts[0]).not.toContain("case.py (line");
	});

	it("counts a test run that failed behind a pipe, and says whose exit code was shown", async () => {
		const piped = (output: string) =>
			draft(output, { input: { command: "cargo test 2>&1 | tail -5" }, isError: false, exitCode: 0 });
		const failing = "test parse ... FAILED\nerror: test failed, to rerun pass `--lib`";
		const { triage } = setup({ sidecar: false });
		expect(await fail(triage, piped("test result: ok. 4 passed"))).toBeUndefined();
		expect(await fail(triage, piped(failing))).toBeUndefined();
		const again = await fail(triage, piped(failing));
		expect(again?.text).toContain("this failed again with the same errors as before (first: test parse ... FAILED)");
		expect(again?.text).toContain("The exit code shown is the pipe's last command's, not this run's.");

		const off = setup({ sidecar: false, maskedFailures: false }).triage;
		await fail(off, piped(failing));
		expect(await fail(off, piped(failing))).toBeUndefined();
	});

	it("skips benign exit codes (no grep match) and counts non-error failures with no error line", async () => {
		const { triage } = setup({ sidecar: false });
		const grep = draft("", { input: { command: "cd src && grep -rn foo ." }, exitCode: 1 });
		expect(await fail(triage, grep)).toBeUndefined();
		expect(await fail(triage, grep)).toBeUndefined();
		const silent = draft("nothing useful", { input: { command: "./run.sh" }, exitCode: 3, isError: false });
		await fail(triage, silent);
		const rewrite = await fail(triage, silent);
		expect(rewrite?.text).toContain("this failed again the same way");
	});

	it("at the loop threshold, lists distinct grounded hypotheses from parallel angles", async () => {
		const prompts: string[] = [];
		const answers = [
			{ hypothesis: "The borrow of `self.stack` in lib.rs outlives the push.", check: "Read lib.rs around line 42." },
			{ hypothesis: "The borrow of `self.stack` in lib.rs outlives the push call.", check: "Read lib.rs." },
			{
				hypothesis: "Cargo builds a stale target; the error is from an old build.",
				check: "Run cargo clean then cargo build.",
			},
			{ hypothesis: "The bug is in `ghost_module` instead.", check: "Open src/ghost.rs." },
		];
		const { triage } = setup({ hypotheses: 4, sidecar: false }, (prompt) => {
			prompts.push(prompt);
			return prompt.includes("Angle:") ? (answers[prompts.filter((p) => p.includes("Angle:")).length - 1] ?? {}) : {};
		});
		for (let i = 0; i < 2; i++) await fail(triage, draft(RUST_ERROR));
		const third = await fail(triage, draft(RUST_ERROR));
		expect(prompts.filter((p) => p.includes("Angle:"))).toHaveLength(4);
		expect(new Set(prompts.map((p) => /Angle: (.*)/.exec(p)?.[1])).size).toBe(4);
		expect(third?.text).toContain("[exo triage: possible causes to check before the next attempt (unverified):");
		expect(third?.text).toContain(
			"1. The borrow of `self.stack` in lib.rs outlives the push. Check: Read lib.rs around line 42.",
		);
		expect(third?.text).toContain("2. Cargo builds a stale target");
		expect(third?.text).not.toContain("ghost");
		expect(third?.note).toBe("repeat 3 + 2 hypotheses");
		// Asked once per failure.
		expect((await fail(triage, draft(RUST_ERROR)))?.note).toBe("repeat 4");
	});

	it("falls back to the plain notice when fewer than two hypotheses survive", async () => {
		const { triage } = setup({ hypotheses: 2, sidecar: false }, () => ({ hypothesis: "", check: "" }));
		for (let i = 0; i < 2; i++) await fail(triage, draft(RUST_ERROR));
		expect((await fail(triage, draft(RUST_ERROR)))?.note).toBe("repeat 3");
	});

	describe("loops without an error (D-069)", () => {
		const ok = (command: string, output: string) => draft(output, { input: { command }, isError: false, exitCode: 0 });
		const read = (path: string, output: string) =>
			draft(output, { toolName: "read", input: { path }, isError: false, exitCode: null });

		it("says once that the same call keeps returning the same result, then asks for a hand-over", async () => {
			const { triage, t } = setup({}, () => ({ diagnosis: "x", next_action: "y" }));
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
			// The failing build gets the repeated-error notices; the loop is named on the next edit.
			expect(notes).toEqual([undefined, undefined, undefined, "repeat 2", undefined, "repeat 3"]);
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
	});
});

describe("dedupe", () => {
	it("keeps the first of near-identical hypotheses", () => {
		const h = (hypothesis: string) => ({ hypothesis, check: "c" });
		expect(
			dedupe([
				h("the parser drops the last token"),
				h("the parser drops the last token silently"),
				h("an env var is missing"),
			]).map((x) => x.hypothesis),
		).toEqual(["the parser drops the last token", "an env var is missing"]);
	});
});

describe("isBenign", () => {
	const settings = parseSettings({}).settings;
	const of = (command: string, exitCode: number | null = 1) =>
		isBenign({ exitCode, input: { command }, toolName: "bash" }, settings);
	it("matches the last step's command word only for exit code 1", () => {
		expect(of("grep -q x file")).toBe(true);
		expect(of("LC_ALL=C rg foo")).toBe(true);
		expect(of("make && git diff --exit-code")).toBe(true);
		expect(of("grep x file", 2)).toBe(false);
		expect(of("grepx file")).toBe(false);
		expect(of("grep x file && make")).toBe(false);
		// Core's rule (D-077): the command that set the exit code, read as the shell reads the line.
		expect(of("cat build.log | grep -c ERROR")).toBe(true);
		expect(of("echo 'x; grep' && make")).toBe(false);
		expect(of("cd src &&\n  grep -rn TODO .")).toBe(true);
		expect(isBenign({ exitCode: 1, input: {}, toolName: "read" }, settings)).toBe(false);
	});
});

describe("errorExcerpt", () => {
	it("keeps the first error with context and the tail, marking gaps", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
		lines[30] = "error: boom";
		const excerpt = errorExcerpt(lines.join("\n")).split("\n");
		expect(excerpt[0]).toBe("line 28");
		expect(excerpt).toContain("error: boom");
		expect(excerpt).toContain("[…]");
		expect(excerpt.at(-1)).toBe("line 59");
	});
	it("marks an excerpt that lost its end to the size limit (D-089)", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ${"x".repeat(290)}`);
		lines[5] = "error: boom";
		const excerpt = errorExcerpt(lines.join("\n"));
		expect(excerpt.endsWith("\n[…]")).toBe(true);
		expect(excerpt).toContain("error: boom");
	});
	it("starts at the top when there is no error line", () => {
		expect(errorExcerpt("a\nb")).toBe("a\nb");
	});
});

describe("ungroundedReferences", () => {
	it("accepts references found in the evidence or the workspace", () => {
		expect(
			ungroundedReferences("Fix `self.stack` in src/lib.rs:42 and lib.rs.", "src/lib.rs:42:9 `self.stack`", dir),
		).toEqual([]);
	});
	it("flags invented paths and identifiers, but not commands", () => {
		expect(ungroundedReferences("Edit src/nope.rs and `ghost_fn`, then run `cargo test`.", "", dir)).toEqual([
			"ghost_fn",
			"src/nope.rs",
		]);
	});
});
