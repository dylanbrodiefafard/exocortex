import { describe, expect, it } from "vitest";
import { fileEdits } from "../src/modules/edits.ts";
import { maskedFailure, verifyingRun } from "../src/modules/runs.ts";

describe("verifyingRun", () => {
	it("finds the test or build run a command line ends in", () => {
		expect(verifyingRun("cd app && RUST_BACKTRACE=1 cargo test --offline 2>&1")).toEqual({
			kind: "test",
			bare: "cargo test --offline",
			hidden: false,
		});
		expect(verifyingRun("make -s -j4")?.kind).toBe("build");
		expect(verifyingRun("timeout 60 go test ./... | tail -20")).toEqual({
			kind: "test",
			bare: "go test ./...",
			hidden: true,
		});
		expect(verifyingRun("set -o pipefail; cargo test | tail")).toBeUndefined();
		expect(verifyingRun("set -o pipefail && cargo test | tail")?.hidden).toBe(false);
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
