import "./home-guard.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExoModule, runShellCommand, type ToolOutcome, type UserTurnContext } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anchorOf, cardDetail, detailShare, failureOf } from "../src/detail.ts";
import { createEpisodeTracker } from "../src/episodes.ts";
import { createMemory } from "../src/memory.ts";
import { recall } from "../src/recall.ts";
import { runOf } from "../src/runs.ts";
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

const bash = (command: string): ToolOutcome => ({ ...pass(command), output: "" });

function draft(tool: ToolOutcome) {
	return { ...tool, toolCallId: "c", current: tool.output, fullOutputPath: null, status: null };
}

type Embed = (texts: readonly string[]) => number[][] | undefined;

const LESSON = {
	lesson: "In lib.rs, clone the value before pushing onto `self.stack`.",
	applies_when: "pushing while borrowed",
};
const LESSON_TEXT = `${LESSON.lesson} (when: ${LESSON.applies_when})`;
/** The selection sidecar's answer when every preference shown fits. */
const ALL = { apply: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
/** The selection sidecar's prompt (`preference-select`). */
const isSelect = (prompt: string) => prompt.includes("Pick the preferences the agent should be reminded of");

/** The relation sidecar's prompt (`preference-relate`), as against the one that reads a message. */
const isRelate = (prompt: string) => prompt.includes("They have just stated one.");
const UNRELATED = { same: 0, contradicts: [] };
/** Both of a message's sidecar steps: what it states, and how that stands with what is known. */
const reads =
	(statement: SidecarReply, relation: SidecarReply = UNRELATED) =>
	(prompt: string) =>
		isRelate(prompt) ? relation : statement;
/** Background learning is done when a while passes without a new request or record. */
async function drained(t: { requests: unknown[]; records: unknown[]; logs: unknown[] }): Promise<void> {
	const size = () => t.requests.length + t.records.length + t.logs.length;
	for (let seen = -1; seen !== size(); ) {
		seen = size();
		await new Promise((r) => setTimeout(r, 25));
	}
}

let sessions = 0;

/** One module instance in a harness session of its own, as a later `pi` run would be. */
function setup(settings: Record<string, unknown> = {}, reply?: (prompt: string) => SidecarReply, embed?: Embed) {
	const t = createTestModuleContext({
		cwd: dir,
		sessionId: `session-${++sessions}`,
		...(reply ? { reply: (r) => reply(String(r.messages[0]?.["content"])) } : {}),
		...(embed ? { embed } : {}),
	});
	const built = createMemory({ dbPath, ...settings }, t.context);
	const memory: ExoModule = {
		...built,
		// As the host does: every module hears of the stop before any acts on it (D-106).
		onSettle: async (info, signal) => {
			built.onSettled?.(info);
			return built.onSettle?.(info, signal);
		},
		// A rewrite is taken as shown to the agent: the host commits what it hands to the harness (D-078).
		rewriteToolResult: async (tool, signal) => {
			const rewrite = await built.rewriteToolResult?.(tool, signal);
			rewrite?.commit?.();
			return rewrite;
		},
	};
	return { t, memory };
}

async function until(predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe("episode tracker", () => {
	it("emits a fix only for fail → edit → pass of the same runner", () => {
		const tracker = createEpisodeTracker({ cwd: dir, minDetail: 0.6 });
		expect(tracker.observe(fail())).toEqual([]);
		expect(tracker.observe(edit)).toEqual([]);
		// Another runner's pass says nothing about this failure.
		expect(tracker.observe(pass("cargo test"))).toEqual([]);
		// Redirecting the output does not make it another run.
		const episodes = tracker.observe(pass("cargo build 2>&1"));
		expect(episodes).toMatchObject([
			{
				command: "cargo build",
				passCommand: "cargo build 2>&1",
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

	it("ignores passes without edits and commands that are not test or build runs", () => {
		const tracker = createEpisodeTracker({ cwd: dir, minDetail: 0.6 });
		tracker.observe(fail());
		expect(tracker.observe(pass())).toEqual([]);
		for (const command of ["grep -r foo .", "node scripts/x.js", "npm install"]) {
			tracker.observe(fail(command, "error: nope"));
			tracker.observe(edit);
			expect(tracker.observe(pass(command))).toEqual([]);
		}
	});

	it("keeps an open failure through a run whose output names no error (D-109)", () => {
		const tracker = createEpisodeTracker({ cwd: dir, minDetail: 0.6 });
		tracker.observe(fail());
		tracker.observe(edit);
		tracker.observe(fail("cargo build", "no error line here"));
		expect(tracker.observe(pass()).map((e) => e.errorLine)).toEqual([
			"error[E0502]: cannot borrow `self.stack` as mutable",
		]);
	});

	it("is one failure whatever the exit code or the pipe, so a piped retry is not a new problem (D-109)", () => {
		const tracker = createEpisodeTracker({ cwd: dir, minDetail: 0.6 });
		const failing = `test stack_push ... FAILED\n${ERROR}`;
		tracker.observe(fail("cargo test", failing));
		tracker.observe(edit);
		// The same error behind a pipe: exit code 0, read as failed from its output.
		tracker.observe({ ...fail("cargo test 2>&1 | tail -20", failing), isError: false, exitCode: 0 });
		tracker.observe(edit);
		const [episode] = tracker.observe({ ...pass("cargo test 2>&1 | tail -5"), output: "test result: ok. 1 passed" });
		expect(episode?.steps).toHaveLength(1);
		expect(episode?.steps[0]?.retries).toBe(1);
	});

	it("keeps the first error when the error changes, and gives an episode for it and for the last (D-072)", () => {
		const tracker = createEpisodeTracker({ cwd: dir, minDetail: 0.6 });
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
		const tracker = createEpisodeTracker({ cwd: dir, minDetail: 0.6 });
		tracker.observe(fail());
		tracker.observe(fail("cargo build", "error[E0308]: mismatched types"));
		tracker.observe(edit);
		expect(tracker.observe(pass()).map((e) => e.errorLine)).toEqual(["error[E0308]: mismatched types"]);
	});

	describe("a pass closes a failure of its runner that it covers (D-109)", () => {
		const PYTEST = [
			"___________________________________ test_one ___________________________________",
			">       assert add(1, 2) == 4",
			"E       assert 3 == 4",
			"tests/test_x.py:5: AssertionError",
			"___________________________________ test_two ___________________________________",
			"E       AssertionError: assert 'hi bob' == 'hello bob'",
			"=========================== short test summary info ============================",
			"FAILED tests/test_x.py::test_one - assert 3 == 4",
			"FAILED tests/test_x.py::test_two - AssertionError: assert 'hi bob' == 'hello bob'",
			"========================= 2 failed, 1 passed in 0.03s ==========================",
		].join("\n");
		const fixFor = (passing: ToolOutcome, failing = fail("pytest", PYTEST)) => {
			const tracker = createEpisodeTracker({ cwd: dir, minDetail: 0.6 });
			tracker.observe(failing);
			tracker.observe(edit);
			return tracker.observe(passing);
		};
		const passed = (command: string, output = "1 passed in 0.01s") => ({ ...pass(command), output });

		it("a whole run, or one narrowed to the failing test, closes it", () => {
			expect(fixFor(passed("python -m pytest -q 2>&1 | tail -3"))).toHaveLength(1);
			expect(fixFor(passed("pytest tests/test_x.py::test_one"))).toMatchObject([
				{ command: "pytest", passCommand: "pytest tests/test_x.py::test_one", detail: ["test_one"] },
			]);
			// The output names it, though the command line does not.
			expect(fixFor(passed("pytest tests/", "tests/test_x.py::test_one PASSED"))).toHaveLength(1);
			// Narrowed the same way as the run that failed.
			const narrowed = fail("pytest -k one", PYTEST.split("\n").slice(0, 4).join("\n"));
			expect(fixFor(passed("pytest -k one"), narrowed)).toHaveLength(1);
		});

		it("a run of other tests, or of another runner, does not", () => {
			expect(fixFor(passed("pytest tests/test_y.py::test_three"))).toEqual([]);
			expect(fixFor(passed("pytest -k three"))).toEqual([]);
			expect(fixFor(passed("cargo test"))).toEqual([]);
			expect(fixFor(passed("cd other && pytest"))).toEqual([]);
		});

		it("stays open through a narrowed pass of other tests, for the whole run that follows", () => {
			const tracker = createEpisodeTracker({ cwd: dir, minDetail: 0.6 });
			tracker.observe(fail("pytest", PYTEST));
			tracker.observe(edit);
			expect(tracker.observe(passed("pytest -k three"))).toEqual([]);
			expect(tracker.observe(passed("pytest"))).toHaveLength(1);
		});
	});

	it("follows a fix across many reads and the user's messages, and lets go after many edits and runs (D-109)", () => {
		const tracker = createEpisodeTracker({ cwd: dir, minDetail: 0.6 });
		tracker.observe(fail());
		for (let i = 0; i < 100; i++) tracker.observe(bash("cat lib.rs"));
		tracker.observe(edit);
		expect(tracker.observe(pass())).toHaveLength(1);

		tracker.observe(fail());
		for (let i = 0; i < 50; i++) tracker.observe(i % 2 ? edit : pass("cargo test"));
		expect(tracker.observe(pass())).toEqual([]);
	});
});

describe("failure detail (D-072, D-109)", () => {
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
	const detailOf = (output: string) => cardDetail(output, anchorOf(output)?.index ?? 0);

	it("keeps the names a failure mentions and drops what every failure prints", () => {
		expect(detailOf(TABLE)).toEqual(["simple_table", "render"]);
		expect(detailOf("all good")).toEqual([]);
	});

	it("tells two failures with one key apart, and finds a card's problem further down the output", () => {
		const table = detailOf(TABLE);
		expect(detailShare(table, failureOf("bash", INI).names)).toBe(0);
		const later = `thread 'aaa' (1) panicked at tests/other.rs:1:1:\n${TABLE}`;
		expect(detailShare(table, failureOf("bash", later).names)).toBe(1);
		expect(detailShare([], new Set())).toBe(1);
	});

	it("takes a card's names from its own failure, not from the others in the output", () => {
		const cargo = [
			"test simple_table ... FAILED",
			"test other_one ... FAILED",
			"",
			"---- simple_table stdout ----",
			"thread 'simple_table' panicked at tests/render.rs:8:5:",
		].join("\n");
		expect(detailOf(cargo)).toEqual(["simple_table"]);
		const rustc =
			"error[E0502]: cannot borrow `self.stack` as mutable\n  --> lib.rs:4:9\n\nerror[E0308]: mismatched types";
		expect(detailOf(rustc)).toEqual(["stack", "e0502"]);
		// pytest's heading names the test its assertion lines do not.
		const pytest =
			"______ test_one ______\n>       assert add(1, 2) == 4\nE       assert 3 == 4\n______ test_two ______";
		expect(detailOf(pytest)).toEqual(["test_one"]);
	});

	it("leaves out assertion data and temporary paths, and keeps a quoted name", () => {
		expect(detailOf("E       AssertionError: assert 'hi bob' == 'hello_bob'")).toEqual(["hello_bob"]);
		expect(
			detailOf("FAILED tests/test_io.py::test_write - FileNotFoundError: '/tmp/pytest-of-u/pytest-12/test_write0/x'"),
		).toEqual(["test_io", "test_write", "filenotfounderror"]);
		expect(detailOf("ModuleNotFoundError: No module named 'yaml'")).toEqual(["yaml", "modulenotfounderror"]);
	});

	it("keys a failure by every failure line, without the exit code, and anchors it past boilerplate", () => {
		const crash =
			"Traceback (most recent call last):\n  File \"app.py\", line 3\nModuleNotFoundError: No module named 'yaml'";
		expect(anchorOf(crash)?.line).toBe("ModuleNotFoundError: No module named 'yaml'");
		expect([...failureOf("bash", crash).keys]).toEqual(["bash|ModuleNotFoundError: No module named <str>"]);
		expect([...failureOf("bash", "all good").keys]).toEqual([]);
	});
});

describe("runOf (D-109)", () => {
	it("names a run by its runner, past cd, wrappers, pipes and what it was narrowed to", () => {
		expect(runOf("cd app && cargo test simple_table 2>&1 | tail -30", dir)).toEqual({
			runner: "cd app && cargo test",
			filters: ["simple_table"],
			verifying: true,
		});
		expect(runOf("python -m pytest tests/test_x.py::test_one -x", dir)).toMatchObject({
			runner: "pytest",
			filters: ["tests/test_x.py::test_one"],
		});
		expect(runOf("uv run pytest -q", dir)).toMatchObject({ runner: "pytest", filters: [] });
		expect(runOf("go test ./...", dir)).toMatchObject({ runner: "go test", filters: [] });
		expect(runOf("go test -run TestA ./...", dir)).toMatchObject({ runner: "go test", filters: ["TestA"] });
		expect(runOf("npm run test -- -t foo", dir)).toMatchObject({ runner: "npm run test", filters: ["foo"] });
		expect(runOf("npx vitest run src/a.test.ts", dir)).toMatchObject({
			runner: "vitest run",
			filters: ["src/a.test.ts"],
		});
		expect(runOf("pnpm test", dir)).toMatchObject({ runner: "pnpm test", filters: [] });
		expect(runOf("make -C app test", dir)).toMatchObject({ runner: "make -C app test", filters: [] });
		expect(runOf("go test -run 'TestA|TestB' ./... | tail", dir)).toMatchObject({ filters: ["TestA|TestB"] });
	});

	it("takes any other command whole, and as no test or build run", () => {
		expect(runOf("npm install 2>&1", dir)).toEqual({ runner: "npm install", filters: [], verifying: false });
		expect(runOf("node x.js", dir)).toMatchObject({ verifying: false });
		expect(runOf("  ", dir)).toBeUndefined();
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
		const { memory, t } = setup({}, () => LESSON);
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

		// A later session's failure recalls it, piped or not; the harness's reading counts too.
		const later = setup();
		const recalled = await later.memory.rewriteToolResult?.(draft(piped(failing)), signal);
		expect(recalled?.text).toContain("exo memory");
		const unpiped = setup();
		expect(await unpiped.memory.rewriteToolResult?.(draft(fail("cargo test", failing)), signal)).toBeDefined();
		const viaHarness = setup();
		expect(await viaHarness.memory.rewriteToolResult?.(draft(piped("1 failing", "unknown")), signal)).toBeUndefined();
	});

	it("learns a grounded lesson from a verified fix and recalls it in a later session", async () => {
		const { memory, t } = setup({}, () => LESSON);
		memory.onUserTurn?.({ text: "make it build", origin: "user" });
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await until(() => t.records.some((r) => r.kind === "exo.memory"));
		expect(t.records.at(-1)?.data).toMatchObject({ action: "learned" });
		expect(t.requests[0]?.messages[0]?.["content"]).toContain("let v = x.clone()");
		// The lesson thinks (D-105, D-106).
		expect(t.requests[0]?.thinking).toBe(true);

		const later = setup();
		const rewrite = await later.memory.rewriteToolResult?.(
			draft(fail("cargo build", ERROR.replace("4:9", "9:1"))),
			signal,
		);
		expect(rewrite?.text).toContain("check a note against the current code before relying on it.]");
		expect(rewrite?.text).toContain(`- (this error, this repo; the fix edited lib.rs) ${LESSON_TEXT}`);
		expect(later.memory.status?.()).toMatch(/memory \(1 cards · 0 learned · 1 recalled\)/);
		// Recalled once per session.
		expect(await later.memory.rewriteToolResult?.(draft(fail()), signal)).toBeUndefined();
	});

	it("follows a fix across the user's messages and a narrowed pass (D-109)", async () => {
		const { memory, t } = setup({}, () => LESSON);
		memory.onUserTurn?.({ text: "make it build", origin: "user" });
		memory.onToolResult?.(fail("cargo test", "test stack_push ... FAILED\nerror[E0502]: cannot borrow `self.stack`"));
		await memory.onSettle?.({ outcome: "completed", lastAssistantText: "Should I change the API?" }, signal);
		memory.onUserTurn?.({ text: "no, change the caller", origin: "user" });
		memory.onToolResult?.(edit);
		memory.onToolResult?.({ ...pass("cargo test stack_push 2>&1 | tail -3"), output: "test result: ok. 1 passed" });
		await until(() => t.records.some((r) => r.kind === "exo.memory"));
		expect(t.records.at(-1)?.data).toMatchObject({ action: "learned" });
	});

	it("finds a card whose problem is not the first error in the output (D-109)", async () => {
		const { memory, t } = setup({}, () => LESSON);
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await until(() => t.records.length > 0);
		const both = `error[E0308]: mismatched types\n  --> src/a.rs:1:1\n\n${ERROR}`;
		expect((await setup().memory.rewriteToolResult?.(draft(fail("cargo build", both)), signal))?.note).toBe(
			"recalled 1 card(s)",
		);
	});

	it("credits a card by what its run did next (D-109 order)", async () => {
		const { memory, t } = setup({}, () => LESSON);
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await until(() => t.records.length > 0);
		const credited = (s: ReturnType<typeof setup>) =>
			s.t.records.flatMap((r) => {
				const data = r.data as { action?: string; outcome?: string };
				return data.action === "credited" ? [data.outcome] : data.action === "credit_withheld" ? ["withheld"] : [];
			});

		// One more failure, an edit where the card pointed, then the run passes: the card helped.
		const helped = setup();
		await helped.memory.rewriteToolResult?.(draft(fail()), signal);
		helped.memory.onToolResult?.(fail());
		helped.memory.onToolResult?.(edit);
		helped.memory.onToolResult?.(pass());
		expect(credited(helped)).toEqual(["helped"]);

		// It took more than one try: still helped.
		const slow = setup();
		await slow.memory.rewriteToolResult?.(draft(fail()), signal);
		for (const tool of [edit, fail(), edit, fail(), pass("cargo build 2>&1")]) slow.memory.onToolResult?.(tool);
		expect(credited(slow)).toEqual(["helped"]);

		// It passed without the card's files being touched: withheld.
		const other = setup();
		await other.memory.rewriteToolResult?.(draft(fail()), signal);
		other.memory.onToolResult?.(pass());
		expect(credited(other)).toEqual(["withheld"]);

		// The problem came back and the run never passed: hurt, once the session ends.
		const hurt = setup();
		await hurt.memory.rewriteToolResult?.(draft(fail()), signal);
		hurt.memory.onToolResult?.(fail());
		hurt.memory.onUserTurn?.({ text: "next", origin: "user" });
		await hurt.memory.onSettle?.({ outcome: "completed", lastAssistantText: "" }, signal);
		expect(credited(hurt)).toEqual([]);
		await hurt.memory.dispose?.();
		expect(credited(hurt)).toEqual(["hurt"]);

		// … or once the agent has run other tests for a while.
		const moved = setup();
		await moved.memory.rewriteToolResult?.(draft(fail()), signal);
		moved.memory.onToolResult?.(fail());
		for (let i = 0; i < 8; i++) moved.memory.onToolResult?.(pass("cargo test"));
		expect(credited(moved)).toEqual(["hurt"]);

		// It failed with another problem and never ran again: no evidence either way.
		const unknown = setup();
		await unknown.memory.rewriteToolResult?.(draft(fail()), signal);
		unknown.memory.onToolResult?.(fail("cargo build", "error[E0502]: cannot borrow `other.queue` as immutable"));
		unknown.memory.onToolResult?.(pass("cargo test"));
		await unknown.memory.dispose?.();
		expect(credited(unknown)).toEqual([]);

		const cards = openMemoryStore(dbPath).cards();
		expect(cards[0]).toMatchObject({ injected: 6, helped: 2, hurt: 2 });
		expect(cards[0]?.lesson).toBe(LESSON_TEXT);
	});

	it("credits a card when a run narrowed to its test passes, and not for a run of other tests (D-109)", async () => {
		const failing = [
			"______ test_one ______",
			"E       assert 3 == 4",
			"lib.rs:5: AssertionError",
			"FAILED tests/test_x.py::test_one - assert 3 == 4",
		].join("\n");
		const { memory, t } = setup({}, () => LESSON);
		memory.onToolResult?.(fail("pytest", failing));
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass("pytest"));
		await until(() => t.records.length > 0);

		const s = setup();
		await s.memory.rewriteToolResult?.(draft(fail("python -m pytest -q", failing)), signal);
		s.memory.onToolResult?.(edit);
		s.memory.onToolResult?.(pass("pytest tests/test_y.py::test_three"));
		expect(s.t.records.map((r) => (r.data as { action: string }).action)).toEqual(["recalled"]);
		s.memory.onToolResult?.(pass("uv run pytest tests/test_x.py::test_one"));
		expect(s.t.records.at(-1)?.data).toMatchObject({ action: "credited", outcome: "helped" });
	});

	it("keeps a card per problem when two problems share a key, and recalls only the one that failed (D-072)", async () => {
		const STACK = "error[E0502]: cannot borrow `self.stack` as mutable\n  --> lib.rs:4:9";
		const QUEUE = "error[E0502]: cannot borrow `jobs.queue` as immutable\n  --> lib.rs:40:9";
		const { memory, t } = setup({}, () => LESSON);
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
		// A third problem of the same kind names neither card's things: the key alone recalls nothing.
		const third = "error[E0502]: cannot borrow `cache.entries` as mutable\n  --> lib.rs:90:9";
		expect(await setup().memory.rewriteToolResult?.(draft(fail("cargo build", third)), signal)).toBeUndefined();
		expect(
			recall(store, "elsewhere", failureOf("bash", third), third, { maxCards: 2, minOverlap: 0.6, minDetail: 0 }),
		).toEqual([]);
	});

	it("recalls a problem fixed in two other repos, and says where it comes from", () => {
		const store = openMemoryStore(dbPath);
		const output = "ModuleNotFoundError: No module named 'yaml'";
		const failure = failureOf("bash", output);
		const keys = [...failure.keys];
		const base = { signature: keys[0] ?? "", detail: cardDetail(output, 0), files: ["setup.cfg"], trigger: output };
		store.add({ ...base, scope: "repo-a", lesson: "Install pyyaml.", evidence: "{}" });
		const settings = { maxCards: 2, minOverlap: 0.6, minDetail: 0.6 };
		expect(recall(store, "repo-z", failure, output, settings)).toEqual([]);
		store.add({ ...base, scope: "repo-b", lesson: "Add pyyaml to the dev requirements.", evidence: "{}" });
		expect(recall(store, "repo-z", failure, output, settings).map((r) => r.match)).toEqual(["elsewhere", "elsewhere"]);
		// The same key, another module.
		const other = "ModuleNotFoundError: No module named 'requests'";
		expect([...failureOf("bash", other).keys]).toEqual(keys);
		expect(recall(store, "repo-z", failureOf("bash", other), other, settings)).toEqual([]);
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
		expect(first).toContain("1. The run failed:");
		expect(first).toContain("(The run failed with this same error 1 more time(s) during these edits.)");
		expect(first).toContain("2. The run then failed with a different error:");
		expect(first).toContain("3. Then this run passed: cargo build");
		expect(String(t.requests[1]?.messages[0]?.["content"])).toContain("2. Then this run passed: cargo build");
	});

	it("keeps a lesson that names unknown things, with those names as plain words (D-109)", async () => {
		const { memory, t } = setup({}, () => ({
			lesson: "Call `rebalance_tree` in src/tree.rs first.",
			applies_when: "",
		}));
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await until(() => t.records.some((r) => r.kind === "exo.memory"));
		expect(t.records.at(-1)?.data).toMatchObject({
			action: "learned",
			lesson: "Call rebalance_tree in src/tree.rs first.",
			ungrounded: ["rebalance_tree", "src/tree.rs"],
		});
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

	it("learns nothing without a sidecar engine, and says so once (D-109)", async () => {
		const { memory, t } = setup();
		for (let i = 0; i < 2; i++) {
			memory.onToolResult?.(fail());
			memory.onToolResult?.(edit);
			memory.onToolResult?.(pass());
		}
		await until(() => t.records.length === 2);
		expect(t.records.map((r) => (r.data as { reason?: string }).reason)).toEqual(["no_engine", "no_engine"]);
		expect(t.logs.filter((l) => l.startsWith("no sidecar engine"))).toHaveLength(1);
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

	it("keeps the valid settings beside an invalid one, the store's path above all", async () => {
		const { t, memory } = setup({ maxCards: 99, minDetail: "high", distill: false }, () => LESSON);
		expect(t.logs.filter((l) => l.startsWith("memory /"))).toHaveLength(2);
		memory.onToolResult?.(fail());
		memory.onToolResult?.(edit);
		memory.onToolResult?.(pass());
		await until(() => t.records.length > 0);
		// Learned into the store the settings named; a retired setting is not an error.
		expect(openMemoryStore(dbPath).cards()).toHaveLength(1);
	});

	it("reports invalid settings", () => {
		const { t } = setup({ maxCards: 99 });
		expect(t.logs.some((l) => l.startsWith("memory /maxCards"))).toBe(true);
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
				holds: "task",
				applies_to: "any",
				correction: false,
				...extra,
			},
		],
	});
	const actions = (t: { records: { data: unknown }[] }) => t.records.map((r) => (r.data as { action: string }).action);

	/** One session: the user says `text`, the agent settles, the sidecars answer `reply` and `relation`. */
	async function session(text: string, reply: SidecarReply, relation?: SidecarReply) {
		const s = setup({ preferences: true }, reads(reply, relation));
		s.memory.onUserTurn?.({ text, origin: "user" });
		await s.memory.onSettle?.(DONE, signal);
		await until(() => s.t.requests.length > 0);
		await drained(s.t);
		return s;
	}
	const ask = (memory: ReturnType<typeof createMemory>, text: string, origin: "user" | "suggestion" = "user") =>
		shown(memory.contextForUserTurn?.({ text, origin }, signal));

	it("learns a standing rule from the user's words and adds it to a later prompt that leaves it unsaid", async () => {
		const first = await session(
			"Add a parser for dates. And always write the failing test first, please.",
			proposal({ quote: "always write the failing test first", holds: "standing" }),
		);
		expect(actions(first.t)).toEqual(["preference_learned"]);
		// Nothing is known yet, so there is nothing to relate it to.
		expect(first.t.requests).toHaveLength(1);

		// The selection sidecar leaves it out of a message that is not a task, and of one that says it.
		const { memory, t } = setup({ preferences: true }, (prompt) =>
			/thanks a lot|write the failing test before/.test(prompt.split("Developer's request:")[1] ?? "")
				? { apply: [] }
				: ALL,
		);
		expect(await ask(memory, "thanks a lot")).toBeUndefined();
		expect(await ask(memory, "Add durations, and write the failing test before the implementation")).toBeUndefined();
		expect(await ask(memory, "Not done yet. Please finish the README.", "suggestion")).toBeUndefined();
		expect(t.requests).toHaveLength(2);
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

		// Said again elsewhere, in other words: the relation sidecar recognises it.
		const reworded = proposal({ rule: "Work test-first.", quote: "Write the tests first" });
		const second = await session(said, reworded, { same: 1, contradicts: [] });
		expect(actions(second.t)).toEqual(["preference_seen"]);
		const asked = String(second.t.requests[1]?.messages[0]?.["content"]);
		expect(asked).toContain(`Known preferences:\n1. ${TDD}`);
		expect(asked).toContain("<<<\nWork test-first.\n>>>");
		expect(asked).toContain("<<<\nWrite the tests first\n>>>");
		// With no answer about what it repeats or contradicts, it is not stored on a guess.
		const unanswered = await session(said, reworded, new Error("down"));
		expect(unanswered.t.records.map((r) => r.data)).toEqual([
			{ action: "preference_skipped", reason: "relation_unknown" },
		]);
		expect(unanswered.t.logs.some((l) => l.startsWith("preference relation "))).toBe(true);
		expect(await ask(setup({ preferences: true }, () => ALL).memory, "Add a function that parses durations")).toContain(
			`- ${TDD} (said in 2 sessions)`,
		);
	});

	it("admits only what the user said: no invented quotes, exceptions or unknown names", async () => {
		const text = "Fix the date parser. Skip the tests this time, and keep the change small.";
		for (const [item, reason] of [
			[{ quote: "always write tests before code" }, "not_said"],
			[{ quote: "Skip the tests this time", rule: "Do not write tests.", holds: "exception" }, "exception"],
			[{ quote: "keep the change small", rule: "Keep changes small and update `docs/STYLE.md`." }, "ungrounded"],
			[{ quote: "keep the change small", rule: "x" }, "rule_length"],
		] as const) {
			const s = await session(text, proposal(item));
			// Each refusal is traced with its reason, so the gates can be measured.
			expect(s.t.records.map((r) => r.data)).toEqual([{ action: "preference_skipped", reason }]);
		}
		expect(openMemoryStore(dbPath).preferences()).toEqual([]);
	});

	const standingTdd = () =>
		session(
			"From now on write the failing test first.",
			proposal({ quote: "write the failing test first", holds: "standing" }),
		);
	const NO_TDD = "Do not write the tests before the implementation.";
	const AGAINST_TDD = { same: 0, contradicts: [1] };

	it("retires a preference the user withdraws, but not for an exception", async () => {
		await standingTdd();
		const exception = await session(
			"Skip the tests this time, just patch the config file quickly.",
			proposal({ rule: "Do not write tests.", quote: "Skip the tests this time", holds: "exception" }),
			AGAINST_TDD,
		);
		expect(actions(exception.t)).toEqual(["preference_skipped"]);
		// A withdrawal is a statement of what the user wants now, and it contradicts the old rule.
		const withdrawn = await session(
			"Stop writing tests first, I do not want that anymore.",
			proposal({ rule: NO_TDD, quote: "Stop writing tests first", holds: "standing" }),
			AGAINST_TDD,
		);
		expect(withdrawn.t.records.map((r) => r.data)).toEqual([
			{ action: "preference_learned", preference: 2, rule: NO_TDD },
			{ action: "preference_retired", preference: 1, by: "model" },
		]);
		const later = await ask(setup({ preferences: true }, () => ALL).memory, "Add a function that parses durations");
		expect(later).toContain(`- ${NO_TDD}`);
		expect(later).not.toContain(TDD);
	});

	it("does not undo a preference for one task's instruction, and does once it is said again", async () => {
		await standingTdd();
		const said = "Write the tests after the code for this parser.";
		const once = () => session(said, proposal({ rule: NO_TDD, quote: "Write the tests after the code" }), AGAINST_TDD);
		expect((await once()).t.records.map((r) => r.data)).toEqual([
			{ action: "preference_learned", preference: 2, rule: NO_TDD },
			{ action: "preference_conflict", preference: 2, with: 1 },
		]);
		expect(await ask(setup({ preferences: true }, () => ALL).memory, "Add a function that parses durations")).toContain(
			TDD,
		);
		// A second session makes it a preference (D-060): now it replaces the one it contradicts.
		const again = await session(said, proposal({ rule: NO_TDD, quote: "Write the tests after the code" }), {
			same: 2,
			contradicts: [1],
		});
		expect(actions(again.t)).toEqual(["preference_seen", "preference_retired"]);
		expect(
			openMemoryStore(dbPath)
				.preferences()
				.map((p) => p.rule),
		).toEqual([NO_TDD]);
	});

	it("lists and forgets preferences on command", async () => {
		expect(setup().memory.command?.("preferences")).toBe("Preference learning is off (memory.preferences).");
		const { memory } = await session(
			"I prefer small commits with one change each.",
			proposal({
				rule: "Keep each commit to one change.",
				quote: "I prefer small commits with one change each",
				holds: "standing",
			}),
		);
		expect(memory.command?.("preferences")).toBe(
			"1. Keep each commit to one change. (said in 1 session; applies here; added 0×)",
		);
		expect(memory.command?.("forget x")).toBe("Usage: /exo memory forget <id>");
		expect(memory.command?.("forget 7")).toBe("No preference 7.");
		expect(memory.command?.("forget 1")).toContain("Forgot preference 1.");
		expect(memory.command?.("preferences")).toBe(
			"No live preferences.\nRetired lately (/exo memory restore <id> brings one back):\n1. Keep each commit to one change. (retired by you)",
		);
		expect(memory.command?.("on")).toBeUndefined();
	});

	it("is off by default, skips short messages and survives a failing sidecar", async () => {
		const off = setup({}, () => proposal({ quote: "always write the failing test first", holds: "standing" }));
		off.memory.onUserTurn?.({ text: "Always write the failing test first, please.", origin: "user" });
		await off.memory.onSettle?.(DONE, signal);
		expect(await ask(off.memory, "Add a function that parses durations")).toBeUndefined();
		await new Promise((r) => setTimeout(r, 30));
		expect(off.t.requests).toEqual([]);

		const short = setup({ preferences: true }, () => proposal({}));
		short.memory.onUserTurn?.({ text: "ok", origin: "user" });
		short.memory.onUserTurn?.({ text: "go on", origin: "user" });
		short.memory.onUserTurn?.({ text: "Not done yet. Please finish the README file.", origin: "suggestion" });
		await short.memory.onSettle?.(DONE, signal);
		await new Promise((r) => setTimeout(r, 30));
		expect(short.t.requests).toEqual([]);

		// A short message can state one (D-109).
		const terse = await session(
			"use pnpm not npm",
			proposal({ rule: "Use pnpm, not npm.", quote: "use pnpm not npm" }),
		);
		expect(actions(terse.t)).toEqual(["preference_learned"]);

		const broken = await session("Always write the failing test first, please.", new Error("down"));
		expect(broken.t.logs.some((l) => l.startsWith("preferences "))).toBe(true);
		expect(
			openMemoryStore(dbPath)
				.preferences()
				.map((p) => p.rule),
		).toEqual(["Use pnpm, not npm."]);
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
		holds: "task",
		applies_to: "fix",
		correction: true,
		...extra,
	});
	const actions = (t: { records: { data: unknown }[] }) => t.records.map((r) => (r.data as { action: string }).action);
	const settled = async (s: ReturnType<typeof setup>, requests: number) => {
		await s.memory.onSettle?.(DONE, signal);
		await until(() => s.t.requests.length >= requests);
		await drained(s.t);
	};
	const SAME = { same: 1, contradicts: [] };
	/** Proposes `proposed` for the correction and nothing for any other message. */
	const onCorrection = (proposed: object, relation: object) => (prompt: string) =>
		isSelect(prompt)
			? ALL
			: isRelate(prompt)
				? relation
				: { preferences: prompt.includes(`Developer's message:\n<<<\n${CORRECTION}`) ? [proposed] : [] };

	/** One session: a request, the agent's answer, then the user's correction of it. */
	async function corrected(proposed: object = item(), relation: object = UNRELATED) {
		const s = setup({ preferences: true }, onCorrection(proposed, relation));
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
		expect(actions((await corrected(item(), SAME)).t)).toEqual(["preference_seen"]);
		const later = setup({ preferences: true }, () => ALL);
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
		await corrected(item({ applies_to: "feature" }), SAME);
		expect(openMemoryStore(dbPath).preferences()[0]).toMatchObject({ taskKind: "any" });
	});

	it("counts a correction on a preference that was already in the conversation", async () => {
		await corrected(item({ holds: "standing" }));
		const s = setup({ preferences: true }, onCorrection(item(), SAME));
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
		const s = setup({}, () => LESSON, embedder);
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
		expect(rewrite?.text).toContain(`- (a similar error, this repo; the fix edited lib.rs) ${LESSON_TEXT}`);
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

	it("shows the relation sidecar the nearest preferences when there are too many to show all", async () => {
		const prefer: Embed = (texts) => texts.map((t) => (/test|tdd/i.test(t) ? [1, 0] : [0, 1]));
		const TDD = "Write the failing test before the implementation.";
		const store = openMemoryStore(dbPath);
		const tdd = store.addPreference(TDD);
		for (let i = 0; i < 40; i++) store.addPreference(`Name migration files with prefix number ${i}00${i}.`);
		const statement = {
			preferences: [
				{ rule: "Work in TDD style.", quote: "TDD style", holds: "task", applies_to: "any", correction: false },
			],
		};
		/** The sidecar says "same" for the known rule when it is shown it, by the number it has in the list. */
		const say = async (embedder: Embed | undefined) => {
			let asked = "";
			const s = setup(
				{ preferences: true },
				(prompt) => {
					if (!isRelate(prompt)) return statement;
					asked = prompt;
					return { same: Number(/(\d+)\. Write the failing test/.exec(prompt)?.[1] ?? 0), contradicts: [] };
				},
				embedder,
			);
			s.memory.onUserTurn?.({ text: "Do this one TDD style like we usually do in the parser.", origin: "user" });
			await s.memory.onSettle?.({ outcome: "completed", lastAssistantText: "" }, signal);
			await until(() => s.t.records.length > 0);
			return { asked, data: s.t.records[0]?.data };
		};
		// The rule shares no word with the one it restates: only the embedding model puts it among the nearest.
		const near = await say(prefer);
		expect(near.asked).toContain("Known preferences (the 30 nearest to the stated rule, of 41):");
		expect(near.data).toMatchObject({ action: "preference_seen", preference: tdd });
		expect(store.vectors("preference", "test-embed").size).toBe(41);
		// Without one, keywords choose what is shown, and the known rule is not among it.
		const far = await say(undefined);
		expect(far.asked).not.toContain(`. ${TDD}\n`);
		expect(near.asked).toContain(`1. ${TDD}\n`);
		expect(far.data).toMatchObject({ action: "preference_learned" });
	});
});

describe("preference selection by sidecar (D-062) and how long a rule holds (D-090)", () => {
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
		const { memory, t } = setup({ preferences: true }, () => ALL);
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

	it("shows the selection the end of a long request, where an exception is often stated (D-089)", async () => {
		seed();
		const prompts: string[] = [];
		const { memory } = setup({ preferences: true }, (prompt) => {
			prompts.push(prompt);
			return { apply: [] };
		});
		const text = `Fix the date parser.\n${"log line from the failing run\n".repeat(600)}Skip the tests this time.`;
		await memory.contextForUserTurn?.({ text, origin: "user" }, signal);
		expect(prompts[0]).toContain("Fix the date parser.");
		expect(prompts[0]).toContain("Skip the tests this time.");
		expect(prompts[0]).toContain("\n[…]\n");
		expect(prompts[0]?.length).toBeLessThan(text.length);
	});

	it("reads a rule stated after a long paste, and tells the sidecar what it is not shown (D-089)", async () => {
		const prompts: string[] = [];
		const s = setup({ preferences: true }, (prompt) => {
			prompts.push(prompt);
			return {
				preferences: [
					{
						rule: RULES[0],
						quote: "always write the failing test first",
						holds: "standing",
						applies_to: "any",
						correction: false,
					},
				],
			};
		});
		const paste = "log line from the failing run\n".repeat(400);
		await s.memory.onSettle?.(
			{ outcome: "completed", lastAssistantText: `${"I changed things. ".repeat(200)}Done.` },
			signal,
		);
		s.memory.onUserTurn?.({
			text: `Fix the date parser.\n${paste}From now on, always write the failing test first.`,
			origin: "user",
		});
		await s.memory.onSettle?.(DONE, signal);
		await until(() => s.t.records.length > 0);
		expect(prompts[0]).toContain("[… the middle of this message is not shown. …]");
		expect(prompts[0]).toContain("[… the start of the agent's message is not shown …]");
		expect(
			openMemoryStore(dbPath)
				.preferences()
				.map((p) => p.rule),
		).toEqual([RULES[0]]);
	});

	it("adds nothing when the selection fails or there is no engine, and says so (D-109)", async () => {
		seed();
		const text = "Add durations, keeping each commit to one change";
		const failing = setup({ preferences: true }, () => new Error("down"));
		expect(await shown(failing.memory.contextForUserTurn?.({ text, origin: "user" }, signal))).toBeUndefined();
		expect(failing.t.logs.some((l) => l.startsWith("preference selection "))).toBe(true);

		const none = setup({ preferences: true });
		for (let i = 0; i < 2; i++) {
			expect(await shown(none.memory.contextForUserTurn?.({ text, origin: "user" }, signal))).toBeUndefined();
		}
		expect(none.t.logs.filter((l) => l.startsWith("no sidecar engine"))).toHaveLength(1);
	});

	it("shows the selection every preference that applies, and caps what it picks (D-109)", async () => {
		const store = openMemoryStore(dbPath);
		for (let i = 0; i < 8; i++) {
			const id = store.addPreference(`Rule number ${i} for the codebase.`);
			store.addSighting(id, { scope: "a", session: "s", standing: true, correction: false, quote: "q" });
			store.addSighting(id, { scope: "b", session: "s", standing: true, correction: false, quote: "q" });
		}
		const prompts: string[] = [];
		const { memory } = setup({ preferences: true, maxPreferences: 2 }, (prompt) => {
			prompts.push(prompt);
			return { apply: [3, 5, 7] };
		});
		const added = await shown(memory.contextForUserTurn?.({ text: "Fix it", origin: "user" }, signal));
		expect(prompts[0]).toContain("8. Rule number");
		expect(added?.split("\n").slice(1)).toHaveLength(2);
	});

	it("takes the sidecar's reading of how long a rule holds, whatever words it is said in", async () => {
		const TDD_PERSON = "Fix the date parser. You know me, a TDD person.";
		const cases = [
			// No word marks it as a rule for the future, and it is one.
			[TDD_PERSON, "a TDD person", "standing", "Work test-first."],
			[TDD_PERSON, "a TDD person", "task", "Write a test for each change."],
			// "I want you to" opens most instructions for one task.
			["I want you to write the tests first for this parser.", "write the tests first", "task", "Test before coding."],
			// "today" says nothing about how long it holds.
			["The way we work today is always test-first.", "always test-first", "standing", "Start from a failing test."],
		] as const;
		for (const [text, quote, holds, rule] of cases) {
			const s = setup(
				{ preferences: true },
				reads({ preferences: [{ rule, quote, holds, applies_to: "any", correction: false }] }),
			);
			s.memory.onUserTurn?.({ text, origin: "user" });
			await s.memory.onSettle?.(DONE, signal);
			await until(() => s.t.records.length > 0);
		}
		const next = setup({ preferences: true }, () => ALL);
		const added = await shown(
			next.memory.contextForUserTurn?.({ text: "Add a parser for durations", origin: "user" }, signal),
		);
		expect(added?.split("\n").slice(1)).toEqual(["- Start from a failing test.", "- Work test-first."]);
	});
});

describe("after review and live test (D-109)", () => {
	const UNITTEST_CUT =
		"----------------------------------------------------------------------\nRan 4 tests in 0.002s\n\nFAILED (errors=1)";

	it("never keys or learns a card on a summary line, and keeps the fix open for a run that shows the error", async () => {
		expect(anchorOf(UNITTEST_CUT)).toBeUndefined();
		expect([...failureOf("bash", UNITTEST_CUT).keys]).toEqual([]);
		for (const summary of [
			"FAIL src/sum.test.js",
			"FAIL\texample.com/pkg\t0.002s",
			"========================= 2 failed, 1 passed in 0.03s ==========================",
			"test result: FAILED. 1 passed; 2 failed; 0 ignored",
			"Tests:       1 failed, 3 passed, 4 total",
			"make: *** [Makefile:3: test] Error 1",
		]) {
			expect([summary, anchorOf(summary)]).toEqual([summary, undefined]);
		}
		const { memory, t } = setup({}, () => LESSON);
		const command = "python3 -m unittest -q test_dispatch 2>&1 | tail -5";
		memory.onToolResult?.({ ...fail(command, UNITTEST_CUT), isError: false, exitCode: 0 });
		memory.onToolResult?.(edit);
		memory.onToolResult?.({ ...pass("python3 -m unittest -q test_dispatch"), output: "Ran 4 tests\n\nOK" });
		await new Promise((r) => setTimeout(r, 40));
		expect(t.records).toEqual([]);
		expect(openMemoryStore(dbPath).cards()).toEqual([]);
	});

	it("matches a card with no names only on the failure's first error", () => {
		const store = openMemoryStore(dbPath);
		const output = "RuntimeError: boom";
		const signature = [...failureOf("bash", output).keys][0] ?? "";
		store.add({ scope: "r", signature, detail: [], files: [], trigger: output, lesson: "x", evidence: "{}" });
		const settings = { maxCards: 2, minOverlap: 0.6, minDetail: 0.6 };
		expect(recall(store, "r", failureOf("bash", output), output, settings)).toHaveLength(1);
		const later = `TypeError: strip expected at most 1 argument, got 2\n${output}`;
		expect(recall(store, "r", failureOf("bash", later), later, settings)).toEqual([]);
	});

	it("merges a fix into the recalled card that helped, instead of learning it again", async () => {
		const first = setup({}, () => LESSON);
		for (const tool of [fail(), edit, pass()]) first.memory.onToolResult?.(tool);
		await until(() => first.t.records.length > 0);
		// The same fix, met through another line of the output.
		const later = setup({}, () => LESSON);
		const output = `error[E0599]: no method named \`push_all\`\n${ERROR}`;
		await later.memory.rewriteToolResult?.(draft(fail("cargo build", output)), signal);
		later.memory.onToolResult?.(fail("cargo build", output));
		later.memory.onToolResult?.(edit);
		later.memory.onToolResult?.(pass());
		await until(() => later.t.records.some((r) => (r.data as { action: string }).action === "merged"));
		expect(later.t.records.map((r) => r.data)).toEqual([
			expect.objectContaining({ action: "recalled" }),
			expect.objectContaining({ action: "credited", outcome: "helped" }),
			{ action: "merged", card: 1, recalled: true },
		]);
		expect(openMemoryStore(dbPath).cards()).toHaveLength(1);
	});

	it("closes a pytest, Go or Jest failure with a pass narrowed to its test", () => {
		const fixFor = (failing: ToolOutcome, passing: ToolOutcome) => {
			const tracker = createEpisodeTracker({ cwd: dir, minDetail: 0.6 });
			tracker.observe(failing);
			tracker.observe(edit);
			return tracker.observe(passing);
		};
		const pytest = "______ test_one ______\nE       AttributeError: 'Foo' object has no attribute 'bar_baz'";
		expect(fixFor(fail("pytest", pytest), pass("pytest tests/test_x.py::test_one"))).toHaveLength(1);
		const go = "--- FAIL: TestAdd (0.00s)\n    add_test.go:9: Add(1,2) = 4; want 3\nFAIL\nFAIL\tex.com/m\t0.01s";
		expect(fixFor(fail("go test ./...", go), pass("go test -run TestAdd ./..."))).toHaveLength(1);
		expect(fixFor(fail("go test ./...", go), pass("go test -run TestSub ./..."))).toEqual([]);
		const jest = [
			"FAIL src/sum.test.js",
			"  ● sum › adds numbers",
			"    expect(received).toBe(expected)",
			"  ● sum › subtracts numbers",
			"    expect(received).toBe(expected)",
		].join("\n");
		expect(anchorOf(jest)?.line).toBe("● sum › adds numbers");
		expect(cardDetail(jest, 1)).toEqual(["sum", "adds", "numbers"]);
		expect(fixFor(fail("npx jest", jest), pass("npx jest -t 'adds numbers'"))).toHaveLength(1);
		expect(fixFor(fail("npx jest", jest), pass("npx jest -t 'divides numbers'"))).toEqual([]);
	});

	it("reads an option's value as no filter, and a cd into the working directory as none", () => {
		expect(runOf("pytest -n auto --tb short", dir)).toMatchObject({ runner: "pytest", filters: [] });
		expect(runOf("go test -timeout 30s -count 1 ./...", dir)).toMatchObject({ runner: "go test", filters: [] });
		expect(runOf("cargo test --features full -j 4", dir)).toMatchObject({ runner: "cargo test", filters: [] });
		expect(runOf("cargo test -p mycrate", dir)).toMatchObject({ filters: ["mycrate"] });
		expect(runOf(`cd ${dir} && pytest`, dir)).toMatchObject({ runner: "pytest" });
		expect(runOf(`cd ${dir}/app && pytest`, dir)).toMatchObject({ runner: "cd app && pytest" });
		expect(runOf("cd ~/p && pytest", dir)).toMatchObject({ runner: "cd ~/p && pytest" });
	});

	it("keeps a lesson's code name that the repo has, and does not read an acknowledgement for preferences", async () => {
		writeFileSync(join(dir, "config.rs"), "pub fn parse_config() {}\n");
		await runShellCommand("git add -A", { cwd: dir, timeoutMs: 10_000 });
		const { memory, t } = setup({}, () => ({
			lesson: "Call `parse_config` before `missing_thing`.",
			applies_when: "",
		}));
		for (const tool of [fail(), edit, pass()]) memory.onToolResult?.(tool);
		await until(() => t.records.length > 0);
		expect(t.records[0]?.data).toMatchObject({
			lesson: "Call `parse_config` before missing_thing.",
			ungrounded: ["missing_thing"],
		});

		const prefs = setup({ preferences: true }, () => ({ preferences: [] }));
		for (const text of ["continue", "go ahead", "Thanks!", "ok, continue please"]) {
			prefs.memory.onUserTurn?.({ text, origin: "user" });
		}
		await prefs.memory.onSettle?.({ outcome: "completed", lastAssistantText: "" }, signal);
		await new Promise((r) => setTimeout(r, 30));
		expect(prefs.t.requests).toEqual([]);
	});
});
