import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	createSidecarPool,
	ENGINE_PROFILES,
	type ExoModule,
	type InferenceClient,
	type JsonValue,
	type ModuleContext,
	runShellCommand,
	type SettleAction,
	type TraceEventInput,
	type UserTurn,
} from "@exocortex/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileSections, findingKey, reviewMessage, similarity } from "../src/review.ts";
import { changedSignatures, declaredName, usesOf } from "../src/review-context.ts";
import { createSupervisor } from "../src/supervisor.ts";

/** A user message, then what the host does before the agent's first tool runs: the task's start is taken (D-102). */
async function begin(sup: ExoModule, turn: UserTurn): Promise<void> {
	sup.onUserTurn?.(turn);
	await sup.beforeToolCall?.({ toolName: "edit", toolCallId: "c", input: {} }, new AbortController().signal);
}

const ORIGINAL = ["def greet(name):", '    prefix = "Hello"', "    return prefix + name", ""].join("\n");
const CHANGED = ["def greet(name):", '    prefix = "Hello"', '    return prefix + ", " + name.strip()', ""].join("\n");
const BUG_LINE = 'return prefix + ", " + name.strip()';
const LOG_LINE = "log_greeting(name.lower())";

interface Script {
	verdict: object;
	/** What each find pass returns, in the order the passes ask. */
	passes: object[][];
	/** The check's answer for a report, by its title. */
	check?: (title: string) => object;
	/** Replies wait for this before they are sent, when set. */
	gate?: Promise<void>;
}

interface Job {
	readonly label: string;
	readonly stop: AbortController;
	readonly done: Promise<SettleAction | undefined>;
}

let repo: string;
let records: Omit<TraceEventInput, "module" | "synthetic">[];
let requests: ChatRequest[];
let jobs: Job[];

const promptOf = (request: ChatRequest) => String(request.messages[0]?.["content"]);
const isFind = (prompt: string) => prompt.startsWith("You are reviewing a code change for bugs");
const isCheck = (prompt: string) => prompt.startsWith("A reviewer says the code change below has a bug");
const findPrompts = () => requests.map(promptOf).filter(isFind);
const checkPrompts = () => requests.map(promptOf).filter(isCheck);
const reviews = () => records.filter((r) => r.kind === "exo.review").map((r) => r.data as Record<string, JsonValue>);
const lastJob = () => jobs.at(-1)?.done;

beforeEach(async () => {
	repo = mkdtempSync(join(tmpdir(), "exo-review-"));
	writeFileSync(join(repo, "app.py"), ORIGINAL);
	await git("init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm base");
	records = [];
	requests = [];
	jobs = [];
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(args: string) {
	return runShellCommand(`git ${args}`, { cwd: repo, timeoutMs: 10_000 });
}

const LEDGER = {
	is_task: true,
	follows_previous: false,
	criteria: ["greet puts a comma after the greeting"],
	check_commands: [],
	do_not_run: [],
};
const COMPLETE = { verdict: "complete", missing: [], asked_user: false, reason: "done" };
const INCOMPLETE = { verdict: "incomplete", missing: ["Add the comma"], asked_user: false, reason: "no comma" };
const DONE = { outcome: "completed" as const, lastAssistantText: "Done." };
const REAL = { verdict: "real", reason: "strip() is called on a name that may be None", scenario: "" };
const REQUEST = { text: "Make greet put a comma after Hello.", origin: "user" as const };

const finding = (title: string, quote = BUG_LINE, severity = "high") => ({
	file: "app.py",
	quote,
	title,
	scenario: "greet(None) raises AttributeError",
	severity,
});

function scriptedClient(script: Script): InferenceClient {
	let pass = 0;
	return {
		async chat(request) {
			requests.push(request);
			const prompt = promptOf(request);
			let reply: object;
			if (isFind(prompt)) {
				await script.gate;
				reply = { findings: script.passes[pass++] ?? [] };
			} else if (isCheck(prompt)) {
				const title = /^Bug: (.*)$/m.exec(prompt)?.[1] ?? "";
				reply = script.check?.(title) ?? REAL;
			} else if (prompt.includes("acceptance checklist and evidence")) reply = script.verdict;
			else if (prompt.includes("the last message a coding agent wrote")) reply = { asked_user: false, claims: [] };
			else reply = LEDGER;
			return {
				text: JSON.stringify(reply),
				finishReason: "stop",
				usage: { promptTokens: 100, completionTokens: 20, cachedTokens: null },
			};
		},
	};
}

function context(
	script: Script,
	options: { savedState?: JsonValue | undefined; saved?: JsonValue[]; background?: boolean } = {},
): ModuleContext {
	const pool = createSidecarPool({
		client: scriptedClient(script),
		target: { baseUrl: "http://x/v1", model: "m", apiKey: undefined, features: ENGINE_PROFILES.generic },
		config: {
			maxConcurrent: 8,
			reservedForMain: 1,
			timeoutMs: 5_000,
			sessionTokenBudget: 0,
			backgroundWhenIdleOnly: true,
		},
		moduleLimits: () => ({ maxTokensPerCall: 1024 }),
	});
	return {
		cwd: repo,
		sessionId: "s",
		savedState: options.savedState,
		saveState: (value) => options.saved?.push(JSON.parse(JSON.stringify(value)) as JsonValue),
		pool: () => pool,
		embedder: () => undefined,
		progress: () => {},
		record: (event) => records.push(event),
		runCommand: (command, opts) => runShellCommand(command, { cwd: repo, ...opts }),
		log: () => {},
		background: (label, job) => {
			if (options.background === false) return false;
			jobs.at(-1)?.stop.abort();
			const stop = new AbortController();
			jobs.push({ label, stop, done: job(stop.signal) });
			return true;
		},
		deliverLate: () => false,
		forkPrefix: async () => undefined,
	};
}

const signal = new AbortController().signal;
const textOf = (action: SettleAction | undefined) => (action && "text" in action ? action.text : "");

describe("review after a complete verdict (D-097)", () => {
	it("hands the session back at once, then keeps a bug two passes found and the check confirms", async () => {
		const sup = createSupervisor(
			{ review: true, reviewPasses: 3 },
			context({
				verdict: COMPLETE,
				passes: [
					[finding("strip() on None crashes"), finding("Only one pass saw this", 'prefix = "Hello"')],
					[
						finding("greet crashes on None because of strip()"),
						finding("A line nobody added", "def unrelated(): pass"),
					],
					[finding("Lonely finding", BUG_LINE, "low")],
				],
			}),
		);
		await begin(sup, REQUEST);
		writeFileSync(join(repo, "app.py"), CHANGED);
		// The verdict and the review run in one background job; the hook returns at once (D-098).
		expect(await sup.onSettle?.(DONE, signal)).toBeUndefined();
		expect(jobs.map((j) => j.label)).toEqual(["checking the work"]);

		const action = await lastJob();
		expect(action).toMatchObject({
			kind: "suggest",
			summary: "supervisor: review found a possible bug (high, 3/3 passes)",
		});
		const text = textOf(action);
		expect(text).toContain("found a possible bug");
		expect(text).toContain("app.py: strip() on None crashes");
		expect(text).toContain(`Line: ${BUG_LINE}`);
		expect(text).toContain("for any that is not, say why");
		// The two tellings of the same bug, plus the low one on the same line, are one bucket of three votes.
		expect(checkPrompts()).toHaveLength(1);
		// The review thinks; the verdict keeps the supervisor's `thinking`, off (D-101).
		const reviewing = requests.filter((r) => isFind(promptOf(r)) || isCheck(promptOf(r)));
		expect(reviewing.map((r) => r.thinking)).toEqual([true, true, true, true]);
		expect(requests.filter((r) => !reviewing.includes(r)).every((r) => r.thinking === false)).toBe(true);
		expect(reviews()).toEqual([
			expect.objectContaining({ trigger: "settle", passes: 3, answered: 3, proposed: 5, anchored: 3, distinct: 1 }),
		]);
		expect(reviews()[0]?.["kept"]).toEqual([
			{ file: "app.py", title: "strip() on None crashes", severity: "high", votes: 3 },
		]);

		// Sending the follow-up continues the task.
		await begin(sup, { text, origin: "suggestion" });
		expect(records.at(-1)).toMatchObject({ kind: "exo.action", data: { action: "accepted", continuation: 1 } });
	});

	it("drops a finding the check finds is not a bug, and says so", async () => {
		const sup = createSupervisor(
			{ review: true, reviewPasses: 3 },
			context({
				verdict: COMPLETE,
				passes: [[finding("strip() on None crashes")], [finding("strip() on None crashes")], []],
				check: () => ({ verdict: "not_a_bug", reason: "callers always pass a str", scenario: "" }),
			}),
		);
		await begin(sup, REQUEST);
		writeFileSync(join(repo, "app.py"), CHANGED);
		await sup.onSettle?.(DONE, signal);
		expect(await lastJob()).toEqual({
			kind: "notify",
			summary: "supervisor: complete · review found nothing that held up (1 proposed by 3/3 passes)",
			level: "info",
		});
		expect(reviews()[0]?.["checked"]).toEqual([
			{ title: "strip() on None crashes", votes: 2, verdict: "not_a_bug", reason: "callers always pass a str" },
		]);
	});

	it("does not review when the verdict is not complete", async () => {
		const sup = createSupervisor({ review: true }, context({ verdict: INCOMPLETE, passes: [] }));
		await begin(sup, REQUEST);
		writeFileSync(join(repo, "app.py"), CHANGED);
		await sup.onSettle?.(DONE, signal);
		expect(textOf(await lastJob())).toContain("Add the comma");
		expect(findPrompts()).toEqual([]);
	});

	it("reviews a task once, and not when the agent changed nothing", async () => {
		const sup = createSupervisor({ review: true, reviewPasses: 2 }, context({ verdict: COMPLETE, passes: [] }));
		await begin(sup, { text: "Explain greet.", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		expect(await lastJob()).toMatchObject({ summary: "supervisor: complete" });
		expect(findPrompts()).toEqual([]);

		writeFileSync(join(repo, "app.py"), CHANGED);
		await sup.onSettle?.(DONE, signal);
		await lastJob();
		await sup.onSettle?.(DONE, signal);
		expect(await lastJob()).toMatchObject({ summary: "supervisor: complete" });
		expect(findPrompts()).toHaveLength(2);
		expect(reviews()).toHaveLength(1);
	});

	it("applies nothing and records nothing when stopped, and the task can be reviewed again", async () => {
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const sup = createSupervisor(
			{ review: true, reviewPasses: 2 },
			context({ verdict: COMPLETE, passes: [[finding("a bug")], [finding("a bug")]], gate }),
		);
		await begin(sup, REQUEST);
		writeFileSync(join(repo, "app.py"), CHANGED);
		await sup.onSettle?.(DONE, signal);
		jobs[0]?.stop.abort();
		open();
		expect(await lastJob()).toBeUndefined();
		expect(reviews()).toEqual([]);
		await sup.onSettle?.(DONE, signal);
		expect(jobs).toHaveLength(2);
		await lastJob(); // ended here, not in the next test
	});

	it("shows each changed function whole, the files in another order per pass, and callers of a changed signature", async () => {
		writeFileSync(join(repo, "util.py"), "def shout(text):\n    return text.upper()\n");
		writeFileSync(join(repo, "main.py"), "from util import shout\nprint(shout('hi'))\n");
		await git("add -A && git -c user.name=t -c user.email=t@t commit -qm more");
		const sup = createSupervisor({ review: true, reviewPasses: 2 }, context({ verdict: COMPLETE, passes: [] }));
		await begin(sup, { text: "Make greet put a comma after Hello, and let shout take a suffix.", origin: "user" });
		writeFileSync(join(repo, "app.py"), CHANGED);
		writeFileSync(join(repo, "util.py"), "def shout(text, suffix):\n    return text.upper() + suffix\n");
		await sup.onSettle?.(DONE, signal);
		await lastJob();

		const [first, second] = findPrompts();
		// `prefix = "Hello"` is unchanged: it is there because the function is shown whole.
		expect(first).toContain('     prefix = "Hello"');
		const order = (prompt = "") => [prompt.indexOf("diff --git a/app.py"), prompt.indexOf("diff --git a/util.py")];
		const [appFirst, utilFirst] = order(first);
		const [appSecond, utilSecond] = order(second);
		expect(Math.sign((appFirst ?? 0) - (utilFirst ?? 0))).not.toBe(Math.sign((appSecond ?? 0) - (utilSecond ?? 0)));
		expect(first).toContain("main.py:2:print(shout('hi'))");
	});

	it("changes nothing in the task when stopped after its findings were checked", async () => {
		const passes = [[finding("strip() on None crashes")], [finding("strip() on None crashes")]];
		const base = context({ verdict: COMPLETE, passes });
		const ctx: ModuleContext = {
			...base,
			// The user presses Escape while the review reads the workspace's state for its follow-up.
			runCommand: (command, options) => {
				if (checkPrompts().length > 0 && command.startsWith("git")) jobs.at(-1)?.stop.abort();
				return base.runCommand(command, options);
			},
		};
		const sup = createSupervisor({ review: true, reviewPasses: 2, mode: "auto" }, ctx);
		await begin(sup, REQUEST);
		writeFileSync(join(repo, "app.py"), CHANGED);
		await sup.onSettle?.(DONE, signal);
		expect(await lastJob()).toBeUndefined();
		expect(sup.status?.()).toContain("0/3 continuations");
		expect(reviews()).toEqual([]);
	});

	it("continues the agent in auto mode, within the task's follow-up limit", async () => {
		const passes = [[finding("strip() on None crashes")], [finding("strip() on None crashes")]];
		const sup = createSupervisor(
			{ review: true, reviewPasses: 2, mode: "auto", maxContinuations: 1 },
			context({
				verdict: COMPLETE,
				passes: [...passes, [finding("another bug", LOG_LINE)], [finding("another bug", LOG_LINE)]],
			}),
		);
		await begin(sup, REQUEST);
		writeFileSync(join(repo, "app.py"), CHANGED.replace("def greet(name):", `def greet(name):\n    ${LOG_LINE}`));
		await sup.onSettle?.(DONE, signal);
		expect(await lastJob()).toMatchObject({ kind: "continue" });
		expect(await sup.command?.("review")).toContain("Reviewing the changes in the background");
		expect(await lastJob()).toMatchObject({
			kind: "notify",
			summary: expect.stringContaining("not sent: the task is at its follow-up limit"),
		});
	});
});

describe("/exo review (D-097)", () => {
	it("runs in the background and offers the findings, also before any request", async () => {
		const sup = createSupervisor(
			{ reviewPasses: 2 },
			context({
				verdict: COMPLETE,
				passes: [[finding("strip() on None crashes")], [finding("strip() on None crashes")]],
			}),
		);
		writeFileSync(join(repo, "app.py"), CHANGED);
		expect(await sup.command?.("review")).toBe(
			"Reviewing the changes in the background. The findings will go in your editor; Escape or a new message stops the review.",
		);
		const action = await lastJob();
		expect(action).toMatchObject({ kind: "suggest" });
		expect(textOf(action)).toContain("strip() on None crashes");
		expect(findPrompts()[0]).toContain("No request was given");
		expect(reviews()).toEqual([expect.objectContaining({ trigger: "command" })]);
	});

	it("does not report a bug twice once its follow-up was used, and finds again one never taken", async () => {
		const passes = [[finding("strip() on None crashes")], [finding("strip() on None crashes")]];
		const sup = createSupervisor(
			{ reviewPasses: 2 },
			context({ verdict: COMPLETE, passes: [...passes, ...passes, ...passes] }),
		);
		await begin(sup, REQUEST);
		writeFileSync(join(repo, "app.py"), CHANGED);
		// Offered beside a draft and never added: not reported.
		await sup.command?.("review");
		expect(await lastJob()).toMatchObject({ kind: "suggest" });
		await sup.command?.("review");
		const used = await lastJob();
		expect(used).toMatchObject({ kind: "suggest" });
		used?.commit?.();
		await sup.command?.("review");
		expect(await lastJob()).toMatchObject({ kind: "notify", summary: expect.stringContaining("nothing that held up") });
		expect(reviews()[2]).toMatchObject({ repeated: 1, kept: [] });
	});

	it("says when there is nothing to review, when the engine does not answer, and when it cannot run", async () => {
		const sup = createSupervisor({}, context({ verdict: COMPLETE, passes: [] }));
		await sup.command?.("review");
		expect(await lastJob()).toMatchObject({ summary: "supervisor: no changes to review since the task began" });
		expect(await sup.command?.("something else")).toBeUndefined();

		writeFileSync(join(repo, "app.py"), CHANGED);
		const offline = createSupervisor({}, { ...context({ verdict: COMPLETE, passes: [] }), pool: () => undefined });
		await offline.command?.("review");
		expect(await lastJob()).toMatchObject({ level: "warning", summary: expect.stringContaining("no answer") });

		const headless = createSupervisor({}, context({ verdict: COMPLETE, passes: [] }, { background: false }));
		expect(await headless.command?.("review")).toContain("needs pi's interactive UI");
	});

	it("keeps what it reported across a rebuild", async () => {
		const saved: JsonValue[] = [];
		const passes = [[finding("strip() on None crashes")], [finding("strip() on None crashes")]];
		const sup = createSupervisor({ reviewPasses: 2 }, context({ verdict: COMPLETE, passes }, { saved }));
		await begin(sup, REQUEST);
		writeFileSync(join(repo, "app.py"), CHANGED);
		await sup.onSettle?.(DONE, signal);
		await sup.command?.("review");
		const used = await lastJob();
		expect(used).toMatchObject({ kind: "suggest" });
		used?.commit?.();
		await new Promise((resolve) => setImmediate(resolve));

		const rebuilt = createSupervisor(
			{ reviewPasses: 2 },
			context({ verdict: COMPLETE, passes: [...passes] }, { savedState: saved.at(-1) }),
		);
		await rebuilt.command?.("review");
		expect(await lastJob()).toMatchObject({ summary: expect.stringContaining("nothing that held up") });
	});
});

describe("review helpers", () => {
	it("reads the names functions are declared with", () => {
		expect(declaredName("def greet(name):")).toBe("greet");
		expect(declaredName("export async function load(path: string) {")).toBe("load");
		expect(declaredName("pub fn parse<T>(s: &str) -> T {")).toBe("parse");
		expect(declaredName("func (s *Server) Serve(addr string) error {")).toBe("Serve");
		expect(declaredName("export const run = async (x) => {")).toBe("run");
		expect(declaredName("  private render(): string {")).toBe("render");
		expect(declaredName("  if (ready) {")).toBeUndefined();
		expect(declaredName("x = 1")).toBeUndefined();
	});

	it("finds functions whose declaration changed, not those that only moved", () => {
		const diff = [
			"diff --git a/a.py b/a.py",
			"-def shout(text):",
			"+def shout(text, suffix):",
			"-def moved(x):",
			"+def moved(x):",
			"-def go(x):",
		].join("\n");
		expect(changedSignatures(diff)).toEqual(["shout"]);
	});

	it("finds no uses when there are no names, nor outside a repository", async () => {
		const ctx = context({ verdict: COMPLETE, passes: [] });
		expect(await usesOf(ctx, [], "")).toBeUndefined();
		const outside = { ...ctx, runCommand: ctx.runCommand.bind(null) };
		const elsewhere = mkdtempSync(join(tmpdir(), "exo-norepo-"));
		try {
			const noRepo: ModuleContext = {
				...outside,
				runCommand: (command, opts) => runShellCommand(command, { cwd: elsewhere, ...opts }),
			};
			expect(await usesOf(noRepo, ["zzz_nothing"], "")).toBeUndefined();
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("splits a diff by file, compares titles and keys findings by their line", () => {
		expect(fileSections("diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2\n").map((s) => s.path)).toEqual(["x", "y"]);
		expect(similarity("strip on None crashes", "crashes when strip gets None")).toBeGreaterThanOrEqual(0.5);
		expect(similarity("off by one", "")).toBe(0);
		expect(findingKey({ file: "a", quote: "  x  =  1 " })).toBe(findingKey({ file: "a", quote: "x = 1" }));
		expect(reviewMessage([{ ...finding("t"), severity: "low", votes: 2, reason: "" }])).toContain("1. app.py: t");
	});
});
