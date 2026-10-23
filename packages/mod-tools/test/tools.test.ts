import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		const output = `${lines[0]}\n\n[Showing lines 1-2 of 60 (50.0KB limit). Use offset=3 to continue.]`;
		const result = await deliver(module, outcome("read", { path: "m.py" }, output));
		expect(result?.text).toContain("def f0():\n\n[Showing lines 1-2 of 60 (50.0KB limit). Use offset=3 to continue.]");
		expect(result?.text).toContain("3\tdef f1():\n5\tdef f2():\n(27 more)");
	});

	it("outlines only a read pi's size limit stopped, once per file content (D-110)", async () => {
		const lines = ["def a():", "    pass", "def b():", "    pass"];
		write("m.py", lines.join("\n"));
		const { module } = setup();
		// The model asked for two lines: it chose what to see.
		const limited = await deliver(
			module,
			outcome(
				"read",
				{ path: "m.py", limit: 2 },
				"def a():\n    pass\n\n[2 more lines in file. Use offset=3 to continue.]",
			),
		);
		expect(limited?.text).not.toContain("Declarations");
		const cut = "def a():\n    pass\n\n[Showing lines 1-2 of 4 (50.0KB limit). Use offset=3 to continue.]";
		expect((await deliver(module, outcome("read", { path: "m.py" }, cut)))?.text).toContain("3\tdef b():");
		expect((await deliver(module, outcome("read", { path: "m.py" }, cut)))?.text).not.toContain("Declarations");
		// The file changed: its outline may have too.
		write("m.py", [...lines, "def c():"].join("\n"));
		expect((await deliver(module, outcome("read", { path: "m.py" }, cut)))?.text).toContain("5\tdef c():");
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

/** Lets checks started in the background finish. */
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

describe("checks after an edit", () => {
	it("shows a file's syntax error once, and not again while it stays (D-110)", async () => {
		write("a.py", "def f():\n    return 1\n");
		const { module } = setup();
		write("a.py", "def f(:\n    return 1\n");
		const first = await deliver(module, outcome("edit", { path: "a.py" }, "Successfully replaced 1 block(s) in a.py."));
		// Nothing was checked before the edit: the error is the file's, not claimed to be new.
		expect(first?.text).toContain("[exo tools] python3 syntax check reports an error in a.py (it had not run before");
		expect(first?.text).toMatch(/a\.py:1:\d+: SyntaxError/);

		// The error is still there after an unrelated edit: it is not new.
		write("a.py", "def f(:\n    return 2\n");
		expect(await deliver(module, outcome("edit", { path: "a.py" }, "ok"))).toBeUndefined();
		// A shell command made the last result stale; what was shown is still not repeated.
		await deliver(module, outcome("bash", { command: "python3 gen.py" }, ""));
		write("a.py", "def f(:\n    return 3\n");
		expect(await deliver(module, outcome("edit", { path: "a.py" }, "ok"))).toBeUndefined();
		expect(module.status?.()).toContain("1 new error(s) shown");
	});

	it("shows the errors of a file a write creates", async () => {
		const { module } = setup();
		await module.beforeToolCall?.({ toolName: "write", toolCallId: "1", input: { path: "new.sh" } }, signal);
		write("new.sh", "if then\n");
		const result = await deliver(module, outcome("write", { path: "new.sh" }, "ok"));
		expect(result?.text).toContain("bash -n reports an error in new.sh");
	});

	describe("a project-wide check", () => {
		// A stand-in for `cargo check`: prints the errors listed in errors.txt and fails when there are any.
		const checks = [{ files: "*.rs", command: "cat errors.txt; test ! -s errors.txt" }];
		const E0425 = "error[E0425]: cannot find value `x` in this scope\n  --> src/a.rs:3:5";
		const E0308 = "error[E0308]: mismatched types\n  --> src/b.rs:9:1";
		const read = (path: string) => outcome("read", { path }, "fn main() {}\n");

		it("compares with a run started when the agent read the file, not one before the edit", async () => {
			write("errors.txt", `${E0425}\n`);
			write("src/a.rs", "");
			const { module, logs } = setup({ checks, builtinChecks: false });
			await deliver(module, read("src/a.rs"));
			await settle();
			// The old error moved down two lines; a new one appeared in another file.
			write("errors.txt", `${E0425.replace("3:5", "5:5")}\n${E0308}\n`);
			const result = await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok"));
			expect(result?.text).toContain(
				"cat errors.txt; test ! -s errors.txt reports a new error after this change:\nerror[E0308]: mismatched types\n  --> src/b.rs:9:1",
			);
			expect(result?.text).not.toContain("E0425");
			expect(logs).toEqual([]);
		});

		it("with nothing to compare with, shows the errors that name the edited file and says what it left out", async () => {
			write("errors.txt", `${E0425}\n${E0308}\n`);
			write("src/a.rs", "");
			const { module, logs } = setup({ checks, builtinChecks: false });
			const result = await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok"));
			expect(result?.text).toContain(
				"reports an error in src/a.rs (it had not run before, so some may predate this change)",
			);
			expect(result?.text).toContain("E0425");
			expect(result?.text).not.toContain("E0308");
			// Routine, not a problem for the user.
			expect(logs).toEqual([]);
		});

		it("compares each edit of a turn with the one before it", async () => {
			write("errors.txt", "");
			write("src/a.rs", "");
			write("src/b.rs", "");
			const { module } = setup({ checks, builtinChecks: false });
			await deliver(module, read("src/a.rs"));
			await settle();
			// Pi asks about every call of a turn before it runs any of them.
			await module.beforeToolCall?.({ toolName: "edit", toolCallId: "1", input: { path: "src/a.rs" } }, signal);
			await module.beforeToolCall?.({ toolName: "edit", toolCallId: "2", input: { path: "src/b.rs" } }, signal);
			write("errors.txt", `${E0425}\n`);
			expect((await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok")))?.text).toContain("E0425");
			write("errors.txt", `${E0425}\n${E0308}\n`);
			const second = await deliver(module, outcome("edit", { path: "src/b.rs" }, "ok"));
			expect(second?.text).toContain("reports a new error after this change:");
			expect(second?.text).toContain("E0308");
			expect(second?.text).not.toContain("E0425");
		});

		it("after a shell command that may change files, compares with a run started by the next read, never during a command", async () => {
			write("errors.txt", "");
			write("src/a.rs", "");
			const { module } = setup({ checks, builtinChecks: false });
			await deliver(module, read("src/a.rs"));
			await settle();
			expect(await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok"))).toBeUndefined();
			// A generator wrote a broken file: that error is not the next edit's doing.
			const generate = outcome("bash", { command: "./generate.sh" }, "");
			await module.beforeToolCall?.({ toolName: "bash", toolCallId: "g", input: generate.input }, signal);
			// A read while the command runs starts no check: it would compete with the command's build.
			write("errors.txt", `${E0308}\n`);
			await deliver(module, read("src/a.rs"));
			await settle();
			write("errors.txt", `${E0425}\n`);
			await deliver(module, generate);
			await deliver(module, read("src/a.rs"));
			await settle();
			// Looking changes nothing: the result from after the generator still holds.
			await deliver(module, outcome("bash", { command: "git diff | head -50 2>&1" }, ""));
			expect(await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok"))).toBeUndefined();
		});

		it("starts no background check while a command that may change files runs", async () => {
			write("src/a.rs", "");
			const counted = [{ files: "*.rs", command: "echo run >> runs.txt" }];
			const { module } = setup({ checks: counted, builtinChecks: false });
			await module.beforeToolCall?.({ toolName: "bash", toolCallId: "b", input: { command: "cargo build" } }, signal);
			await deliver(module, read("src/a.rs"));
			await settle();
			expect(existsSync(join(dir, "runs.txt"))).toBe(false);
			// The command ended: a shell command starts none either; the next read does.
			await deliver(module, outcome("bash", { command: "cargo build" }, ""));
			await settle();
			expect(existsSync(join(dir, "runs.txt"))).toBe(false);
			await deliver(module, read("src/a.rs"));
			await settle();
			expect(readFileSync(join(dir, "runs.txt"), "utf8")).toBe("run\n");
		});

		it("counts an edit whose own check never ran into the next one", async () => {
			write("errors.txt", "");
			write("src/a.rs", "");
			const { module } = setup({ checks, builtinChecks: false });
			await deliver(module, read("src/a.rs"));
			await settle();
			// The first edit's result was never offered for rewriting (its budget ran out).
			module.onToolResult?.(outcome("edit", { path: "src/a.rs" }, "ok"));
			write("errors.txt", `${E0425}\n`);
			const result = await deliver(module, outcome("edit", { path: "src/a.rs" }, "ok"));
			expect(result?.text).toContain("reports a new error after this change and 1 earlier edit:");
		});
	});

	it("reads a linter's failure that has no error line, and caps what it shows with a count (D-110)", async () => {
		write("a.py", "");
		const ruff = Array.from({ length: 5 }, (_, i) => `a.py:${i + 1}:8: F401 [*] \`m${i}\` imported but unused`);
		write("ruff.txt", `${ruff.join("\n")}\nFound 5 errors.\n`);
		const checks = [{ files: "*.py", command: "cat ruff.txt; exit 1" }];
		const { module, logs } = setup({ checks, maxDiagnosticLines: 3 });
		const result = await deliver(module, outcome("edit", { path: "a.py" }, "ok"));
		expect(result?.text).toContain(
			`${ruff.slice(0, 3).join("\n")}\n[… 2 more errors; run \`cat ruff.txt; exit 1\` to see all]`,
		);
		expect(result?.text).not.toContain("Found 5 errors");
		expect(logs.join("\n")).toContain("failed but no errors could be read");
	});

	it("stops trying a checker that is not installed", async () => {
		write("a.rs", "");
		const checks = [{ files: "*.rs", command: "exo-no-such-checker {file}" }];
		const { module, logs } = setup({ checks });
		expect(await deliver(module, outcome("edit", { path: "a.rs" }, "ok"))).toBeUndefined();
		expect(logs.join("\n")).toContain("not installed, not tried again: exo-no-such-checker 'a.rs'");
	});

	it("sends what a check slower than its hold finds as late help, unless something made it stale (D-098)", async () => {
		const E0308 = "error[E0308]: mismatched types\n  --> src/b.rs:9:1";
		const E0425 = "error[E0425]: cannot find value `x` in this scope\n  --> a.rs:3:5";
		write("a.rs", "");
		write("errors.txt", "");
		// A stand-in for a slow `cargo check`: slow once the marker file exists.
		const command = "if [ -f slow ]; then sleep 0.6; fi; cat errors.txt; test ! -s errors.txt";
		const checks = [{ files: "*.rs", command }];
		const { module, late, records, logs } = setup({ checks, checkHoldMs: 200 });
		await deliver(module, outcome("read", { path: "a.rs" }, ""));
		await settle();
		write("slow", "");
		write("errors.txt", `${E0308}\n`);
		// The edit's result goes back after the hold, without the check.
		expect(await deliver(module, outcome("edit", { path: "a.rs" }, "ok"))).toBeUndefined();
		// Reading and printing do not make it stale.
		await deliver(module, outcome("bash", { command: "cat errors.txt" }, ""));
		await settle(900);
		expect(logs).toEqual([]);
		expect(late).toEqual([`[exo tools] ${command} reports a new error after your edit to a.rs:\n${E0308}`]);
		expect(module.status?.()).toContain("1 new error(s) shown");
		expect(records).toEqual([]);

		// A shell command starting before the check ends stops it: the check would compete with
		// the command's build, and its result would mix the command's changes in. Nothing is logged.
		write("errors.txt", `${E0308}\n${E0425}\n`);
		await deliver(module, outcome("edit", { path: "a.rs" }, "ok"));
		await module.beforeToolCall?.({ toolName: "bash", toolCallId: "b", input: { command: "cargo build" } }, signal);
		await settle(900);
		expect(late).toHaveLength(1);
		module.onToolResult?.(outcome("bash", { command: "cargo build" }, ""));
		expect(logs).toEqual([]);
	});

	it("does not wait for a check that usually takes longer than its hold (D-110)", async () => {
		write("a.sh", "echo hi\n");
		const checks = [{ files: "*.sh", command: "sleep 0.3; bash -n {file}" }];
		const { module, late } = setup({ checks, checkHoldMs: 200 });
		for (let i = 0; i < 3; i++) {
			await deliver(module, outcome("edit", { path: "a.sh" }, "ok"));
			await settle(500);
		}
		write("a.sh", "if then\n");
		const started = Date.now();
		expect(await deliver(module, outcome("edit", { path: "a.sh" }, "ok"))).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(150);
		await settle(600);
		expect(late.join("\n")).toContain("a new error after your edit to a.sh");
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
