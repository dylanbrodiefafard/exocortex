import type {
	CompactionRequest,
	ExoModule,
	ModuleContext,
	ModuleFactory,
	SettleAction,
	SettleInfo,
	ToolOutcome,
	ToolResultDraft,
	ToolRewrite,
	UserTurn,
} from "@exocortex/core";
import { afterEach, describe, expect, it } from "vitest";
import { registerModuleHost } from "../src/modules.ts";
import { type AdapterHarness, createAdapterHarness } from "./harness.ts";

interface Probe {
	turns: UserTurn[];
	tools: ToolOutcome[];
	settles: SettleInfo[];
	context?: ModuleContext;
}

function probeModule(
	id: string,
	probe: Probe,
	action?: () => SettleAction | undefined | Promise<SettleAction | undefined>,
) {
	return (_settings: Readonly<Record<string, unknown>>, context: ModuleContext): ExoModule => {
		probe.context = context;
		return {
			id,
			onUserTurn: (turn) => probe.turns.push(turn),
			onToolResult: (tool) => probe.tools.push(tool),
			...(action
				? {
						onSettle: async (info: SettleInfo) => {
							probe.settles.push(info);
							return action();
						},
					}
				: {}),
			status: () => `${id} ok`,
		};
	};
}

const newProbe = (): Probe => ({ turns: [], tools: [], settles: [] });

const settleEvent = (text = "done") => ({
	outcome: "completed",
	context: {
		llmMessages: [
			{ role: "user", content: "do it" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hm" },
					{ type: "text", text },
				],
			},
			{ role: "toolResult", content: "x" },
		],
	},
});

let harness: AdapterHarness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

function setup(
	modules: Record<string, ModuleFactory>,
	enabled: Record<string, Record<string, unknown>>,
	options: {
		hasUI?: boolean;
		budgetsMs?: { rewrite?: number; settle?: number; compact?: number; userTurn?: number };
	} = {},
) {
	harness = createAdapterHarness({ modules: enabled }, options);
	const logs: string[] = [];
	registerModuleHost(harness.pi.api, {
		runtime: harness.runtime,
		onError: harness.onError,
		log: (message) => logs.push(message),
		modules,
		...(options.budgetsMs ? { budgetsMs: options.budgetsMs } : {}),
	});
	return { h: harness, logs };
}

describe("module host", () => {
	it("builds only enabled modules at session_start and reports their status", async () => {
		const a = newProbe();
		const b = newProbe();
		const { h } = setup(
			{ a: probeModule("a", a), b: probeModule("b", b) },
			{ a: { enabled: true }, b: { enabled: false } },
		);
		await h.pi.emit("session_start", { reason: "startup" });
		expect(h.runtime.moduleStatus()).toEqual(["a ok"]);
		expect(h.runtime.moduleIds()).toEqual(["a", "b"]);
		expect(a.context?.cwd).toBe(h.dir);
		expect(b.context).toBeUndefined();
	});

	it("forwards user turns and tool results", async () => {
		const a = newProbe();
		const { h } = setup({ a: probeModule("a", a) }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		await h.pi.emit("input", { text: "hello", source: "interactive" });
		await h.pi.emit("input", { text: "go on", source: "extension" });
		await h.pi.emit("tool_result", {
			toolName: "bash",
			input: { command: "make" },
			isError: true,
			structuredContent: { exit_code: 2 },
			content: [
				{ type: "text", text: "line 1" },
				{ type: "image", data: "…" },
				{ type: "text", text: "line 2" },
			],
		});
		await h.pi.emit("tool_result", { toolName: "read", input: "not an object", isError: false, content: "raw" });
		expect(a.turns).toEqual([
			{ text: "hello", origin: "user" },
			{ text: "go on", origin: "extension" },
		]);
		expect(a.tools).toEqual([
			{ toolName: "bash", input: { command: "make" }, isError: true, exitCode: 2, output: "line 1\nline 2" },
			{ toolName: "read", input: {}, isError: false, exitCode: null, output: "raw" },
		]);
	});

	it("a suggestion pre-fills the editor and does not continue", async () => {
		const a = newProbe();
		const { h } = setup(
			{ a: probeModule("a", a, () => ({ kind: "suggest", text: "run the tests", summary: "tests not run" })) },
			{ a: { enabled: true } },
		);
		await h.pi.emit("session_start");
		const result = await h.pi.emit("agent_before_settle", settleEvent("all good"));
		expect(result).toBeUndefined();
		expect(a.settles).toEqual([{ outcome: "completed", lastAssistantText: "all good" }]);
		expect(h.pi.ui).toContainEqual({ method: "setEditorText", args: ["run the tests"] });
		expect(h.pi.ui.some((c) => c.method === "notify" && String(c.args[0]).includes("tests not run"))).toBe(true);
	});

	it("a continuation injects a tagged custom message, continues, and is traced", async () => {
		const a = newProbe();
		const { h } = setup(
			{ a: probeModule("a", a, () => ({ kind: "continue", text: "keep going", summary: "unfinished" })) },
			{ a: { enabled: true } },
		);
		const traced: unknown[] = [];
		await h.pi.emit("session_start");
		h.runtime.traceSession = { append: (e: unknown) => traced.push(e) } as never;
		const result = await h.pi.emit("agent_before_settle", settleEvent());
		expect(result).toEqual({
			entries: [
				{
					type: "custom_message",
					customType: "exo.a",
					content: "keep going",
					display: true,
					details: { exo: { module: "a" } },
				},
			],
			continue: true,
		});
		expect(traced).toEqual([
			{
				kind: "message",
				synthetic: true,
				module: "a",
				data: { role: "custom", customType: "exo.a", content: "keep going" },
			},
		]);
	});

	it("notify is non-terminal: the next module's action still applies", async () => {
		const a = newProbe();
		const b = newProbe();
		const { h } = setup(
			{
				a: probeModule("a", a, () => ({ kind: "notify", summary: "careful", level: "warning" })),
				b: probeModule("b", b, () => ({ kind: "continue", text: "more", summary: "s" })),
			},
			{ a: { enabled: true }, b: { enabled: true } },
		);
		await h.pi.emit("session_start");
		const result = (await h.pi.emit("agent_before_settle", settleEvent())) as { continue: boolean };
		expect(result.continue).toBe(true);
		expect(h.pi.ui).toContainEqual({ method: "notify", args: ["careful", "warning"] });
	});

	it("info notifications only touch the status line", async () => {
		const a = newProbe();
		const { h } = setup(
			{ a: probeModule("a", a, () => ({ kind: "notify", summary: "fine", level: "info" })) },
			{ a: { enabled: true } },
		);
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		expect(h.pi.ui.filter((c) => c.method === "notify")).toEqual([]);
		expect(h.pi.ui).toContainEqual({ method: "setStatus", args: ["exo", "exo: fine"] });
	});

	it("isolates module failures: throwing factories, hooks and settles", async () => {
		const a = newProbe();
		const { h } = setup(
			{
				broken: () => {
					throw new Error("factory");
				},
				throwing: () => ({
					id: "throwing",
					onUserTurn: () => {
						throw new Error("turn");
					},
					onSettle: async () => {
						throw new Error("settle");
					},
				}),
				a: probeModule("a", a, () => ({ kind: "suggest", text: "t", summary: "s" })),
			},
			{ broken: { enabled: true }, throwing: { enabled: true }, a: { enabled: true } },
		);
		await h.pi.emit("session_start");
		await h.pi.emit("input", { text: "x", source: "interactive" });
		await h.pi.emit("agent_before_settle", settleEvent());
		expect(h.errors.map((e) => e.where)).toEqual(["module broken", "throwing.onUserTurn", "throwing.onSettle"]);
		expect(a.turns).toHaveLength(1);
		expect(a.settles).toHaveLength(1);
	});

	it("without a UI, suggestions are dropped silently", async () => {
		const a = newProbe();
		const { h } = setup(
			{ a: probeModule("a", a, () => ({ kind: "suggest", text: "t", summary: "s" })) },
			{ a: { enabled: true } },
			{ hasUI: false },
		);
		await h.pi.emit("session_start", {}, h.pi.ctx({ hasUI: false }));
		const result = await h.pi.emit("agent_before_settle", settleEvent(), h.pi.ctx({ hasUI: false }));
		expect(result).toBeUndefined();
		expect(h.pi.ui).toEqual([]);
	});

	it("overrides rebuild modules: kill switch and per-module settings", async () => {
		const a = newProbe();
		const seen: Readonly<Record<string, unknown>>[] = [];
		const { h } = setup(
			{
				a: (settings, context) => {
					seen.push(settings);
					return probeModule("a", a)(settings, context);
				},
			},
			{ a: { enabled: false, mode: "suggest" } },
		);
		await h.pi.emit("session_start");
		expect(h.runtime.moduleStatus()).toEqual([]);
		h.runtime.overrides.modules["a"] = { enabled: true, mode: "auto" };
		h.runtime.rebuildModules();
		expect(h.runtime.moduleStatus()).toEqual(["a ok"]);
		expect(seen.at(-1)).toMatchObject({ enabled: true, mode: "auto" });
		h.runtime.overrides.allOff = true;
		h.runtime.rebuildModules();
		expect(h.runtime.moduleStatus()).toEqual([]);
	});

	it("clears the 'checking' status when no module acts", async () => {
		const a = newProbe();
		const { h } = setup({ a: probeModule("a", a, () => undefined) }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		expect(h.pi.ui.filter((c) => c.method === "setStatus").map((c) => c.args)).toEqual([
			["exo", "exo: checking the work…"],
			["exo", undefined],
		]);
	});

	it("does nothing when no module settles, and forgets modules at shutdown", async () => {
		const a = newProbe();
		const { h } = setup({ a: probeModule("a", a) }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		expect(await h.pi.emit("agent_before_settle", settleEvent())).toBeUndefined();
		await h.pi.emit("session_shutdown");
		await h.pi.emit("input", { text: "x", source: "interactive" });
		expect(a.turns).toEqual([]);
	});

	it("module contexts record synthetic trace events and log with the module id", async () => {
		const a = newProbe();
		const { h, logs } = setup({ a: probeModule("a", a) }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		const traced: unknown[] = [];
		h.runtime.traceSession = { append: (e: unknown) => traced.push(e) } as never;
		a.context?.record({ kind: "exo.verdict", data: { v: 1 } });
		a.context?.log("hello");
		const out = await a.context?.runCommand("echo hi", { timeoutMs: 5_000 });
		expect(traced).toEqual([{ kind: "exo.verdict", data: { v: 1 }, module: "a", synthetic: true }]);
		expect(logs).toEqual(["a: hello"]);
		expect(out?.exitCode).toBe(0);
		expect(out?.outputTail).toContain("hi");
		expect(a.context?.pool()).toBeUndefined();
	});
});

function rewriter(id: string, fn: (draft: ToolResultDraft, signal: AbortSignal) => Promise<ToolRewrite | undefined>) {
	return (): ExoModule => ({ id, rewriteToolResult: fn });
}

const bashResult = (text: string, extra: Record<string, unknown> = {}) => ({
	toolName: "bash",
	toolCallId: "call-1",
	input: { command: "make" },
	isError: true,
	content: [{ type: "text", text }],
	details: { fullOutputPath: "/tmp/full.log", exo: { earlier: true } },
	structuredContent: { exit_code: 2, output: text },
	...extra,
});

describe("tool-result rewrites", () => {
	it("chains rewrites, merges details.exo, keeps structuredContent and traces each rewrite", async () => {
		const drafts: ToolResultDraft[] = [];
		const { h } = setup(
			{
				trim: rewriter("trim", async (d) => {
					drafts.push(d);
					return { text: `${d.current} [trimmed]`, note: "trimmed" };
				}),
				triage: rewriter("triage", async (d) => {
					drafts.push(d);
					return { text: `${d.current} [hint]`, note: "hint" };
				}),
			},
			{ trim: { enabled: true }, triage: { enabled: true } },
		);
		await h.pi.emit("session_start");
		const traced: unknown[] = [];
		h.runtime.traceSession = { append: (e: unknown) => traced.push(e) } as never;
		const result = await h.pi.emit("tool_result", bashResult("boom"));
		expect(drafts.map((d) => d.current)).toEqual(["boom", "boom [trimmed]"]);
		expect(drafts[0]).toMatchObject({
			toolCallId: "call-1",
			exitCode: 2,
			fullOutputPath: "/tmp/full.log",
			output: "boom",
		});
		expect(result).toEqual({
			content: [{ type: "text", text: "boom [trimmed] [hint]" }],
			details: {
				fullOutputPath: "/tmp/full.log",
				exo: {
					earlier: true,
					rewrites: [
						{ module: "trim", note: "trimmed" },
						{ module: "triage", note: "hint" },
					],
				},
			},
			structuredContent: { exit_code: 2, output: "boom" },
		});
		expect(traced).toEqual([
			{
				kind: "exo.rewrite",
				synthetic: true,
				module: "trim",
				data: { toolCallId: "call-1", note: "trimmed", chars: 14 },
			},
			{
				kind: "exo.rewrite",
				synthetic: true,
				module: "triage",
				data: { toolCallId: "call-1", note: "hint", chars: 21 },
			},
		]);
	});

	it("leaves results alone when nothing changes, and never touches non-text content", async () => {
		const calls: string[] = [];
		const { h } = setup(
			{
				same: rewriter("same", async (d) => {
					calls.push(d.current);
					return { text: d.current, note: "noop" };
				}),
				none: rewriter("none", async () => undefined),
			},
			{ same: { enabled: true }, none: { enabled: true } },
		);
		await h.pi.emit("session_start");
		expect(await h.pi.emit("tool_result", bashResult("x"))).toBeUndefined();
		const image = bashResult("x", { content: [{ type: "image", data: "…", mimeType: "image/png" }] });
		expect(await h.pi.emit("tool_result", image)).toBeUndefined();
		expect(calls).toEqual(["x"]);
	});

	it("reads the full-output path from structuredContent and tolerates missing details", async () => {
		const drafts: ToolResultDraft[] = [];
		const { h } = setup(
			{
				a: rewriter("a", async (d) => {
					drafts.push(d);
					return { text: "short", note: "n" };
				}),
			},
			{ a: { enabled: true } },
		);
		await h.pi.emit("session_start");
		const result = (await h.pi.emit(
			"tool_result",
			bashResult("long", { details: undefined, structuredContent: { full_output_path: "/tmp/s.log" } }),
		)) as { details: unknown };
		expect(drafts[0]?.fullOutputPath).toBe("/tmp/s.log");
		expect(result.details).toEqual({ exo: { rewrites: [{ module: "a", note: "n" }] } });
		await h.pi.emit("tool_result", bashResult("long", { details: {}, structuredContent: undefined }));
		expect(drafts[1]?.fullOutputPath).toBeNull();
	});

	it("isolates a throwing rewriter and stops a hanging one at the budget", async () => {
		const { h } = setup(
			{
				throws: rewriter("throws", async () => {
					throw new Error("bad");
				}),
				hangs: rewriter("hangs", () => new Promise(() => {})),
				late: rewriter("late", async (d) => ({ text: `${d.current}!`, note: "late" })),
			},
			{ throws: { enabled: true }, hangs: { enabled: true }, late: { enabled: true } },
			{ budgetsMs: { rewrite: 50 } },
		);
		await h.pi.emit("session_start");
		const started = Date.now();
		expect(await h.pi.emit("tool_result", bashResult("x"))).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(h.errors.map((e) => e.where)).toEqual(["throws.rewriteToolResult"]);
	});
});

function compactEvent(signal = new AbortController().signal) {
	return {
		reason: "threshold",
		customInstructions: "focus",
		willRetry: false,
		signal,
		branchEntries: [],
		preparation: {
			firstKeptEntryId: "entry-9",
			tokensBefore: 150_000,
			isSplitTurn: true,
			previousSummary: "old summary",
			messagesToSummarize: [
				{ role: "user", content: "implement forth", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "on it" }], timestamp: 2 },
			],
			turnPrefixMessages: [{ role: "user", content: [{ type: "text", text: "and tests" }], timestamp: 3 }],
			fileOps: { read: new Set(["a.rs", "b.rs"]), written: new Set(["b.rs"]), edited: new Set(["c.rs"]) },
			settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		},
	};
}

describe("compaction hosting", () => {
	it("passes a harness-agnostic request and returns the first module summary", async () => {
		const requests: CompactionRequest[] = [];
		const { h } = setup(
			{
				none: () => ({ id: "none", compact: async () => undefined }),
				writer: () => ({
					id: "writer",
					compact: async (request) => {
						requests.push(request);
						return "the summary";
					},
				}),
				later: () => ({ id: "later", compact: async () => "never used" }),
			},
			{ none: { enabled: true }, writer: { enabled: true }, later: { enabled: true } },
		);
		await h.pi.emit("session_start");
		const result = await h.pi.emit("session_before_compact", compactEvent());
		expect(result).toEqual({
			compaction: {
				summary: "the summary",
				firstKeptEntryId: "entry-9",
				tokensBefore: 150_000,
				details: { exo: { module: "writer" } },
			},
		});
		const [request] = requests;
		expect(request).toMatchObject({
			reason: "threshold",
			userMessages: ["implement forth", "and tests"],
			previousSummary: "old summary",
			filesRead: ["a.rs"],
			filesModified: ["b.rs", "c.rs"],
			tokensBefore: 150_000,
			customInstructions: "focus",
		});
		expect(request?.conversation).toContain("[User]: implement forth");
		expect(request?.conversation).toContain("[Assistant]: on it");
		expect(request?.conversation).toContain("[User]: and tests");
	});

	it("falls back to pi's compaction on failure, on budget and on pi's abort", async () => {
		const { h } = setup(
			{
				throws: () => ({
					id: "throws",
					compact: async () => {
						throw new Error("bad");
					},
				}),
				hangs: () => ({ id: "hangs", compact: () => new Promise<string | undefined>(() => {}) }),
			},
			{ throws: { enabled: true }, hangs: { enabled: true } },
			{ budgetsMs: { compact: 50 } },
		);
		await h.pi.emit("session_start");
		expect(await h.pi.emit("session_before_compact", compactEvent())).toBeUndefined();
		expect(h.errors.map((e) => e.where)).toEqual(["throws.compact"]);
		const aborted = new AbortController();
		aborted.abort();
		expect(await h.pi.emit("session_before_compact", compactEvent(aborted.signal))).toBeUndefined();
	});

	it("does nothing without compacting modules", async () => {
		const { h: empty } = setup({ a: probeModule("a", newProbe()) }, { a: { enabled: true } });
		await empty.pi.emit("session_start");
		expect(await empty.pi.emit("session_before_compact", compactEvent())).toBeUndefined();
	});
});

describe("user-turn context, suggestions and module commands", () => {
	it("adds modules' context as one tagged message after the user's prompt, once per prompt", async () => {
		const seen: UserTurn[] = [];
		const provider = (id: string, text: string | undefined) => (): ExoModule => ({
			id,
			contextForUserTurn: async (turn) => {
				seen.push(turn);
				return text;
			},
		});
		const { h } = setup(
			{ a: provider("a", " remember A "), b: provider("b", undefined), c: provider("c", "remember C") },
			{ a: { enabled: true }, b: { enabled: true }, c: { enabled: true } },
		);
		await h.pi.emit("session_start");
		expect(await h.pi.emit("before_agent_start", { prompt: "x" })).toBeUndefined();
		await h.pi.emit("input", { text: "add a parser", source: "interactive" });
		expect(await h.pi.emit("before_agent_start", { prompt: "add a parser" })).toEqual({
			message: {
				customType: "exo.a",
				content: "remember A\n\nremember C",
				display: true,
				details: { exo: { module: "a", modules: ["a", "c"] } },
			},
		});
		expect(seen[0]).toEqual({ text: "add a parser", origin: "user" });
		expect(await h.pi.emit("before_agent_start", { prompt: "add a parser" })).toBeUndefined();
	});

	it("gives up on slow or failing context providers without holding the prompt", async () => {
		const { h } = setup(
			{
				slow: (): ExoModule => ({ id: "slow", contextForUserTurn: () => new Promise(() => {}) }),
				bad: (): ExoModule => ({
					id: "bad",
					contextForUserTurn: async () => {
						throw new Error("boom");
					},
				}),
			},
			{ slow: { enabled: true }, bad: { enabled: true } },
			{ budgetsMs: { userTurn: 20 } },
		);
		await h.pi.emit("session_start");
		await h.pi.emit("input", { text: "go", source: "interactive" });
		expect(await h.pi.emit("before_agent_start", {})).toBeUndefined();
		await h.pi.emit("input", { text: "go", source: "interactive" });
		h.runtime.overrides.modules["slow"] = { enabled: false };
		h.runtime.rebuildModules();
		expect(await h.pi.emit("before_agent_start", {})).toBeUndefined();
		expect(h.errors.map((e) => e.where)).toEqual(["bad.contextForUserTurn"]);
	});

	it("marks a suggestion the user sent unchanged, and tells modules about compactions", async () => {
		const a = newProbe();
		let compacted = 0;
		const { h } = setup(
			{
				a: probeModule("a", a, () => ({
					kind: "suggest",
					text: "Not done yet.\n1. Add the README",
					summary: "1 item",
				})),
				b: (): ExoModule => ({ id: "b", onCompacted: () => void compacted++ }),
			},
			{ a: { enabled: true }, b: { enabled: true } },
		);
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		await h.pi.emit("input", { text: "Not done yet.  1. Add the README\n", source: "interactive" });
		await h.pi.emit("agent_before_settle", settleEvent());
		await h.pi.emit("input", { text: "Not done yet. 1. Add the README, and a changelog", source: "interactive" });
		await h.pi.emit("input", { text: "Not done yet.\n1. Add the README", source: "interactive" });
		expect(a.turns.map((t) => t.origin)).toEqual(["suggestion", "user", "user"]);
		await h.pi.emit("session_compact", { reason: "threshold" });
		expect(compacted).toBe(1);
	});

	it("routes /exo <module> <args> to the module and traces rewrite details", async () => {
		const { h } = setup(
			{
				a: (): ExoModule => ({
					id: "a",
					command: (args) => (args === "list things" ? "two things" : undefined),
					rewriteToolResult: async (d) => ({ text: `${d.current}!`, note: "n", details: { fullOutputPath: "/tmp/f" } }),
				}),
				bad: (): ExoModule => ({
					id: "bad",
					command: () => {
						throw new Error("boom");
					},
				}),
			},
			{ a: { enabled: true }, bad: { enabled: true } },
		);
		await h.pi.emit("session_start");
		expect(await h.runtime.moduleCommand("a", "list things")).toBe("two things");
		expect(await h.runtime.moduleCommand("a", "on")).toBeUndefined();
		expect(await h.runtime.moduleCommand("missing", "x")).toBeUndefined();
		expect(await h.runtime.moduleCommand("bad", "x")).toBeUndefined();
		expect(h.errors.map((e) => e.where)).toEqual(["bad.command"]);
		const traced: { data: unknown }[] = [];
		h.runtime.traceSession = { append: (e: { data: unknown }) => traced.push(e) } as never;
		await h.pi.emit("tool_result", bashResult("boom"));
		expect(traced[0]?.data).toEqual({ fullOutputPath: "/tmp/f", toolCallId: "call-1", note: "n", chars: 5 });
	});
});

describe("progress while a hook holds pi", () => {
	const statuses = (h: AdapterHarness) =>
		h.pi.ui
			.filter((c) => c.method === "setStatus" || c.method === "setWorkingMessage")
			.map((c) => [c.method, ...c.args]);

	it("shows a module's progress on the status line and the spinner, then restores both", async () => {
		let context: ModuleContext | undefined;
		const { h } = setup(
			{
				a: (_settings, ctx): ExoModule => {
					context = ctx;
					return {
						id: "a",
						contextForUserTurn: async () => {
							ctx.progress("Recalling your preferences…");
							return "note";
						},
						rewriteToolResult: async () => undefined,
						onSettle: async () => ({ kind: "notify", summary: "a: complete", level: "info" }),
					};
				},
			},
			{ a: { enabled: true } },
		);
		await h.pi.emit("session_start");
		await h.pi.emit("input", { text: "add a parser", source: "interactive" });
		await h.pi.emit("before_agent_start", {});
		expect(statuses(h)).toEqual([
			["setStatus", "exo", "exo: Recalling your preferences…"],
			["setWorkingMessage", "Recalling your preferences…"],
			["setStatus", "exo", undefined],
			["setWorkingMessage"],
		]);

		// A hook that reports nothing touches nothing; progress outside a hook is dropped.
		h.pi.ui.length = 0;
		await h.pi.emit("tool_result", bashResult("boom"));
		context?.progress("too late");
		expect(statuses(h)).toEqual([]);

		// After a settle left a status, progress gives it back when done.
		await h.pi.emit("agent_before_settle", settleEvent());
		h.pi.ui.length = 0;
		await h.pi.emit("input", { text: "now add tests", source: "interactive" });
		await h.pi.emit("before_agent_start", {});
		expect(statuses(h).at(-2)).toEqual(["setStatus", "exo", "exo: a: complete"]);
	});

	it("keeps the message until the last of several concurrent hooks returns, and is silent without a UI", async () => {
		const release: (() => void)[] = [];
		const module = (): ModuleFactory => (_settings, ctx) => ({
			id: "a",
			rewriteToolResult: async () => {
				ctx.progress("Trimming noisy output…");
				await new Promise<void>((resolve) => release.push(resolve));
				return undefined;
			},
		});
		const { h } = setup({ a: module() }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		const first = h.pi.emit("tool_result", bashResult("one"));
		const second = h.pi.emit("tool_result", bashResult("two"));
		await new Promise((r) => setTimeout(r, 10));
		release[0]?.();
		await first;
		expect(statuses(h).some((c) => c[0] === "setWorkingMessage" && c.length === 1)).toBe(false);
		release[1]?.();
		await second;
		expect(statuses(h).slice(-2)).toEqual([["setStatus", "exo", undefined], ["setWorkingMessage"]]);

		const headless = setup({ a: module() }, { a: { enabled: true } }, { hasUI: false });
		await headless.h.pi.emit("session_start", {}, headless.h.pi.ctx({ hasUI: false }));
		const held = headless.h.pi.emit("tool_result", bashResult("x"), headless.h.pi.ctx({ hasUI: false }));
		await new Promise((r) => setTimeout(r, 10));
		release[2]?.();
		await held;
		expect(statuses(headless.h)).toEqual([]);
	});
});
