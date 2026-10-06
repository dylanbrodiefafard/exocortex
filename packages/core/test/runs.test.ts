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

	async function judge(output: string, reply: SidecarReply | undefined, command = "npx jest 2>&1 | tail -4") {
		const t = createTestModuleContext({ cwd: ".", ...(reply === undefined ? {} : { reply: () => reply }) });
		const reading = await judgeHiddenRun(
			piped(output, command),
			{ pool: t.context.pool(), module: "runs", timeoutMs: 2_000 },
			new AbortController().signal,
		);
		return { reading, t };
	}
	const JEST = "Tests:       4 passed, 4 total\nTime:        1.2 s";

	it("asks a sidecar only about a test run the output does not settle", async () => {
		const read = await judge(
			"test result: ok. 4 passed",
			{ verdict: "failed", evidence: "test result: ok. 4 passed" },
			"cargo test | tail",
		);
		expect(read.reading).toEqual({ verdict: "passed", source: "output" });
		expect(read.t.requests).toEqual([]);
		expect((await judge("", { verdict: "passed", evidence: "" })).t.requests).toEqual([]);
		expect((await judge(JEST, { verdict: "passed", evidence: JEST }, "cargo build | tail")).t.requests).toEqual([]);
		expect((await judge(JEST, undefined)).reading).toEqual({ verdict: "unknown", source: "output" });
		expect(
			await judgeHiddenRun(
				piped(JEST, "npx jest"),
				{ pool: undefined, module: "runs", timeoutMs: 1 },
				new AbortController().signal,
			),
		).toBeUndefined();
	});

	it("takes the sidecar's answer when it quotes a line of the output", async () => {
		const passed = await judge(JEST, { verdict: "passed", evidence: "Tests:       4 passed, 4 total" });
		expect(passed.reading).toEqual({
			verdict: "passed",
			source: "sidecar",
			evidence: "Tests:       4 passed, 4 total",
		});
		expect(String(passed.t.requests[0]?.messages[0]?.["content"])).toContain("npx jest 2>&1 | tail -4");
		const failing = "Tests:       1 failed, 3 passed, 4 total";
		expect((await judge(failing, { verdict: "failed", evidence: "1 failed, 3 passed" })).reading?.verdict).toBe(
			"failed",
		);
	});

	it("does not take an answer it cannot check", async () => {
		const unknown = { verdict: "unknown", source: "output" };
		expect((await judge(JEST, { verdict: "passed", evidence: "All tests passed" })).reading).toEqual(unknown);
		expect((await judge(JEST, { verdict: "passed", evidence: "" })).reading).toEqual(unknown);
		// A short quote must be a whole line.
		expect((await judge("TOKEN refreshed", { verdict: "passed", evidence: "OK" })).reading).toEqual(unknown);
		// "passed" against a line that mentions a failure.
		const mixed = "Tests:       1 failed, 3 passed, 4 total";
		expect((await judge(mixed, { verdict: "passed", evidence: mixed })).reading).toEqual(unknown);
		// A line that only names something called an error does not veto "passed" (D-077).
		const named = `PASS src/errors/error.test.js\n${JEST}`;
		expect((await judge(named, { verdict: "passed", evidence: "Tests:       4 passed, 4 total" })).reading).toEqual({
			verdict: "passed",
			source: "sidecar",
			evidence: "Tests:       4 passed, 4 total",
		});
		expect((await judge(JEST, { verdict: "unknown", evidence: "" })).reading).toEqual(unknown);
		expect((await judge(JEST, new Error("down"))).reading).toEqual(unknown);
	});
});
