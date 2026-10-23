import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { describe, expect, it } from "vitest";
import { fileEdits } from "../src/modules/edits.ts";
import {
	BENIGN_EXIT_COMMANDS,
	isBenignExit,
	judgeHiddenRun,
	maskedFailure,
	outcomeOf,
	readHiddenRun,
	verifyingRun,
} from "../src/modules/runs.ts";

describe("verifyingRun", () => {
	it("finds the test or build run a command line ends in", () => {
		expect(verifyingRun("cd app && RUST_BACKTRACE=1 cargo test --offline 2>&1")).toEqual({
			kind: "test",
			bare: "cargo test --offline",
			hidden: false,
			unpiped: "cd app && RUST_BACKTRACE=1 cargo test --offline 2>&1",
		});
		expect(verifyingRun("make -s -j4")?.kind).toBe("build");
		expect(verifyingRun("timeout 60 go test ./... | tail -20")).toEqual({
			kind: "test",
			bare: "go test ./...",
			hidden: true,
			unpiped: "timeout 60 go test ./...",
		});
		// `pipefail` set either way: the pipeline exits with the run's status (D-077 reads `;` too).
		expect(verifyingRun("set -o pipefail; cargo test | tail")?.hidden).toBe(false);
		expect(verifyingRun("set -o pipefail && cargo test | tail")?.hidden).toBe(false);
		// The word alone is not the option: a subshell's setting ends with it.
		expect(verifyingRun("(set -o pipefail; true) && cargo test | tail")?.hidden).toBe(true);
		expect(verifyingRun("echo pipefail; cargo test | tail")?.hidden).toBe(true);
		expect(verifyingRun("set +o pipefail; cargo test | tail")?.hidden).toBe(true);
		expect(verifyingRun("cat src/lib.rs | head")).toBeUndefined();
	});
});

describe("maskedFailure", () => {
	const piped = (output: string, extra: Record<string, unknown> = {}) => ({
		input: { command: "cargo test 2>&1 | tail -5" },
		isError: false,
		exitCode: 0,
		output,
		...extra,
	});

	it("is a piped test run whose output has a toolchain error line", () => {
		expect(maskedFailure(piped("test a ... FAILED\nerror: test failed, to rerun pass `--lib`"))).toBe(true);
		expect(maskedFailure(piped("test result: ok. 4 passed; 0 failed"))).toBe(false);
		// A line that only mentions an error is not enough against an exit code of 0.
		expect(maskedFailure(piped("warning: unused variable `error`"))).toBe(false);
	});

	it("is not a run whose own exit code was seen, or a command that is not a run", () => {
		const output = "error: test failed, to rerun pass `--lib`";
		expect(maskedFailure(piped(output, { input: { command: "cargo test" } }))).toBe(false);
		expect(maskedFailure(piped(output, { input: { command: "set -o pipefail && cargo test | tail" } }))).toBe(false);
		expect(maskedFailure(piped(output, { input: { command: "git log | head" } }))).toBe(false);
		expect(maskedFailure(piped(output, { exitCode: 1 }))).toBe(false);
		expect(maskedFailure(piped(output, { input: { path: "a.rs" } }))).toBe(false);
	});
});

describe("isBenignExit", () => {
	it("is exit code 1 from a command that answers with it", () => {
		expect(isBenignExit("grep -q x file", 1)).toBe(true);
		expect(isBenignExit("LC_ALL=C timeout 5 /usr/bin/rg foo", 1)).toBe(true);
		expect(isBenignExit("make && git diff --exit-code", 1)).toBe(true);
		expect(isBenignExit("[ -f Cargo.lock ]", 1)).toBe(true);
		expect(isBenignExit("(cd src && grep -rn TODO .)", 1)).toBe(true);
		expect(isBenignExit("grep x file", 2)).toBe(false);
		expect(isBenignExit("grep x file", null)).toBe(false);
		expect(isBenignExit("grepx file", 1)).toBe(false);
		expect(isBenignExit("git diffx", 1)).toBe(false);
		expect(isBenignExit("", 1)).toBe(false);
		expect(isBenignExit("grep 'open", 1)).toBe(false);
	});

	it("looks at the command that set the exit code: the last one, after a pipe too", () => {
		expect(isBenignExit("grep x file && make", 1)).toBe(false);
		expect(isBenignExit("cat log | grep ERROR", 1)).toBe(true);
		expect(isBenignExit("grep ERROR log | sort", 1)).toBe(false);
		expect(isBenignExit("echo 'a; grep' && make", 1)).toBe(false);
		expect(isBenignExit("make; grep -c 'x && y' out", 1)).toBe(true);
	});

	it("takes the caller's list", () => {
		expect(isBenignExit("jq -e .ok out.json", 1)).toBe(false);
		expect(isBenignExit("jq -e .ok out.json", 1, ["jq"])).toBe(true);
		expect(isBenignExit("grep x file", 1, [])).toBe(false);
		expect(BENIGN_EXIT_COMMANDS).toContain("git diff");
	});
});

describe("fileEdits", () => {
	const tool = (toolName: string, input: Record<string, unknown>, isError = false) => ({
		toolName,
		input: input as never,
		isError,
		exitCode: null,
		output: "",
	});

	it("reads an edit's replacements and a write's content, cut to length", () => {
		expect(
			fileEdits(
				tool("edit", { path: "a.rs", edits: [{ oldText: "abcdef", newText: "xy" }, { oldText: 1 }, "junk"] }),
				4,
			),
		).toEqual([{ path: "a.rs", before: "abcd…", after: "xy" }]);
		expect(fileEdits(tool("write", { path: "b.rs", content: "fn main() {}" }), 100)).toEqual([
			{ path: "b.rs", before: "(file rewritten)", after: "fn main() {}" },
		]);
	});

	it("is undefined for a failed call or another tool", () => {
		expect(fileEdits(tool("edit", { path: "a.rs", edits: [] }, true), 10)).toBeUndefined();
		expect(fileEdits(tool("bash", { command: "ls" }), 10)).toBeUndefined();
		expect(fileEdits(tool("read", { path: "a.rs" }), 10)).toBeUndefined();
	});
});

describe("reading a run whose exit code a pipe hid (D-075)", () => {
	const piped = (output: string, command = "cargo test 2>&1 | tail -5") => ({
		toolName: "bash",
		input: { command },
		isError: false,
		exitCode: 0,
		output,
	});

	it("reads a failure, a runner's pass summary, or neither", () => {
		expect(readHiddenRun(piped("test a ... FAILED\nerror: test failed, to rerun pass `--lib`"))).toBe("failed");
		expect(readHiddenRun(piped("test result: ok. 4 passed; 0 failed; 0 ignored"))).toBe("passed");
		expect(readHiddenRun(piped("ok  \texample.com/pkg\t0.21s", "go test ./... | tail -3"))).toBe("passed");
		expect(readHiddenRun(piped("Ran 7 tests in 0.366s\n\nOK", "python3 -m unittest 2>&1 | tail -3"))).toBe("passed");
		expect(readHiddenRun(piped("===== 12 passed in 0.41s =====", "pytest | tail -1"))).toBe("passed");
		// pytest's own summary says so (D-077; it was `unknown` while only pass summaries were read).
		expect(readHiddenRun(piped("==== 10 passed, 2 errors in 0.41s ====", "pytest | tail -1"))).toBe("failed");
		expect(readHiddenRun(piped("==== 10 passed, 2 warnings in 0.41s ====", "pytest | tail -1"))).toBe("passed");
		// TAP's passing lines are not Go's package summary.
		expect(readHiddenRun(piped("ok 12 - parses ipv6", "make test | tail -1"))).toBe("unknown");
		expect(readHiddenRun(piped("3", "cargo test 2>&1 | grep -c ok"))).toBe("unknown");
		// A build says nothing when it works.
		expect(readHiddenRun(piped("", "cargo build 2>&1 | tail -5"))).toBe("unknown");
		expect(readHiddenRun(piped("test result: ok. 4 passed", "cargo build 2>&1 | tail -5"))).toBe("unknown");
	});

	it("reads the summaries of Vitest, Jest, Mocha, node:test, Deno and a project's own (D-108)", () => {
		const cases: [string, string, string][] = [
			[" Test Files  3 passed (3)\n      Tests  12 passed (12)", "npx vitest run | tail", "passed"],
			[
				" Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 11 passed (12)",
				"npx vitest run | tail",
				"failed",
			],
			["Test Suites: 3 passed, 3 total\nTests:       12 passed, 12 total", "npx jest | tail", "passed"],
			["Tests:       1 skipped, 11 passed, 12 total", "npx jest | tail", "passed"],
			["Test Suites: 1 failed, 2 passed, 3 total", "npx jest | tail", "failed"],
			["  3 passing (20ms)", "npx mocha | tail", "passed"],
			["  3 passing (20ms)\n  1 failing", "npx mocha | tail", "failed"],
			["# tests 3\n# pass 3\n# fail 0", "node --test | tail", "passed"],
			["ℹ tests 3\nℹ fail 1", "node --test | tail", "failed"],
			["ok | 4 passed | 0 failed (12ms)", "deno test | tail", "passed"],
			["FAILED | 3 passed | 1 failed (12ms)", "deno test | tail", "failed"],
			["./build/test_graph\nall tests passed", "make test 2>&1 | tail -3", "passed"],
			["./build/t\nSegmentation fault (core dumped)", "make test 2>&1 | tail -3", "failed"],
			["src/a.cpp:10:5: runtime error: signed integer overflow", "make test 2>&1 | tail", "failed"],
			["==4242==ERROR: AddressSanitizer: heap-use-after-free on address 0x1", "make test 2>&1 | tail", "failed"],
			["t: tests/t.cpp:34: int main(): Assertion `x == 7' failed.", "make test 2>&1 | tail", "failed"],
		];
		for (const [output, command, verdict] of cases)
			expect([command, readHiddenRun(piped(output, command))]).toEqual([command, verdict]);
	});

	it("takes the run's exit code when the line echoes it (D-108)", () => {
		const read = (command: string, output: string) => readHiddenRun(piped(output, command));
		const PS = "$" + "{PIPESTATUS[0]}";
		expect(read(`cd x && make test 2>&1 | tail -4; echo "exit=${PS}"`, "foo\nexit=0")).toBe("passed");
		expect(read(`make test 2>&1 | tail -3; echo "=== exit: ${PS} ==="; git status`, "a\n=== exit: 2 ===\nM x")).toBe(
			"failed",
		);
		expect(read('make test >/tmp/o 2>&1; echo "EXIT CODE: $?"; cat /tmp/o', "EXIT CODE: 2\nall tests passed")).toBe(
			"failed",
		);
		expect(read("pytest -q; echo EXIT: $?", "EXIT: 0")).toBe("passed");
		// `$?` after a pipe is the pipe's last command's: not the run's.
		expect(read('make test 2>&1 | tail -3; echo "exit=$?"', "foo\nexit=0")).toBe("unknown");
		// The run is not the pipeline's first command.
		expect(read(`cat x | make test 2>&1 | tail; echo "exit=${PS}"`, "exit=0")).toBe("unknown");
		// Lines that disagree, or other words that do not match, tell nothing.
		expect(read(`make test | tail; echo "exit=${PS}"`, "exit=0\nexit=1")).toBe("unknown");
		expect(read(`make test | tail; echo "status ${PS} $HOME"`, "status 0 /home/u")).toBe("unknown");
	});

	it("leaves a run alone when its exit code is its own", () => {
		expect(readHiddenRun(piped("test result: ok.", "cargo test"))).toBeUndefined();
		expect(readHiddenRun({ ...piped("x"), exitCode: 1 })).toBeUndefined();
	});

	it("gives modules one answer: the exit code, the harness's reading, or its own", () => {
		expect(outcomeOf({ ...piped("fine", "cargo test"), exitCode: 101 })).toBe("failed");
		expect(outcomeOf(piped("fine", "ls"))).toBe("passed");
		expect(outcomeOf(piped("fine"))).toBe("unknown");
		expect(outcomeOf({ ...piped("Tests: 4 passed, 4 total"), hidden: "passed" })).toBe("passed");
		expect(maskedFailure({ ...piped("1 failing"), hidden: "failed" })).toBe(true);
	});

	async function judge(output: string, reply: SidecarReply | undefined, command = "npm test 2>&1 | tail -4") {
		const t = createTestModuleContext({ cwd: ".", ...(reply === undefined ? {} : { reply: () => reply }) });
		const reading = await judgeHiddenRun(
			piped(output, command),
			{ pool: t.context.pool(), module: "runs", timeoutMs: 2_000 },
			new AbortController().signal,
		);
		return { reading, t };
	}
	// Jasmine's summary: no pattern of the grammar reads it.
	const SUMMARY = "4 specs, 0 failures";
	const SPECS = `Randomized with seed 1234\n${SUMMARY}`;

	it("asks a sidecar only about a test run the output does not settle", async () => {
		const read = await judge(
			"test result: ok. 4 passed",
			{ verdict: "failed", evidence: "test result: ok. 4 passed" },
			"cargo test | tail",
		);
		expect(read.reading).toEqual({ verdict: "passed", source: "output" });
		expect(read.t.requests).toEqual([]);
		expect((await judge("", { verdict: "passed", evidence: "" })).t.requests).toEqual([]);
		expect((await judge(SPECS, { verdict: "passed", evidence: SUMMARY }, "cargo build | tail")).t.requests).toEqual([]);
		expect((await judge(SPECS, undefined)).reading).toEqual({ verdict: "unknown", source: "output" });
		expect(
			await judgeHiddenRun(
				piped(SPECS, "npm test"),
				{ pool: undefined, module: "runs", timeoutMs: 1 },
				new AbortController().signal,
			),
		).toBeUndefined();
	});

	it("takes the sidecar's answer when it quotes a line of the output", async () => {
		const passed = await judge(SPECS, { verdict: "passed", evidence: SUMMARY });
		expect(passed.reading).toEqual({ verdict: "passed", source: "sidecar", evidence: SUMMARY });
		expect(String(passed.t.requests[0]?.messages[0]?.["content"])).toContain("npm test 2>&1 | tail -4");
		const failing = "Randomized with seed 1\n4 specs, 1 failure";
		expect((await judge(failing, { verdict: "failed", evidence: "specs, 1 failure" })).reading?.verdict).toBe("failed");
	});

	it("tells the sidecar when it is shown only the end of the output (D-089)", async () => {
		const long = `${"compiling a module of the project\n".repeat(600)}${SPECS}`;
		const cut = await judge(long, { verdict: "passed", evidence: SUMMARY });
		const prompt = String(cut.t.requests[0]?.messages[0]?.["content"]);
		expect(prompt).toContain("[… the start of the output is not shown …]\n");
		expect(prompt).toContain(SPECS);
		// The mark is not a line of the output: it is no evidence.
		const marked = await judge(long, { verdict: "passed", evidence: "[… the start of the output is not shown …]" });
		expect(marked.reading).toMatchObject({ verdict: "unknown", source: "sidecar_rejected" });
		const whole = await judge(SPECS, { verdict: "passed", evidence: SUMMARY });
		expect(String(whole.t.requests[0]?.messages[0]?.["content"])).not.toContain("is not shown …]");
	});

	it("does not take an answer it cannot check, and says why (D-108)", async () => {
		expect((await judge(SPECS, { verdict: "passed", evidence: "All tests passed" })).reading).toEqual({
			verdict: "unknown",
			source: "sidecar_rejected",
			evidence: "All tests passed",
			error: "passed: its quote is not a line of the output",
		});
		expect((await judge(SPECS, { verdict: "passed", evidence: "" })).reading).toMatchObject({
			verdict: "unknown",
			source: "sidecar_rejected",
		});
		// A short quote must be a whole line.
		expect((await judge("TOKEN refreshed", { verdict: "passed", evidence: "OK" })).reading?.source).toBe(
			"sidecar_rejected",
		);
		// "passed" against a line that mentions a failure.
		const mixed = "4 specs, 1 failure";
		expect((await judge(mixed, { verdict: "passed", evidence: mixed })).reading).toEqual({
			verdict: "unknown",
			source: "sidecar_rejected",
			evidence: mixed,
			error: "passed: the output mentions a failure",
		});
		// A line that only names something called an error does not veto "passed" (D-077).
		const named = `PASS src/errors/error.test.js\n${SPECS}`;
		expect((await judge(named, { verdict: "passed", evidence: SUMMARY })).reading).toEqual({
			verdict: "passed",
			source: "sidecar",
			evidence: SUMMARY,
		});
		expect((await judge(SPECS, { verdict: "unknown", evidence: "" })).reading).toEqual({
			verdict: "unknown",
			source: "sidecar",
		});
		// A failed call is not a reading of the output.
		expect((await judge(SPECS, new Error("down"))).reading).toMatchObject({
			verdict: "unknown",
			source: "sidecar_failed",
			error: expect.stringContaining("down"),
		});
	});
});
