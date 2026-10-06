import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CompactionRequest,
	type CompactionSummary,
	type ExoModule,
	type JsonValue,
	runShellCommand,
} from "@exocortex/core";
import { createTestModuleContext, type SidecarReply, type TestModuleContext } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompaction } from "../src/compaction.ts";

/** Regression tests for the hardening pass (D-085): one group per item of the plan's section K. */

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-facts-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const NARRATIVE = [
	"## Objective",
	"- Implement a Forth interpreter in Rust.",
	"",
	"## Important Details",
	"- (none)",
	"",
	"## Work State",
	"### Completed",
	"- (none)",
	"",
	"### Active",
	"- (none)",
	"",
	"### Blocked",
	"- (none)",
	"",
	"## Next Move",
	"1. (none)",
	"",
	"## Relevant Files",
	"- (none)",
].join("\n");
const REQUESTS = "## User requests (verbatim, oldest first)";
const MODIFIED = "## Files modified";
const READ = "## Files read";
const FAILED = "## Commands whose last run failed";
const PASSED = "## Commands that last succeeded (no need to re-run unless something changed)";

function request(extra: Partial<CompactionRequest> = {}): CompactionRequest {
	return {
		reason: "threshold",
		conversation: "[User]: implement forth\n\n[Assistant]: on it",
		userMessages: [],
		previousSummary: null,
		previousDetails: null,
		filesRead: [],
		filesModified: [],
		tokensBefore: 120_000,
		customInstructions: null,
		...extra,
	};
}

interface Setup {
	readonly t: TestModuleContext;
	readonly module: ExoModule;
}

function setup(
	options: {
		readonly settings?: Record<string, unknown>;
		readonly reply?: (prompt: string) => SidecarReply;
		readonly savedState?: JsonValue;
		readonly cwd?: string;
	} = {},
): Setup {
	const { reply, savedState } = options;
	const t = createTestModuleContext({
		cwd: options.cwd ?? dir,
		...(reply ? { reply: (r) => reply(String(r.messages[1]?.["content"])) } : {}),
		...(savedState === undefined ? {} : { savedState }),
	});
	return { t, module: createCompaction({ fallback: "deterministic", ...options.settings }, t.context) };
}

/** Compacts as the adapter does: the summary is used, so its `commit` runs and the harness reports the compaction. */
async function compacted(module: ExoModule, req: CompactionRequest): Promise<CompactionSummary> {
	const result = await module.compact?.(req, signal);
	if (!result) throw new Error("no summary");
	result.commit?.();
	module.onCompacted?.();
	return result;
}

/** What the adapter hands back at the next compaction: the details it stored, beside the module's id. */
function next(previous: CompactionSummary, extra: Partial<CompactionRequest> = {}): CompactionRequest {
	return request({
		previousSummary: previous.summary,
		previousDetails: { ...previous.details, module: "compaction" },
		...extra,
	});
}

/** What a summary keeps of the requests with its compaction. */
function keptFacts(result: CompactionSummary): { readonly requests: string[]; readonly requestsOmitted: number } {
	return result.details?.["facts"] as unknown as { requests: string[]; requestsOmitted: number };
}

/** The body of one facts section of a summary, or undefined when the summary has no such section. */
function section(summary: string, heading: string): string | undefined {
	const parts = summary.split("\n\n");
	const at = parts.indexOf(heading);
	return at === -1 ? undefined : parts[at + 1];
}

function tools(module: ExoModule) {
	const call = (toolName: string, input: Record<string, JsonValue>, exitCode: number | null, output = "") =>
		module.onToolResult?.({ toolName, input, isError: (exitCode ?? 0) !== 0, exitCode, output });
	return {
		bash: (command: string, exitCode: number, output = "") => call("bash", { command }, exitCode, output),
		read: (path: string) => call("read", { path }, null),
		edit: (path: string) => call("edit", { path, edits: [{ oldText: "a", newText: "b" }] }, null),
		write: (path: string) => call("write", { path, content: "x" }, null),
	};
}

async function git(command: string, cwd = dir): Promise<void> {
	const out = await runShellCommand(command, { cwd, timeoutMs: 10_000 });
	if (out.exitCode !== 0) throw new Error(`${command}: ${out.outputTail}`);
}

const COMMIT = "git add -A && git -c user.name=t -c user.email=t@t commit -qm base";

/** The module reads the tree's state when it is built: wait until it has, so the test's own changes come after. */
async function started(s: Setup): Promise<Setup> {
	await vi.waitFor(() => expect(s.t.states.length).toBeGreaterThan(0), { timeout: 2_000 }).catch(() => undefined);
	return s;
}

describe("K1: facts survive a second compaction and a rebuilt module", () => {
	/** A first stretch of work, compacted. */
	async function firstCompaction(s: Setup): Promise<CompactionSummary> {
		const tool = tools(s.module);
		tool.read("README.md");
		tool.edit("src/lib.rs");
		tool.bash("cargo test", 101, "error[E0502]: cannot borrow `self.stack`");
		tool.bash("cargo fmt", 0);
		return compacted(
			s.module,
			request({ userMessages: ["implement forth"], filesRead: ["README.md"], filesModified: ["src/lib.rs"] }),
		);
	}

	const expectBoth = (summary: string) => {
		expect(section(summary, REQUESTS)).toBe("1. implement forth\n2. now add a REPL");
		expect(section(summary, MODIFIED)).toBe("- src/lib.rs\n- src/repl.rs");
		expect(section(summary, READ)).toBe("- Cargo.toml\n- README.md");
		// `src/repl.rs` was written after the tests last ran.
		expect(section(summary, FAILED)).toBe(
			"- `cargo test` → exit 101, before later file edits: error[E0502]: cannot borrow `self.stack`",
		);
		expect(section(summary, PASSED)).toBe("- `cargo fmt`\n- `cargo clippy`");
	};

	it("keeps the first compaction's facts in the second, in one instance", async () => {
		const s = setup();
		const first = await firstCompaction(s);
		const tool = tools(s.module);
		tool.read("Cargo.toml");
		tool.write("src/repl.rs");
		tool.bash("cargo clippy", 0);
		// The second span holds only what came after the first.
		const second = await compacted(
			s.module,
			next(first, { userMessages: ["now add a REPL"], filesRead: ["Cargo.toml"], filesModified: ["src/repl.rs"] }),
		);
		expectBoth(second.summary);
	});

	it("keeps them when the module was rebuilt in between, from its saved state", async () => {
		const one = setup();
		const first = await firstCompaction(one);
		const saved = one.t.states.at(-1);
		expect(saved).toBeDefined();
		const two = setup({ ...(saved === undefined ? {} : { savedState: saved }) });
		const tool = tools(two.module);
		tool.read("Cargo.toml");
		tool.write("src/repl.rs");
		tool.bash("cargo clippy", 0);
		const second = await compacted(two.module, next(first, { userMessages: ["now add a REPL"] }));
		expectBoth(second.summary);
	});

	it("keeps them from the previous compaction's details alone", async () => {
		const first = await firstCompaction(setup());
		const two = setup();
		const tool = tools(two.module);
		tool.read("Cargo.toml");
		tool.write("src/repl.rs");
		tool.bash("cargo clippy", 0);
		const second = await compacted(two.module, next(first, { userMessages: ["now add a REPL"] }));
		expectBoth(second.summary);
	});

	it("reads them out of the previous summary's text when its details are missing or unusable", async () => {
		const first = await firstCompaction(setup());
		for (const previousDetails of [null, { module: "compaction" }, { module: "compaction", facts: "what" }]) {
			const two = setup();
			const tool = tools(two.module);
			tool.read("Cargo.toml");
			tool.write("src/repl.rs");
			tool.bash("cargo clippy", 0);
			const second = await compacted(two.module, next(first, { previousDetails, userMessages: ["now add a REPL"] }));
			expectBoth(second.summary);
		}
	});

	it("survives a third compaction, and a state saved before a command ran again", async () => {
		const one = setup();
		const first = await firstCompaction(one);
		const two = setup({ savedState: one.t.states.at(-1) ?? null });
		tools(two.module).bash("cargo test", 0);
		const second = await compacted(two.module, next(first, { userMessages: ["two"] }));
		const three = setup({ savedState: two.t.states.at(-1) ?? null });
		const third = await compacted(three.module, next(second, { userMessages: ["three"] }));
		expect(section(third.summary, REQUESTS)).toBe("1. implement forth\n2. two\n3. three");
		expect(section(third.summary, MODIFIED)).toBe("- src/lib.rs");
		// The failure of the first stretch was followed by a pass: it is not brought back from older details.
		expect(section(third.summary, FAILED)).toBeUndefined();
		expect(section(third.summary, PASSED)).toContain("`cargo test`");
	});

	it("orders its own runs after the previous compaction's, through a rebuild without one in between", async () => {
		const earlier = setup();
		const then = tools(earlier.module);
		then.bash("ls", 0);
		then.bash("cargo build", 0);
		then.bash("cargo test", 101, "error: test failed");
		const first = await compacted(earlier.module, request({ userMessages: ["go"] }));
		// The session is resumed by an instance with no state, which is rebuilt before it compacts.
		const resumed = setup();
		await started(resumed);
		tools(resumed.module).bash("cargo test", 0);
		resumed.module.onUserTurn?.({ text: "and now?", origin: "user" });
		const rebuilt = setup({ savedState: resumed.t.states.at(-1) ?? null });
		tools(rebuilt.module).edit("src/lib.rs");
		const second = await compacted(rebuilt.module, next(first));
		expect(section(second.summary, FAILED)).toBeUndefined();
		expect(section(second.summary, PASSED)).toBe(
			"- `ls`\n- `cargo build` (passed before later file edits: run it again)\n- `cargo test` (passed before later file edits: run it again)",
		);
	});

	it("lists each request once: one still in the context is not in the summary, and comes with its span", async () => {
		const s = setup();
		s.module.onUserTurn?.({ text: "go", origin: "user" });
		s.module.onUserTurn?.({ text: "continue", origin: "user" });
		s.module.onUserTurn?.({ text: "continue", origin: "user" });
		// The second "continue" is in the part of the conversation pi keeps.
		const first = await compacted(s.module, request({ userMessages: ["go", "continue"] }));
		expect(section(first.summary, REQUESTS)).toBe("1. go\n2. continue");
		s.module.onUserTurn?.({ text: "stop", origin: "user" });
		const second = await compacted(s.module, next(first, { userMessages: ["continue", "stop"] }));
		expect(section(second.summary, REQUESTS)).toBe("1. go\n2. continue\n3. continue\n4. stop");
	});

	it("leaves out what an extension sent as the user, and keeps an accepted suggestion", async () => {
		const s = setup();
		s.module.onUserTurn?.({ text: "go", origin: "user" });
		s.module.onUserTurn?.({ text: "(sent by an extension)", origin: "extension" });
		s.module.onUserTurn?.({ text: "Not done yet. 1. Add the README", origin: "suggestion" });
		const first = await compacted(
			s.module,
			request({ userMessages: ["go", "(sent by an extension)", "Not done yet. 1. Add the README"] }),
		);
		expect(section(first.summary, REQUESTS)).toBe("1. go\n2. Not done yet. 1. Add the README");
	});

	it("keeps the requests through a compaction the harness wrote itself", async () => {
		const s = setup({ settings: { fallback: "harness" }, reply: () => new Error("down") });
		expect(await s.module.compact?.(request({ userMessages: ["first"] }), signal)).toBeUndefined();
		s.module.onCompacted?.();
		const rebuilt = setup({ savedState: s.t.states.at(-1) ?? null });
		const second = await compacted(
			rebuilt.module,
			request({ previousSummary: "The agent was adding a parser.", userMessages: ["second"] }),
		);
		expect(section(second.summary, REQUESTS)).toBe("1. first\n2. second");
		// A compaction that never happened leaves nothing behind.
		let calls = 0;
		const failed = setup({
			settings: { fallback: "harness" },
			reply: () => (calls++ === 0 ? new Error("down") : NARRATIVE),
		});
		expect(await failed.module.compact?.(request({ userMessages: ["lost?"] }), signal)).toBeUndefined();
		const again = await compacted(failed.module, request({ userMessages: ["lost?", "more"] }));
		expect(section(again.summary, REQUESTS)).toBe("1. lost?\n2. more");
	});

	it("tracks the files its own tool results name", async () => {
		const s = setup();
		const tool = tools(s.module);
		tool.read("docs/spec.md");
		tool.read("src/lib.rs");
		tool.edit("src/lib.rs");
		tool.write("./src/new.rs");
		s.module.onToolResult?.({
			toolName: "edit",
			input: { path: "src/failed.rs" },
			isError: true,
			exitCode: null,
			output: "",
		});
		const { summary } = await compacted(s.module, request());
		expect(section(summary, MODIFIED)).toBe("- src/lib.rs\n- src/new.rs");
		expect(section(summary, READ)).toBe("- docs/spec.md");
	});

	it("takes details and saved state as untrusted input", async () => {
		const garbage: JsonValue = {
			v: 1,
			requests: [1, { text: "x" }, "kept request", null],
			requestsOmitted: "many",
			filesModified: "src/lib.rs",
			filesRead: [["nested"], "docs/a.md", "x".repeat(5_000)],
			commands: [
				"cargo test",
				{ command: 7 },
				{ command: "cargo build", outcome: "exploded", at: "now" },
				{ key: "k", command: "make", kind: "build", outcome: "failed", exitCode: 2, at: 5, firstError: { a: 1 } },
			],
			lastEditAt: {},
			baseline: [1, 2],
			clock: "soon",
			settled: { 0: "x" },
			extensionTexts: 4,
		};
		for (const savedState of [garbage, "nonsense", 7, null, [garbage], { v: 99, requests: ["from the future"] }]) {
			const s = setup({ savedState });
			const result = await compacted(
				s.module,
				request({
					previousSummary: "old",
					previousDetails: { module: "compaction", facts: garbage },
					userMessages: ["new request"],
				}),
			);
			expect(section(result.summary, REQUESTS)).toBe("1. kept request\n2. new request");
			expect(section(result.summary, READ)).toBe("- docs/a.md");
			expect(section(result.summary, MODIFIED)).toBeUndefined();
			expect(section(result.summary, FAILED)).toBe("- `make` → exit 2");
			expect(section(result.summary, PASSED)).toBeUndefined();
		}
	});

	it("returns the facts as details and saves its state when the summary is used", async () => {
		const s = setup();
		tools(s.module).bash("cargo test", 0);
		const result = await s.module.compact?.(request({ userMessages: ["go"] }), signal);
		expect(result?.details).toMatchObject({
			facts: { v: 1, requests: ["go"], commands: [{ command: "cargo test", kind: "test", outcome: "passed" }] },
		});
		expect(s.module.status?.()).toBe("compaction");
		result?.commit?.();
		expect(s.module.status?.()).toBe("compaction (1 summaries)");
		expect(s.t.states.at(-1)).toMatchObject({ v: 1, requests: ["go"], baseline: null });
	});
});

describe("K2: one record per run, and a run's age against the edits", () => {
	it("replaces a failed run by a later pass of the same run with other options or another pipe", async () => {
		const s = setup();
		const tool = tools(s.module);
		tool.bash("cargo test", 101, "error[E0502]: cannot borrow");
		tool.bash("cargo test -- --nocapture", 0);
		tool.bash("go test ./... 2>&1 | tail -5", 0, "ok  \texample.com/pkg\t0.21s");
		tool.bash("go test ./...", 1, "--- FAIL: TestSteps (0.01s)");
		const { summary } = await compacted(s.module, request());
		expect(section(summary, FAILED)).toBe("- `go test ./...` → exit 1: --- FAIL: TestSteps (0.01s)");
		expect(section(summary, PASSED)).toBe("- `cargo test -- --nocapture`");
	});

	it("keeps runs apart that test something else", async () => {
		const s = setup();
		const tool = tools(s.module);
		tool.bash("cargo test", 101, "error: test failed");
		tool.bash("cargo test parser", 0);
		tool.bash("cd fuzz && cargo test", 0);
		tool.bash("cargo build", 0);
		const { summary } = await compacted(s.module, request());
		expect(section(summary, FAILED)).toBe("- `cargo test` → exit 101: error: test failed");
		expect(section(summary, PASSED)).toBe("- `cargo test parser`\n- `cd fuzz && cargo test`\n- `cargo build`");
	});

	it("says when a test or build run came before later file edits", async () => {
		const s = setup();
		const tool = tools(s.module);
		tool.bash("cargo build", 0);
		tool.bash("make test", 2, "make: *** [test] Error 1");
		tool.bash("ls src", 0);
		tool.edit("src/lib.rs");
		tool.bash("cargo test", 0);
		const { summary } = await compacted(s.module, request());
		expect(section(summary, FAILED)).toBe("- `make test` → exit 2, before later file edits: make: *** [test] Error 1");
		expect(section(summary, PASSED)).toBe(
			"- `cargo build` (passed before later file edits: run it again)\n- `ls src`\n- `cargo test`",
		);
	});
});

describe("K3: the newest failures, and no exit code that is an answer", () => {
	it("lists the newest failures and every failed test or build run among them", async () => {
		const s = setup();
		const tool = tools(s.module);
		tool.bash("cargo test", 101, "error: test failed");
		for (let i = 0; i < 45; i++) tool.bash(`./step-${i}.sh`, 1, `error: step ${i}`);
		const { summary } = await compacted(s.module, request());
		const failed = section(summary, FAILED)?.split("\n") ?? [];
		// Of the 40 other commands it keeps a record of.
		expect(failed[0]).toBe("- … and 35 earlier");
		expect(failed).toContain("- `cargo test` → exit 101: error: test failed");
		expect(failed.at(-1)).toBe("- `./step-44.sh` → exit 1: error: step 44");
		expect(failed).not.toContain("- `./step-0.sh` → exit 1: error: step 0");
		expect(failed).toHaveLength(7);
	});

	it("does not list a search that found nothing as a failure", async () => {
		const s = setup();
		const tool = tools(s.module);
		tool.bash("grep -rn TODO src", 1);
		tool.bash("git diff --quiet", 1);
		tool.bash("cat notes.txt | grep parser", 0, "parser: done");
		tool.bash("cat notes.txt | grep parser", 1);
		tool.bash("grep -rn TODO src", 2, "error: src: No such file or directory");
		const { summary } = await compacted(s.module, request());
		expect(section(summary, FAILED)).toBe("- `grep -rn TODO src` → exit 2: error: src: No such file or directory");
		expect(section(summary, PASSED)).toBeUndefined();
	});
});

describe("K4: a name that cannot be verified is marked, not deleted with its step", () => {
	const narrative = (extra: { completed?: string; next?: string }) =>
		NARRATIVE.replace("### Completed\n- (none)", `### Completed\n${extra.completed ?? "- (none)"}`).replace(
			"1. (none)",
			extra.next ?? "1. (none)",
		);

	it("keeps a next step that names a file to create", async () => {
		mkdirSync(join(dir, "src"));
		const next = "1. Create src/parser.rs with the tokenizer\n2. Add `tests/parser_test.rs` and `notes.md`";
		const s = setup({ reply: () => narrative({ next }) });
		const { summary } = await compacted(s.module, request());
		expect(summary).toContain("## Next Move\n1. Create src/parser.rs with the tokenizer\n2. Add ");
		// `tests/` does not exist: the name stays, said to be unverified.
		expect(summary).toContain("2. Add tests/parser_test.rs and `notes.md` [unverified: tests/parser_test.rs]");
		expect(summary).toContain("Names marked [unverified]");
		expect(s.t.logs).toContain("unverified in the summary: tests/parser_test.rs");
		expect(s.t.records[0]?.data).toMatchObject({ unverified: 1 });
	});

	it("keeps a bullet outside the next steps, marking only the name found nowhere", async () => {
		const s = setup({
			reply: () => narrative({ completed: "- added `Phantom` next to `Interpreter`\n- wrote src/new.rs" }),
		});
		const { summary } = await compacted(s.module, request({ conversation: "[Assistant]: `Interpreter` is in place" }));
		expect(summary).toContain(
			"### Completed\n- added Phantom next to `Interpreter` [unverified: Phantom]\n- wrote src/new.rs [unverified: src/new.rs]",
		);
	});

	it("does not take its own mark as evidence at the next compaction", async () => {
		const replies = [
			narrative({ completed: "- added `Phantom`" }),
			narrative({ completed: "- added Phantom [unverified: Phantom]\n- uses `Phantom` everywhere" }),
		];
		const s = setup({ reply: () => replies.shift() ?? "" });
		const first = await compacted(s.module, request());
		const prompts: string[] = [];
		const two = setup({
			reply: (p) => {
				prompts.push(p);
				return replies.shift() ?? "";
			},
		});
		const second = await compacted(two.module, next(first));
		expect(prompts[0]).toContain("- added Phantom [unverified: Phantom]\n");
		expect(prompts[0]).not.toContain("Names marked [unverified]");
		expect(second.summary).toContain(
			"- added Phantom [unverified: Phantom]\n- uses Phantom everywhere [unverified: Phantom]",
		);
		expect(second.summary.split("Names marked [unverified]")).toHaveLength(2);
	});

	it("says nothing when every name is found", async () => {
		const s = setup({ reply: () => NARRATIVE });
		const { summary } = await compacted(s.module, request());
		expect(summary).not.toContain("unverified");
		expect(s.t.records[0]?.data).toMatchObject({ unverified: 0 });
	});
});

describe("K5: budgets", () => {
	it("hands the previous narrative back whole when it is as long as a summary may be", async () => {
		const prompts: string[] = [];
		const s = setup({
			reply: (p) => {
				prompts.push(p);
				return NARRATIVE;
			},
		});
		// 4,096 tokens of prose is about 16,000 characters.
		const details = Array.from({ length: 200 }, (_, i) => `- detail ${i} ${"word ".repeat(13)}`).join("\n");
		const previous = NARRATIVE.replace("## Important Details\n- (none)", `## Important Details\n${details}`);
		expect(previous.length).toBeGreaterThan(15_000);
		await compacted(s.module, request({ previousSummary: `${previous}\n\n${REQUESTS}\n\n1. go` }));
		expect(prompts[0]).toContain(`<prior-summary>\n${previous}\n</prior-summary>`);
	});

	it("cuts a previous summary from elsewhere at a line, in proportion to maxSummaryTokens", async () => {
		const prompts: string[] = [];
		const s = setup({
			settings: { maxSummaryTokens: 200 },
			reply: (p) => {
				prompts.push(p);
				return NARRATIVE;
			},
		});
		const foreign = Array.from({ length: 100 }, (_, i) => `line ${i} of a summary pi wrote`).join("\n");
		await compacted(s.module, request({ previousSummary: foreign }));
		const prior = /<prior-summary>\n([\s\S]*)\n<\/prior-summary>/.exec(prompts[0] ?? "")?.[1] ?? "";
		expect(prior.length).toBeLessThanOrEqual(1_700);
		expect(prior.length).toBeGreaterThan(1_200);
		expect(prior).toMatch(/^line 0 of a summary pi wrote\n/);
		expect(prior).toMatch(/\nline \d+ of a summary pi wrote\n\[… the rest was cut …\]$/);
	});

	it("keeps the requests within a budget: the first and the newest whole, those between on one line", async () => {
		const body = (i: number) => `request ${i}: ${"detail ".repeat(20)}\nsecond line of ${i} ${"x".repeat(1_500)}`;
		const messages = Array.from({ length: 30 }, (_, i) => body(i + 1));
		const s = setup();
		const result = await compacted(s.module, request({ userMessages: messages }));
		const requests = section(result.summary, REQUESTS) ?? "";
		expect(requests.length).toBeLessThan(12_000);
		const lines = requests.split("\n");
		expect(lines[0]).toBe("(The first and the newest request are whole; those between are cut to their first line.)");
		expect(lines[1]).toBe(`1. ${body(1).split("\n")[0]}`);
		expect(lines[2]).toMatch(/^second line of 1 x+$/);
		expect(lines[3]).toBe(`2. ${body(2).split("\n")[0]?.trimEnd()} …`);
		expect(lines[31]).toBe(`30. ${body(30).split("\n")[0]}`);
		expect(lines).toHaveLength(33);
		// What is kept with the compaction is still every request in full.
		expect(result.details).toMatchObject({ facts: { requests: messages } });
		// Under the budget nothing is cut.
		const few = await compacted(setup().module, request({ userMessages: messages.slice(0, 3) }));
		expect(section(few.summary, REQUESTS)).toBe(
			messages
				.slice(0, 3)
				.map((m, i) => `${i + 1}. ${m}`)
				.join("\n"),
		);
	});

	it("leaves the oldest requests between out when even their first lines do not fit, and says how many", async () => {
		const messages = Array.from({ length: 400 }, (_, i) => `request ${i + 1} ${"y".repeat(100)}\nmore`);
		const s = setup({ settings: { maxRequestsChars: 4_000 } });
		const result = await compacted(s.module, request({ userMessages: messages }));
		const lines = (section(result.summary, REQUESTS) ?? "").split("\n");
		expect(lines.join("\n").length).toBeLessThan(4_400);
		expect(lines[1]).toBe(`1. request 1 ${"y".repeat(100)}`);
		expect(lines[2]).toBe("more");
		const omitted = /^\(… (\d+) requests left out …\)$/.exec(lines[3] ?? "");
		expect(omitted).not.toBeNull();
		const firstShown = 2 + Number(omitted?.[1]);
		expect(lines[4]).toBe(`${firstShown}. request ${firstShown} ${"y".repeat(100)} …`);
		expect(lines.at(-2)).toBe(`400. request 400 ${"y".repeat(100)}`);
		// The next compaction renders the same from what was kept with this one.
		const again = await compacted(setup({ settings: { maxRequestsChars: 4_000 } }).module, next(result));
		expect(section(again.summary, REQUESTS)).toBe(section(result.summary, REQUESTS));
	});

	it("bounds what it keeps of the requests too, and still counts every one", async () => {
		const long = Array.from({ length: 100 }, (_, i) => `long ${i + 1}\n${"z".repeat(1_800)}`);
		const first = await compacted(setup().module, request({ userMessages: long }));
		const kept = keptFacts(first).requests;
		expect(kept).toHaveLength(100);
		expect(kept.join("").length).toBeLessThan(61_000);
		expect(kept[0]).toBe(long[0]);
		expect(kept[1]).toBe("long 2 …");
		expect(kept.at(-1)).toBe(long.at(-1));
		const short = Array.from({ length: 3_000 }, (_, i) => `short ${i + 1} ${"s".repeat(90)}`);
		const second = await compacted(setup().module, next(first, { userMessages: short }));
		const facts = keptFacts(second);
		expect(facts.requests.join("").length).toBeLessThan(61_000);
		expect(facts.requests.length + facts.requestsOmitted).toBe(3_100);
		expect(facts.requests[0]).toBe(long[0]);
		const lines = (section(second.summary, REQUESTS) ?? "").split("\n");
		expect(lines.at(-1)).toBe(`3100. short 3000 ${"s".repeat(90)}`);
		expect(lines[3]).toMatch(/^\(… \d+ requests left out …\)$/);
	});
});

describe("K6: files modified, from the tools and from git", () => {
	async function repo(files: Record<string, string>): Promise<void> {
		for (const [name, content] of Object.entries(files)) {
			mkdirSync(join(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), content);
		}
		await git(`git init -q -b main && ${COMMIT}`);
	}

	it("lists what the shell changed, created, deleted and renamed, and not what was dirty before the session", async () => {
		await repo({ "a.txt": "one\n", "gone.txt": "x\n", "old.txt": "keep\nthis\n", "pre.txt": "1\n", "both.txt": "1\n" });
		// Before the session: a modified file, an untracked one, and one the session will change further.
		writeFileSync(join(dir, "pre.txt"), "1\n2\n");
		writeFileSync(join(dir, "scratch.log"), "mine\n");
		writeFileSync(join(dir, "both.txt"), "1\nbefore\n");
		const s = await started(setup());
		writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
		writeFileSync(join(dir, "created.txt"), "new\n");
		rmSync(join(dir, "gone.txt"));
		await git("git mv old.txt renamed.txt");
		writeFileSync(join(dir, "both.txt"), "1\nbefore\nand after\n");
		const first = await compacted(s.module, request());
		const expected = [
			"- a.txt (+2 −0)",
			"- both.txt (+2 −0, with changes from before this session)",
			"- created.txt (new)",
			"- gone.txt (deleted)",
			"- renamed.txt (renamed from old.txt)",
		].join("\n");
		expect(section(first.summary, MODIFIED)).toBe(expected);
		// A rebuilt module does not take the tree as it is now for the session's start.
		const rebuilt = setup({ savedState: s.t.states.at(-1) ?? null });
		const second = await compacted(rebuilt.module, next(first));
		expect(section(second.summary, MODIFIED)).toBe(expected);
		// Once committed, the files are still the session's, without a diff to show.
		await git(COMMIT);
		const third = await compacted(rebuilt.module, next(second));
		expect(section(third.summary, MODIFIED)).toBe("- a.txt\n- both.txt\n- created.txt\n- gone.txt\n- renamed.txt");
	});

	it("lists a file once, however the tool named it", async () => {
		await repo({ "a.txt": "one\n", "src/b.txt": "one\n" });
		const s = await started(setup());
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		writeFileSync(join(dir, "src/b.txt"), "one\ntwo\nthree\n");
		const tool = tools(s.module);
		tool.edit(join(dir, "a.txt"));
		tool.edit("./src/../src/b.txt");
		tool.read(join(dir, "src/b.txt"));
		tool.read(join(dir, "README.md"));
		tool.read("/etc/hostname");
		const { summary } = await compacted(
			s.module,
			request({ filesModified: [join(dir, "a.txt"), "src/b.txt"], filesRead: [join(dir, "README.md")] }),
		);
		expect(section(summary, MODIFIED)).toBe("- a.txt (+1 −0)\n- src/b.txt (+2 −0)");
		expect(section(summary, READ)).toBe("- /etc/hostname\n- README.md");
	});

	it("names files as the agent does when pi runs in a subdirectory", async () => {
		await repo({ "root.txt": "one\n", "pkg/x.txt": "one\n", "pkg/deep/y.txt": "one\n" });
		const cwd = join(dir, "pkg");
		const s = await started(setup({ cwd }));
		writeFileSync(join(dir, "root.txt"), "one\ntwo\n");
		writeFileSync(join(cwd, "x.txt"), "one\ntwo\n");
		writeFileSync(join(cwd, "deep/y.txt"), "two\n");
		writeFileSync(join(cwd, "deep/z.txt"), "new\n");
		const tool = tools(s.module);
		tool.edit("x.txt");
		tool.edit(join(dir, "root.txt"));
		const { summary } = await compacted(s.module, request({ filesModified: ["x.txt", "deep/y.txt"] }));
		expect(section(summary, MODIFIED)).toBe(
			"- ../root.txt (+1 −0)\n- deep/y.txt (+1 −1)\n- deep/z.txt (new)\n- x.txt (+1 −0)",
		);
	});

	it("lists only what the tools changed when the tree's state at the start is not known", async () => {
		// Not a repository when the session started.
		writeFileSync(join(dir, "a.txt"), "one\n");
		writeFileSync(join(dir, "b.txt"), "one\n");
		const s = await started(setup());
		await git(`git init -q -b main && ${COMMIT}`);
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		writeFileSync(join(dir, "b.txt"), "one\ntwo\n");
		tools(s.module).edit("a.txt");
		const { summary } = await compacted(s.module, request());
		expect(section(summary, MODIFIED)).toBe("- a.txt (+1 −0)");
	});

	it("keeps the files the tools changed first when the list is cut", async () => {
		await repo({ "a.txt": "one\n" });
		const s = await started(setup());
		for (let i = 0; i < 60; i++) writeFileSync(join(dir, `gen-${String(i).padStart(2, "0")}.txt`), "x\n");
		tools(s.module).write("zz-last.txt");
		renameSync(join(dir, "gen-00.txt"), join(dir, "zz-last.txt"));
		const lines = (section((await compacted(s.module, request())).summary, MODIFIED) ?? "").split("\n");
		expect(lines).toHaveLength(41);
		expect(lines).toContain("- zz-last.txt (new)");
		expect(lines.at(-1)).toBe("- … and 20 more");
	});
});
