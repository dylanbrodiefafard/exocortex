import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, ToolOutcome, ToolResultDraft } from "@exocortex/core";
import { createTestModuleContext } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTools } from "../src/tools.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-tools-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;

function write(path: string, content: string): void {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), content);
}

function outcome(
	toolName: string,
	input: { [key: string]: JsonValue },
	output: string,
	isError = false,
): ToolOutcome & ToolResultDraft {
	return {
		toolName,
		toolCallId: `call-${Math.random()}`,
		input,
		isError,
		exitCode: null,
		output,
		current: output,
		fullOutputPath: null,
		status: null,
	};
}

function setup(settings: Record<string, unknown> = {}) {
	const t = createTestModuleContext({ cwd: dir });
	return { ...t, module: createTools(settings, t.context) };
}

/** A tool result as the host delivers it: every module sees it, then it is offered for rewriting. */
async function deliver(module: ReturnType<typeof setup>["module"], draft: ToolOutcome & ToolResultDraft) {
	module.onToolResult?.(draft);
	const result = await module.rewriteToolResult?.(draft, signal);
	result?.commit?.();
	return result;
}

const notFound = (path: string) =>
	`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`;

describe("edit hints", () => {
	it("shows the lines an edit meant when only the indentation differs", async () => {
		write("src/lib.rs", 'fn main() {\n\tlet x = 1;\n\tprintln!("{x}");\n}\n');
		const { module } = setup();
		const result = await deliver(
			module,
			outcome(
				"edit",
				{ path: "src/lib.rs", edits: [{ oldText: '    let x = 1;\n    println!("{x}");', newText: "" }] },
				notFound("src/lib.rs"),
				true,
			),
		);
		expect(result?.text).toContain("oldText matches lines 2-3 of src/lib.rs except for indentation or spacing");
		expect(result?.text).toContain('\tlet x = 1;\n\tprintln!("{x}");');
		expect(module.status?.()).toContain("1 edit hint(s)");
	});

	it("shows the closest text when the edit's text drifted", async () => {
		write("a.py", "def total(items):\n    return sum(i.price for i in items)\n\n\ndef other():\n    pass\n");
		const { module } = setup();
		const result = await deliver(
			module,
			outcome(
				"edit",
				{
					path: "a.py",
					edits: [
						{ oldText: "x", newText: "y" },
						{ oldText: "def total(items):\n    return sum(item.price for item in items)", newText: "z" },
					],
				},
				"Could not find edits[1] in a.py. The oldText must match exactly including all whitespace and newlines.",
				true,
			),
		);
		expect(result?.text).toContain("The closest text to edits[1].oldText in a.py is at lines 1-2");
		expect(result?.text).toContain("    return sum(i.price for i in items)");
	});

	it("says nothing when no lines are close", async () => {
		write("a.py", "alpha = 1\nbeta = 2\n");
		const { module } = setup();
		const result = await deliver(
			module,
			outcome(
				"edit",
				{ path: "a.py", edits: [{ oldText: "completely different", newText: "" }] },
				notFound("a.py"),
				true,
			),
		);
		expect(result).toBeUndefined();
	});

	it("notices line numbers copied from a numbered read", async () => {
		write("a.go", "package main\n\nfunc main() {}\n");
		const { module } = setup();
		const result = await deliver(
			module,
			outcome("edit", { path: "a.go", edits: [{ oldText: "3\tfunc main() {}", newText: "" }] }, notFound("a.go"), true),
		);
		expect(result?.text).toContain("starts its lines with line numbers");
		expect(result?.text).toContain("Without them it matches line 3.");
	});

	it("notices an edit that was already made", async () => {
		write("a.go", "package main\n\nfunc main() { run() }\n");
		const { module } = setup();
		const result = await deliver(
			module,
			outcome(
				"edit",
				{ path: "a.go", oldText: "func main() {}", newText: "func main() { run() }" },
				notFound("a.go"),
				true,
			),
		);
		expect(result?.text).toContain("newText is already in a.go at line 3");
	});

	it("lists every place a non-unique edit matches", async () => {
		write("a.c", "int a;\nreturn 0;\nint b;\nreturn 0;\n");
		const { module } = setup();
		const result = await deliver(
			module,
			outcome(
				"edit",
				{ path: "a.c", edits: JSON.stringify([{ oldText: "return 0;", newText: "return 1;" }]) },
				"Found 2 occurrences of the text in a.c. The text must be unique. Please provide more context to make it unique.",
				true,
			),
		);
		expect(result?.text).toContain("oldText matches 2 places, starting at lines 2, 4");
		expect(result?.text).toContain("Lines 1-3 of a.c:\nint a;\nreturn 0;\nint b;");
	});

	it("names the edit whose old and new text are the same", async () => {
		write("a.c", "int a;\n");
		const { module } = setup();
		const result = await deliver(
			module,
			outcome(
				"edit",
				{ path: "a.c", edits: [{ oldText: "int a;", newText: "int a;" }] },
				"No changes made to a.c. The replacement produced identical content.",
				true,
			),
		);
		expect(result?.text).toContain("The edit has the same oldText and newText.");
	});

	it("suggests existing paths for a file that does not exist", async () => {
		write("src/parser/mod.rs", "");
		write("src/lexer.rs", "");
		const { module } = setup();
		const edit = await deliver(
			module,
			outcome(
				"edit",
				{ path: "src/parsr/mod.rs", edits: [] },
				"Could not edit file: src/parsr/mod.rs. Error code: ENOENT.",
				true,
			),
		);
		expect(edit?.text).toContain("src/parsr/mod.rs does not exist");
		expect(edit?.text).toContain("- src/parser/mod.rs");
		const read = await deliver(
			module,
			outcome("read", { path: "src/lexr.rs" }, `ENOENT: no such file or directory, access '${dir}/src/lexr.rs'`, true),
		);
		expect(read?.text).toContain("- src/lexer.rs");
	});

	it("leaves errors it does not know alone, and does nothing when switched off", async () => {
		write("a.c", "int a;\n");
		const { module } = setup();
		expect(
			await deliver(module, outcome("edit", { path: "a.c", edits: [] }, "edits[0] and edits[1] overlap in a.c.", true)),
		).toBeUndefined();
		const off = setup({ editHints: false }).module;
		const input = { path: "a.c", edits: [{ oldText: "  int a;", newText: "" }] };
		expect(await deliver(off, outcome("edit", input, notFound("a.c"), true))).toBeUndefined();
	});
});

describe("read view", () => {
	it("numbers the lines from the read's offset", async () => {
		write("a.txt", "one\ntwo\nthree\n");
		const { module } = setup();
		const result = await deliver(module, outcome("read", { path: "a.txt", offset: 9 }, "nine\nten\n"));
		expect(result?.text).toBe(" 9\tnine\n10\tten");
		expect(result?.note).toBe("numbered");
	});

	it("keeps pi's note and outlines the rest of a file it did not show", async () => {
		const lines = [
			"use std::io;",
			"",
			"pub fn first() {}",
			...Array.from({ length: 10 }, () => "// filler"),
			"pub(crate) struct Later;",
			"impl Later {",
			"    pub async fn go(&self) {}",
			"}",
		];
		write("src/lib.rs", lines.join("\n"));
		const { module } = setup();
		const output = `${lines.slice(0, 3).join("\n")}\n\n[Showing lines 1-3 of 17. Use offset=4 to continue.]`;
		const result = await deliver(module, outcome("read", { path: "src/lib.rs" }, output));
		expect(result?.text).toBe(
			[
				"1\tuse std::io;",
				"2\t",
				"3\tpub fn first() {}",
				"",
				"[Showing lines 1-3 of 17. Use offset=4 to continue.]",
				"",
				"[exo tools] Declarations in the rest of src/lib.rs (from line 4), verbatim:",
				"14\tpub(crate) struct Later;",
				"15\timpl Later {",
				"16\t    pub async fn go(&self) {}",
			].join("\n"),
		);
		expect(module.status?.()).toContain("1 outline(s)");
	});

	it("reads pi's note for a read the byte limit stopped", async () => {
		write("a.go", "package a\n\nfunc A() {}\n\nfunc B() {}\n");
		const { module } = setup();
		const output = "package a\n\n[Showing lines 1-1 of 5 (50.0KB limit). Use offset=2 to continue.]";
		const result = await deliver(module, outcome("read", { path: "a.go" }, output));
		expect(result?.text).toBe(
			"1\tpackage a\n\n[Showing lines 1-1 of 5 (50.0KB limit). Use offset=2 to continue.]\n\n[exo tools] Declarations in the rest of a.go (from line 2), verbatim:\n3\tfunc A() {}\n5\tfunc B() {}",
		);
	});

	it("caps the outline and can outline without numbering", async () => {
		const lines = Array.from({ length: 30 }, (_, i) => `def f${i}():\n    pass`)
			.join("\n")
			.split("\n");
		write("m.py", lines.join("\n"));
		const { module } = setup({ readLineNumbers: false, outlineMaxEntries: 2 });
		const output = `${lines[0]}\n\n[58 more lines in file. Use offset=3 to continue.]`;
		const result = await deliver(module, outcome("read", { path: "m.py", limit: 2 }, output));
		expect(result?.text).toContain("def f0():\n\n[58 more lines in file. Use offset=3 to continue.]");
		expect(result?.text).toContain("3\tdef f1():\n5\tdef f2():\n(27 more)");
	});

	it("leaves images, long-line notes and unnumbered reads alone", async () => {
		const { module } = setup();
		expect(await deliver(module, outcome("read", { path: "a.png" }, "Read image file [image/png]"))).toBeUndefined();
		expect(
			await deliver(
				module,
				outcome(
					"read",
					{ path: "a.min.js" },
					"[Line 1 is 80KB, exceeds 50KB limit. Use bash: sed -n '1p' a.min.js | head -c 51200]",
				),
			),
		).toBeUndefined();
		expect(await deliver(module, outcome("read", { path: "empty.txt" }, ""))).toBeUndefined();
		const off = setup({ readLineNumbers: false }).module;
		expect(await deliver(off, outcome("read", { path: "a.txt" }, "one\n"))).toBeUndefined();
	});
});

describe("checks after an edit", () => {
	it("shows a syntax error the edit introduced, and not one that was there before", async () => {
		write("a.py", "def f():\n    return 1\n");
		const { module } = setup();
		const call = { toolName: "edit", toolCallId: "1", input: { path: "a.py" } };
		await module.beforeToolCall?.(call, signal);
		write("a.py", "def f(:\n    return 1\n");
		const first = await deliver(module, outcome("edit", { path: "a.py" }, "Successfully replaced 1 block(s) in a.py."));
		expect(first?.text).toContain("[exo tools] python3 syntax check reports a new error after this change:");
		expect(first?.text).toMatch(/a\.py:1:\d+: SyntaxError/);

		// The error is still there after an unrelated edit: it is not new.
		await module.beforeToolCall?.({ ...call, toolCallId: "2" }, signal);
		write("a.py", "def f(:\n    return 2\n");
		expect(await deliver(module, outcome("edit", { path: "a.py" }, "ok"))).toBeUndefined();
		expect(module.status?.()).toContain("1 new error(s) shown");
	});

	it("does not report what it had no picture of before the edit", async () => {
		write("a.sh", "echo hi\n");
		const { module } = setup();
		write("a.sh", "if then\n");
		expect(await deliver(module, outcome("write", { path: "a.sh", content: "if then\n" }, "ok"))).toBeUndefined();
	});

	it("treats a file a write creates as having had no errors", async () => {
		const { module } = setup();
		await module.beforeToolCall?.({ toolName: "write", toolCallId: "1", input: { path: "new.sh" } }, signal);
		write("new.sh", "if then\n");
		const result = await deliver(module, outcome("write", { path: "new.sh" }, "ok"));
		expect(result?.text).toContain("bash -n reports a new error");
	});

	describe("a project-wide check", () => {
		// A stand-in for `cargo check`: prints the errors listed in errors.txt and fails when there are any.
		const checks = [{ files: "*.rs", command: "cat errors.txt; test ! -s errors.txt" }];
		const E0425 = "error[E0425]: cannot find value `x` in this scope\n  --> src/a.rs:3:5";
		const E0308 = "error[E0308]: mismatched types\n  --> src/b.rs:9:1";

		it("shows only the errors that came with the edit, wherever they are", async () => {
			write("errors.txt", `${E0425}\n`);
			write("src/a.rs", "");
			const { module } = setup({ checks, builtinChecks: false });
			await module.beforeToolCall?.({ toolName: "edit", toolCallId: "1", input: { path: "src/a.rs" } }, signal);
			// The old error moved down two lines; a new one appeared in another file.
			write("errors.txt", `${E0425.replace("3:5", "5:5")}\n${E0308}\n`);
			const result = await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok"));
			expect(result?.text).toContain(
				"cat errors.txt; test ! -s errors.txt reports a new error after this change:\nerror[E0308]: mismatched types\n  --> src/b.rs:9:1",
			);
			expect(result?.text).not.toContain("E0425");
		});

		it("compares each edit of a turn with the one before it", async () => {
			write("errors.txt", "");
			write("src/a.rs", "");
			write("src/b.rs", "");
			const { module } = setup({ checks, builtinChecks: false });
			// Pi asks about every call of a turn before it runs any of them.
			await module.beforeToolCall?.({ toolName: "edit", toolCallId: "1", input: { path: "src/a.rs" } }, signal);
			await module.beforeToolCall?.({ toolName: "edit", toolCallId: "2", input: { path: "src/b.rs" } }, signal);
			write("errors.txt", `${E0425}\n`);
			expect((await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok")))?.text).toContain("E0425");
			write("errors.txt", `${E0425}\n${E0308}\n`);
			const second = await deliver(module, outcome("edit", { path: "src/b.rs" }, "ok"));
			expect(second?.text).toContain("E0308");
			expect(second?.text).not.toContain("E0425");
		});

		it("looks again after a shell command, which may have changed anything", async () => {
			write("errors.txt", "");
			write("src/a.rs", "");
			const { module } = setup({ checks, builtinChecks: false });
			await module.beforeToolCall?.({ toolName: "edit", toolCallId: "1", input: { path: "src/a.rs" } }, signal);
			expect(await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok"))).toBeUndefined();
			// A generator wrote a broken file: that error is not the next edit's doing.
			write("errors.txt", `${E0425}\n`);
			await deliver(module, outcome("bash", { command: "./generate.sh" }, ""));
			await module.beforeToolCall?.({ toolName: "edit", toolCallId: "2", input: { path: "src/a.rs" } }, signal);
			expect(await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok"))).toBeUndefined();
		});

		it("says nothing when an edit's own check never ran", async () => {
			write("errors.txt", "");
			write("src/a.rs", "");
			const { module } = setup({ checks, builtinChecks: false });
			await module.beforeToolCall?.({ toolName: "edit", toolCallId: "1", input: { path: "src/a.rs" } }, signal);
			// The first edit's result was never offered for rewriting (its budget ran out).
			module.onToolResult?.(outcome("edit", { path: "src/a.rs" }, "ok"));
			write("errors.txt", `${E0425}\n`);
			expect(await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok"))).toBeUndefined();
		});
	});

	it("stops trying a checker that is not installed", async () => {
		write("a.rs", "");
		const checks = [{ files: "*.rs", command: "exo-no-such-checker {file}" }];
		const { module, logs } = setup({ checks });
		await module.beforeToolCall?.({ toolName: "edit", toolCallId: "1", input: { path: "a.rs" } }, signal);
		expect(logs.join("\n")).toContain("not installed, not tried again: exo-no-such-checker 'a.rs'");
		expect(await deliver(module, outcome("edit", { path: "a.rs" }, "ok"))).toBeUndefined();
	});

	it("sends what a check slower than its hold finds as late help, unless something made it stale (D-098)", async () => {
		const E0308 = "error[E0308]: mismatched types\n  --> src/b.rs:9:1";
		const E0425 = "error[E0425]: cannot find value `x` in this scope\n  --> src/a.rs:3:5";
		write("a.rs", "");
		write("errors.txt", "");
		// A stand-in for a slow `cargo check`: slow once the marker file exists.
		const checks = [
			{ files: "*.rs", command: "if [ -f slow ]; then sleep 0.6; fi; cat errors.txt; test ! -s errors.txt" },
		];
		const { module, late, records, logs } = setup({ checks, checkHoldMs: 200 });
		const edit = () => module.beforeToolCall?.({ toolName: "edit", toolCallId: "1", input: { path: "a.rs" } }, signal);
		await edit();
		write("slow", "");
		write("errors.txt", `${E0308}\n`);
		// The edit's result goes back after the hold, without the check.
		expect(await deliver(module, outcome("edit", { path: "a.rs" }, "ok"))).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(logs).toEqual([]);
		expect(late).toEqual([
			`[exo tools] if [ -f slow ]; then sleep 0.6; fi; cat errors.txt; test ! -s errors.txt reports a new error after your edit to a.rs:\n${E0308}`,
		]);
		expect(module.status?.()).toContain("1 new error(s) shown");
		expect(records).toEqual([]);

		// A shell command before the check ends: its result would mix that command's changes in.
		rmSync(join(dir, "slow"));
		await edit();
		write("slow", "");
		write("errors.txt", `${E0308}\n${E0425}\n`);
		await deliver(module, outcome("edit", { path: "a.rs" }, "ok"));
		module.onToolResult?.(outcome("bash", { command: "touch b.rs" }, ""));
		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(late).toHaveLength(1);
	});

	it("checks nothing when switched off or for files no check covers", async () => {
		write("a.py", "x = 1\n");
		const off = setup({ diagnostics: false }).module;
		await off.beforeToolCall?.({ toolName: "edit", toolCallId: "1", input: { path: "a.py" } }, signal);
		write("a.py", "x = (\n");
		expect(await deliver(off, outcome("edit", { path: "a.py" }, "ok"))).toBeUndefined();
		const { module } = setup();
		await module.beforeToolCall?.({ toolName: "edit", toolCallId: "1", input: { path: "notes.txt" } }, signal);
		expect(await deliver(module, outcome("edit", { path: "notes.txt" }, "ok"))).toBeUndefined();
		expect(await deliver(module, outcome("bash", { command: "ls" }, "a.py"))).toBeUndefined();
	});
});
