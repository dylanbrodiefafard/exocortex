import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ModuleHostOptions, registerModuleHost } from "../src/modules.ts";
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
		budgetsMs?: { rewrite?: number; toolCall?: number; settle?: number; compact?: number; userTurn?: number };
		host?: Pick<ModuleHostOptions, "harnessSummary" | "piCompactionSettings">;
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
		...options.host,
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
		expect(a.settles).toEqual([{ outcome: "completed", lastAssistantText: "all good", assistantTexts: ["all good"] }]);
		expect(h.pi.ui).toContainEqual({ method: "setEditorText", args: ["run the tests"] });
		// The editor and the status line say it; no notification on top (D-106).
		expect(h.pi.ui).toContainEqual({
			method: "setStatus",
			args: ["exo", "exo: tests not run (follow-up in the editor: Enter sends it)"],
		});
		expect(h.pi.ui.some((c) => c.method === "notify")).toBe(false);
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

	it("says nothing on the status line for a settle that is quick and finds nothing (D-106)", async () => {
		const a = newProbe();
		const { h } = setup({ a: probeModule("a", a, () => undefined) }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		expect(h.pi.ui.filter((c) => c.method === "setStatus")).toEqual([]);
	});

	it("says it is checking the work once settling takes a while, and clears it after (D-106)", async () => {
		const { h } = setup(
			{
				a: () => ({
					id: "a",
					onSettle: () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 400)),
				}),
			},
			{ a: { enabled: true } },
		);
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		expect(h.pi.ui.filter((c) => c.method === "setStatus").map((c) => c.args[1])).toEqual([
			"exo: checking the work…",
			undefined,
		]);
	});

	it("reports a status line that throws while settling, instead of throwing from a timer", async () => {
		const { h } = setup(
			{
				a: () => ({
					id: "a",
					onSettle: () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 400)),
				}),
			},
			{ a: { enabled: true } },
		);
		await h.pi.emit("session_start");
		const ctx = h.pi.ctx();
		ctx.ui.setStatus = () => {
			throw new Error("stale UI");
		};
		await h.pi.emit("agent_before_settle", settleEvent(), ctx);
		expect(h.errors.map((e) => e.where)).toContain("modules.progress");
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

describe("runs whose exit code a pipe hid (D-075)", () => {
	it("reads the output once and tells every module, and says nothing about other calls", async () => {
		const a = newProbe();
		const b = newProbe();
		const { h } = setup(
			{ a: probeModule("a", a), b: probeModule("b", b) },
			{ a: { enabled: true }, b: { enabled: true } },
		);
		await h.pi.emit("session_start");
		const run = (command: string, text: string) =>
			h.pi.emit("tool_result", {
				toolName: "bash",
				toolCallId: "c1",
				input: { command },
				isError: false,
				structuredContent: { exit_code: 0 },
				content: [{ type: "text", text }],
			});
		await run("cargo test 2>&1 | tail -3", "test result: ok. 4 passed; 0 failed");
		await run("cargo test 2>&1 | tail -3", "test a ... FAILED");
		await run("cargo test 2>&1 | grep -c ok", "4");
		await run("cargo test", "test result: ok. 4 passed; 0 failed");
		expect(a.tools.map((t) => t.hidden)).toEqual(["passed", "failed", "unknown", undefined]);
		expect(b.tools).toEqual(a.tools);
		expect(h.errors).toEqual([]);
	});
});

describe("tool-result rewrites", () => {
	it("tells modules which part of the text is bash's exit status", async () => {
		const drafts: ToolResultDraft[] = [];
		const { h } = setup(
			{
				trim: rewriter("trim", async (d) => {
					drafts.push(d);
					return undefined;
				}),
			},
			{ trim: { enabled: true } },
		);
		await h.pi.emit("session_start");
		await h.pi.emit("tool_result", bashResult("boom\n\nCommand exited with code 2"));
		expect(drafts[0]?.status).toBe("Command exited with code 2");
	});

	it("finds the saved output and the status of a command that timed out, from the text alone (D-110)", async () => {
		const drafts: ToolResultDraft[] = [];
		const { h } = setup(
			{
				trim: rewriter("trim", async (d) => {
					drafts.push(d);
					return undefined;
				}),
			},
			{ trim: { enabled: true } },
		);
		await h.pi.emit("session_start");
		// Pi throws on a timeout: the result keeps no details, only the text.
		const text =
			"tail\n\n[Showing lines 9-10 of 10 (50.0KB limit). Full output: /tmp/pi-bash-1.log]\n\nCommand timed out after 30 seconds";
		await h.pi.emit("tool_result", bashResult(text, { details: undefined, structuredContent: undefined }));
		expect(drafts[0]).toMatchObject({
			fullOutputPath: "/tmp/pi-bash-1.log",
			status: "Command timed out after 30 seconds",
		});
		await h.pi.emit("tool_result", bashResult("Command aborted", { details: undefined, structuredContent: undefined }));
		expect(drafts[1]).toMatchObject({ fullOutputPath: null, status: "Command aborted" });
	});

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
			status: null,
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

	it("isolates a throwing rewriter and stops a hanging one at its share of the budget", async () => {
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
		// The hanging module loses only its own share (D-078): the one after it still runs.
		expect(await h.pi.emit("tool_result", bashResult("x"))).toMatchObject({ content: [{ type: "text", text: "x!" }] });
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(h.errors.map((e) => e.where)).toEqual(["throws.rewriteToolResult"]);
	});
});

describe("looking before a tool runs (D-094)", () => {
	function looker(id: string, seen: unknown[], look: () => Promise<void> = async () => {}): ModuleFactory {
		return () => ({
			id,
			beforeToolCall: async (call) => {
				seen.push(call);
				await look();
			},
		});
	}

	it("offers a copy of each call, never blocks it, and skips calls another tool made", async () => {
		const seen: unknown[] = [];
		const { h } = setup(
			{
				throws: looker("throws", [], async () => {
					throw new Error("bad");
				}),
				hangs: looker("hangs", [], () => new Promise(() => {})),
				sees: looker("sees", seen),
			},
			{ throws: { enabled: true }, hangs: { enabled: true }, sees: { enabled: true } },
			{ budgetsMs: { toolCall: 60 } },
		);
		await h.pi.emit("session_start");
		const input = { path: "a.rs", edits: [{ oldText: "a", newText: "b" }] };
		const started = Date.now();
		expect(await h.pi.emit("tool_call", { toolName: "edit", toolCallId: "c1", input })).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(seen).toEqual([{ toolName: "edit", toolCallId: "c1", input }]);
		// A module's copy is not pi's input: changing it changes nothing pi runs.
		expect((seen[0] as { input: unknown }).input).not.toBe(input);
		expect(h.errors.map((e) => e.where)).toEqual(["throws.beforeToolCall"]);
		await h.pi.emit("tool_call", { toolName: "edit", toolCallId: "c1/1", parentToolCallId: "c1", input });
		expect(seen).toHaveLength(1);
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

describe("one rewrite budget per batch of tool results (D-098)", () => {
	it("shares the guard among a batch's results, and gives the next turn's batch its own", async () => {
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const { h } = setup(
			{
				slow: rewriter("slow", async (draft, signal) => {
					await sleep(80);
					return signal.aborted ? undefined : { text: `${draft.current} [seen]`, note: "seen" };
				}),
			},
			{ slow: { enabled: true } },
			// A rewriter may take a third of it: 93 ms, enough for 80.
			{ budgetsMs: { rewrite: 280 } },
		);
		await h.pi.emit("session_start");
		const text = (result: unknown) => JSON.stringify(result);
		const results: unknown[] = [];
		for (const id of ["a", "b", "c", "d"]) {
			results.push(await h.pi.emit("tool_result", bashResult(id, { toolCallId: id })));
		}
		expect(results.slice(0, 3).every((r) => text(r).includes("[seen]"))).toBe(true);
		// About 240 ms of the batch's 280 are gone: the fourth result's rewrite is cut short.
		expect(results[3]).toBeUndefined();
		await h.pi.emit("turn_end", {});
		const next = await h.pi.emit("tool_result", bashResult("next", { toolCallId: "e" }));
		expect(text(next)).toContain("[seen]");
	});

	it("does not charge the batch for a result that came while its other tools still ran", async () => {
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const { h } = setup(
			{ quick: rewriter("quick", async (draft) => ({ text: `${draft.current} [seen]`, note: "seen" })) },
			{ quick: { enabled: true } },
			{ budgetsMs: { rewrite: 300 } },
		);
		await h.pi.emit("session_start");
		// A read and a long test run in one batch.
		await h.pi.emit("tool_call", { toolName: "read", toolCallId: "a", input: { path: "x" } });
		await h.pi.emit("tool_call", { toolName: "bash", toolCallId: "b", input: { command: "npm test" } });
		const read = await h.pi.emit("tool_result", bashResult("read it", { toolCallId: "a" }));
		await sleep(400);
		// The test run finished well after the read's rewrite: its own rewrite still runs.
		const tests = await h.pi.emit("tool_result", bashResult("1 failing", { toolCallId: "b" }));
		expect(JSON.stringify(read)).toContain("[seen]");
		expect(JSON.stringify(tests)).toContain("[seen]");
	});
});

describe("compaction hosting", () => {
	it("serializes only the span's messages newer than a given time, for a summary written early (D-098)", async () => {
		const requests: CompactionRequest[] = [];
		const { h } = setup(
			{
				writer: () => ({
					id: "writer",
					compact: async (request) => {
						requests.push(request);
						return undefined;
					},
				}),
			},
			{ writer: { enabled: true } },
		);
		await h.pi.emit("session_start");
		await h.pi.emit("session_before_compact", compactEvent());
		const [request] = requests;
		expect(request?.conversationSince(0)).toBe(request?.conversation);
		expect(request?.conversationSince(2)).toContain("and tests");
		expect(request?.conversationSince(2)).not.toContain("implement forth");
		expect(request?.conversationSince(3)).toBe("");
	});

	it("tells settle hooks how full the context is and where pi compacts it, from pi's own settings (D-098, D-111)", async () => {
		const probe = newProbe();
		const { h } = setup({ a: probeModule("a", probe, () => undefined) }, { a: { enabled: true } });
		const agentDir = join(h.dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 30_000 } }));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		try {
			await h.pi.emit("session_start");
			const usage = (tokens: number | null) =>
				h.pi.ctx({
					getContextUsage: () => ({ tokens, contextWindow: 131_072, percent: null }),
					isProjectTrusted: () => false,
				});
			await h.pi.emit("agent_before_settle", settleEvent(), usage(90_000));
			await h.pi.emit("agent_before_settle", settleEvent(), usage(null));
			await h.pi.emit("agent_before_settle", settleEvent());
			// A compaction hands over the settings pi used: they are the ones from then on.
			await h.pi.emit("session_before_compact", compactEvent());
			await h.pi.emit("agent_before_settle", settleEvent(), usage(90_000));
		} finally {
			vi.unstubAllEnvs();
		}
		expect(probe.settles.map((s) => s.context)).toEqual([
			{ tokens: 90_000, compactAt: 131_072 - 30_000 },
			undefined,
			undefined,
			{ tokens: 90_000, compactAt: 131_072 - 1 },
		]);
	});

	it("takes pi's defaults when its settings cannot be read, and the window when it does not compact on its own", async () => {
		const probe = newProbe();
		const at = async (settings?: ModuleHostOptions["piCompactionSettings"]) => {
			probe.settles.length = 0;
			const { h } = setup(
				{ a: probeModule("a", probe, () => undefined) },
				{ a: { enabled: true } },
				settings ? { host: { piCompactionSettings: settings } } : {},
			);
			await h.pi.emit("session_start");
			// The fake has no `isProjectTrusted`: reading pi's settings throws.
			const ctx = h.pi.ctx({ getContextUsage: () => ({ tokens: 1, contextWindow: 131_072, percent: null }) });
			await h.pi.emit("agent_before_settle", settleEvent(), ctx);
			return probe.settles[0]?.context?.compactAt;
		};
		expect(await at()).toBe(131_072 - 16_384);
		expect(await at(() => ({ enabled: false, reserveTokens: 16_384 }))).toBe(131_072);
	});

	describe("pi's own summary with a module's facts after it (D-111)", () => {
		const factsModule = (committed: string[]) => () => ({
			id: "facts",
			compact: async () => ({
				summary: "## User requests (verbatim, oldest first)\n\n1. implement forth",
				part: "facts" as const,
				details: { facts: { v: 1 } },
				commit: () => committed.push("facts"),
			}),
		});
		const piResult = {
			summary: "pi's summary\n",
			firstKeptEntryId: "entry-9",
			tokensBefore: 150_000,
			usage: { input: 1 },
			details: { readFiles: ["a.rs"], modifiedFiles: ["b.rs"] },
		};

		it("follows pi's summary with the facts, and tells the user once per session", async () => {
			const committed: string[] = [];
			const calls: unknown[] = [];
			const { h, logs } = setup(
				{ facts: factsModule(committed) },
				{ facts: { enabled: true } },
				{
					host: {
						harnessSummary: async (event, _ctx, signal, retry) => {
							calls.push([event.reason, signal.aborted, retry]);
							return piResult as never;
						},
					},
				},
			);
			await h.pi.emit("session_start");
			const result = await h.pi.emit("session_before_compact", compactEvent());
			expect(result).toEqual({
				compaction: {
					summary: "pi's summary\n\n## User requests (verbatim, oldest first)\n\n1. implement forth",
					firstKeptEntryId: "entry-9",
					tokensBefore: 150_000,
					usage: { input: 1 },
					details: { readFiles: ["a.rs"], modifiedFiles: ["b.rs"], exo: { facts: { v: 1 }, module: "facts" } },
				},
			});
			// Pi's settings could not be read (the fake has no `isProjectTrusted`): pi's default retries.
			expect(calls).toEqual([
				["threshold", false, { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 }],
			]);
			expect(committed).toEqual(["facts"]);
			expect(logs).toEqual([
				"compaction: Exocortex's summary could not be written; pi wrote its own, with the tracked requests, files and commands after it",
			]);
			await h.pi.emit("session_before_compact", compactEvent());
			expect(h.pi.ui.filter((call) => call.method === "notify")).toHaveLength(1);
			await h.pi.emit("session_start");
			await h.pi.emit("session_before_compact", compactEvent());
			expect(h.pi.ui.filter((call) => call.method === "notify")).toHaveLength(2);
		});

		it("retries pi's summary as pi's own settings say", async () => {
			const retries: unknown[] = [];
			const { h } = setup(
				{ facts: factsModule([]) },
				{ facts: { enabled: true } },
				{
					host: {
						harnessSummary: async (_event, _ctx, _signal, retry) => {
							retries.push(retry);
							return piResult as never;
						},
					},
				},
			);
			const agentDir = join(h.dir, "agent");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { maxRetries: 7 } }));
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
			try {
				await h.pi.emit("session_start");
				await h.pi.emit("session_before_compact", compactEvent(), h.pi.ctx({ isProjectTrusted: () => false }));
			} finally {
				vi.unstubAllEnvs();
			}
			expect(retries).toEqual([{ enabled: true, maxRetries: 7, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 }]);
		});

		it("prefers a module's whole summary, and keeps the facts alone when pi's summary fails too", async () => {
			const committed: string[] = [];
			const whole = setup(
				{
					facts: factsModule(committed),
					writer: () => ({ id: "writer", compact: async () => ({ summary: "whole" }) }),
				},
				{ facts: { enabled: true }, writer: { enabled: true } },
				{ host: { harnessSummary: () => Promise.reject(new Error("never asked")) } },
			);
			await whole.h.pi.emit("session_start");
			expect(await whole.h.pi.emit("session_before_compact", compactEvent())).toMatchObject({
				compaction: { summary: "whole" },
			});
			expect(committed).toEqual([]);
			whole.h.cleanup();

			const { h, logs } = setup(
				{ facts: factsModule(committed) },
				{ facts: { enabled: true } },
				{ host: { harnessSummary: () => Promise.reject(new Error("model unavailable")) } },
			);
			await h.pi.emit("session_start");
			const result = await h.pi.emit("session_before_compact", compactEvent());
			expect(result).toEqual({
				compaction: {
					summary:
						"(No summary of the earlier conversation could be written. What follows was tracked as it happened.)\n\n## User requests (verbatim, oldest first)\n\n1. implement forth",
					firstKeptEntryId: "entry-9",
					tokensBefore: 150_000,
					details: { exo: { facts: { v: 1 }, module: "facts" } },
				},
			});
			expect(logs[0]).toContain("(model unavailable)");
			expect(committed).toEqual(["facts"]);
			// Pi's abort ends it with nothing.
			const aborted = new AbortController();
			aborted.abort();
			expect(await h.pi.emit("session_before_compact", compactEvent(aborted.signal))).toBeUndefined();
		});

		it("writes pi's summary with pi's own `compact`, through the model registry", async () => {
			const asked: { model: unknown; prompt: string; options: Record<string, unknown> }[] = [];
			const { h, logs } = setup({ facts: factsModule([]) }, { facts: { enabled: true } });
			await h.pi.emit("session_start");
			const model = { id: "m", provider: "p", api: "openai-completions", contextWindow: 262_144, maxTokens: 0 };
			const ctx = h.pi.ctx({
				model,
				modelRegistry: {
					streamSimple: (
						m: unknown,
						context: { messages: { content: unknown }[] },
						options: Record<string, unknown>,
					) => {
						asked.push({ model: m, prompt: JSON.stringify(context.messages), options });
						return {
							result: async () => ({
								role: "assistant",
								content: [{ type: "text", text: `summary ${asked.length}` }],
								stopReason: "stop",
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 2,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							}),
						};
					},
				},
			});
			const result = (await h.pi.emit("session_before_compact", compactEvent(), ctx)) as {
				compaction: { summary: string; details: Record<string, unknown> };
			};
			expect(logs).toEqual([
				"compaction: Exocortex's summary could not be written; pi wrote its own, with the tracked requests, files and commands after it",
			]);
			// A split turn: the history and the turn's start are summarized apart (`compaction.js:690-702`).
			expect(asked).toHaveLength(2);
			expect(asked[0]?.model).toBe(model);
			expect(asked[0]?.prompt).toContain("implement forth");
			expect(asked[0]?.prompt).toContain("old summary");
			expect(asked[0]?.prompt).toContain("Additional focus: focus");
			expect(asked[0]?.options["maxTokens"]).toBe(0);
			expect(result.compaction.summary).toMatch(
				/^summary 1\n\n---\n\n\*\*Turn Context \(split turn\):\*\*\n\nsummary 2/,
			);
			expect(result.compaction.summary).toContain("<modified-files>\nb.rs\nc.rs\n</modified-files>");
			expect(result.compaction.summary).toMatch(
				/\n\n## User requests \(verbatim, oldest first\)\n\n1\. implement forth$/,
			);
			expect(result.compaction.details).toMatchObject({ readFiles: ["a.rs"], modifiedFiles: ["b.rs", "c.rs"] });
		});

		it("gives modules the main model's context window", async () => {
			const requests: CompactionRequest[] = [];
			const { h } = setup(
				{
					writer: () => ({
						id: "writer",
						compact: async (request: CompactionRequest) => {
							requests.push(request);
							return undefined;
						},
					}),
				},
				{ writer: { enabled: true } },
			);
			await h.pi.emit("session_start");
			await h.pi.emit("session_before_compact", compactEvent(), h.pi.ctx({ model: { contextWindow: 262_144 } }));
			expect(requests[0]?.contextWindow).toBe(262_144);
		});
	});

	it("passes a harness-agnostic request and returns the first module summary", async () => {
		const requests: CompactionRequest[] = [];
		const { h } = setup(
			{
				none: () => ({ id: "none", compact: async () => undefined }),
				writer: () => ({
					id: "writer",
					compact: async (request) => {
						requests.push(request);
						return { summary: "the summary" };
					},
				}),
				later: () => ({ id: "later", compact: async () => ({ summary: "never used" }) }),
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
			contextWindow: null,
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
				hangs: () => ({ id: "hangs", compact: () => new Promise<undefined>(() => {}) }),
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
				return text === undefined ? undefined : { text };
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
				customType: "exo.context",
				content: "remember A\n\nremember C",
				display: true,
				details: { exo: { modules: ["a", "c"] } },
			},
		});
		// One contributor: the message is that module's.
		h.runtime.overrides.modules["c"] = { enabled: false };
		h.runtime.rebuildModules();
		await h.pi.emit("input", { text: "add a lexer", source: "interactive" });
		expect(await h.pi.emit("before_agent_start", { prompt: "add a lexer" })).toMatchObject({
			message: { customType: "exo.a", details: { exo: { module: "a", modules: ["a"] } } },
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
			// Wide enough that a timer firing late on a busy machine does not use up the second
			// provider's share: at 20 ms the first one's 10 ms timer could fire after the whole budget.
			{ budgetsMs: { userTurn: 400 } },
		);
		await h.pi.emit("session_start");
		await h.pi.emit("input", { text: "go", source: "interactive" });
		expect(await h.pi.emit("before_agent_start", {})).toBeUndefined();
		await h.pi.emit("input", { text: "go", source: "interactive" });
		h.runtime.overrides.modules["slow"] = { enabled: false };
		h.runtime.rebuildModules();
		expect(await h.pi.emit("before_agent_start", {})).toBeUndefined();
		// The slow provider used up only its share, so the failing one was asked both times.
		expect(h.errors.map((e) => e.where)).toEqual(["bad.contextForUserTurn", "bad.contextForUserTurn"]);
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
							return { text: "note" };
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

		// A settle's status is about that run: the next message clears it, and progress leaves it clear (D-106).
		await h.pi.emit("agent_before_settle", settleEvent());
		h.pi.ui.length = 0;
		await h.pi.emit("input", { text: "now add tests", source: "interactive" });
		await h.pi.emit("before_agent_start", {});
		expect(statuses(h)[0]).toEqual(["setStatus", "exo", undefined]);
		expect(statuses(h).at(-2)).toEqual(["setStatus", "exo", undefined]);
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

describe("what settle hooks are told (D-107)", () => {
	it("every reply since the user's message, past the module's own follow-ups, and the context window", async () => {
		const probe = newProbe();
		const { h } = setup({ a: probeModule("a", probe, () => undefined) }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		const window = h.pi.ctx({ getContextUsage: () => ({ tokens: null, contextWindow: 262_144, percent: null }) });
		await h.pi.emit(
			"agent_before_settle",
			{
				outcome: "completed",
				context: {
					llmMessages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
					contextMessages: [
						{ role: "user", content: "an earlier task" },
						{ role: "assistant", content: [{ type: "text", text: "old reply" }] },
						{ role: "user", content: "summarize it in 3 sentences, then fix the bug" },
						{ role: "assistant", content: [{ type: "text", text: "Here is the summary." }] },
						{ role: "assistant", content: [{ type: "toolCall", id: "t", name: "edit", arguments: {} }] },
						{ role: "toolResult", content: "ok" },
						{ role: "custom", customType: "exo.supervisor", content: "Not done yet." },
						{
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "hm" },
								{ type: "text", text: "Done." },
							],
						},
					],
				},
			},
			window,
		);
		expect(probe.settles.at(-1)).toMatchObject({
			lastAssistantText: "Done.",
			assistantTexts: ["Here is the summary.", "Done."],
			contextWindow: 262_144,
		});
	});
});

describe("background jobs (D-097)", () => {
	const flush = () => new Promise((resolve) => setImmediate(resolve));

	/** A module that starts a job when the agent settles; the test decides when and how it ends. */
	function jobModule(probe: Probe & { signal?: AbortSignal; started?: boolean | undefined }) {
		let finish: (action: SettleAction | undefined) => void = () => {};
		let fail: (error: Error) => void = () => {};
		const factory = probeModule("a", probe, () => {
			probe.started = probe.context?.background("reviewing", (signal) => {
				probe.signal = signal;
				return new Promise((resolve, reject) => {
					finish = resolve;
					fail = reject;
				});
			});
			return undefined;
		});
		return { factory, finish: (action?: SettleAction) => finish(action), fail: (error: Error) => fail(error) };
	}
	const status = (h: AdapterHarness) =>
		h.pi.ui.filter((c) => c.method === "setStatus" && c.args[0] === "exo.background").map((c) => c.args[1]);

	it("applies the job's action when it ends, and shows it running meanwhile", async () => {
		const probe = newProbe();
		const job = jobModule(probe);
		const { h } = setup({ a: job.factory }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		expect(await h.pi.emit("agent_before_settle", settleEvent())).toBeUndefined();
		expect(status(h)).toEqual(["exo: reviewing… (Esc stops)"]);
		job.finish({ kind: "suggest", text: "fix the bug", summary: "review found a bug" });
		await flush();
		expect(h.pi.ui).toContainEqual({ method: "setEditorText", args: ["fix the bug"] });
		expect(status(h)).toEqual(["exo: reviewing… (Esc stops)", undefined]);
		// Sent unchanged, it is the module's suggestion, not the user's wording.
		await h.pi.emit("input", { text: "fix the bug", source: "interactive" });
		expect(probe.turns.at(-1)).toEqual({ text: "fix the bug", origin: "suggestion" });
	});

	it("offers its follow-up beside a draft the user is typing, instead of replacing it", async () => {
		const probe = newProbe();
		const job = jobModule(probe);
		const { h } = setup({ a: job.factory }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		h.pi.editorText = "and also";
		job.finish({ kind: "suggest", text: "fix the bug", summary: "review found a bug" });
		await flush();
		expect(h.pi.ui.some((c) => c.method === "setEditorText")).toBe(false);
		expect(h.pi.ui.find((c) => c.method === "setWidget")?.args[1]).toEqual([
			"exo: review found a bug",
			"alt+r (or /exo add) adds the follow-up below your message · sending without it drops it",
		]);
		expect(h.runtime.addOffer(h.pi.ctx())).toBe(true);
		expect(h.pi.ui).toContainEqual({ method: "setEditorText", args: ["and also\n\nfix the bug"] });
	});

	it("is stopped by a message from the user and by Escape, and then applies nothing", async () => {
		const probe = newProbe() as Probe & { signal?: AbortSignal };
		const job = jobModule(probe);
		const { h } = setup({ a: job.factory }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		await h.pi.emit("input", { text: "something else", source: "interactive" });
		expect(probe.signal?.aborted).toBe(true);
		job.finish({ kind: "suggest", text: "stale", summary: "stale" });
		await flush();
		expect(h.pi.ui.some((c) => c.method === "setEditorText")).toBe(false);

		await h.pi.emit("agent_before_settle", settleEvent());
		h.pi.key("\x1b");
		expect(probe.signal?.aborted).toBe(true);
	});

	it("starts a new turn for a continuation while the agent is idle, and offers it otherwise", async () => {
		const probe = newProbe();
		const job = jobModule(probe);
		const { h } = setup({ a: job.factory }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		const delivered: (string | undefined)[] = [];
		const commit = (as?: string) => delivered.push(as);
		job.finish({ kind: "continue", text: "fix the bug", summary: "review found a bug", commit });
		await flush();
		expect(h.pi.sent).toEqual([
			{
				message: { customType: "exo.a", content: "fix the bug", display: true, details: { exo: { module: "a" } } },
				options: { triggerTurn: true },
			},
		]);
		// Listed until the turn it started settles, so nothing waiting on it sees a gap.
		expect(status(h).at(-1)).toBe("exo: continuing after reviewing");
		// That turn was aborted, so pi skipped its settle hook: its end still clears the line.
		await h.pi.emit("agent_settled", {});
		expect(status(h).at(-1)).toBe("exo: continuing after reviewing");
		await h.pi.emit("agent_start", {});
		await h.pi.emit("agent_settled", {});
		expect(status(h).at(-1)).toBeUndefined();

		await h.pi.emit("agent_before_settle", settleEvent());
		h.pi.idle = false;
		job.finish({ kind: "continue", text: "fix it too", summary: "review found another", commit });
		await flush();
		expect(h.pi.sent).toHaveLength(1);
		expect(h.pi.ui).toContainEqual({ method: "setEditorText", args: ["fix it too"] });
		// The module is told how each went out: the second as a suggestion the user may send (D-107).
		expect(delivered).toEqual(["continue", "suggest"]);
	});

	it("reports a job that throws, and cannot start without a UI", async () => {
		const probe = newProbe() as Probe & { started?: boolean | undefined };
		const job = jobModule(probe);
		const { h } = setup({ a: job.factory }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		job.fail(new Error("boom"));
		await flush();
		expect(h.errors.map((e) => e.where)).toContain("a.background");

		const headless = newProbe() as Probe & { started?: boolean | undefined };
		const { h: h2 } = setup({ a: jobModule(headless).factory }, { a: { enabled: true } }, { hasUI: false });
		await h2.pi.emit("session_start");
		await h2.pi.emit("agent_before_settle", settleEvent());
		expect(headless.started).toBe(false);
	});

	it("steers late help into a working agent, and sends none to an idle one (D-098)", async () => {
		const probe = newProbe();
		const { h } = setup({ a: probeModule("a", probe) }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		await h.pi.emit("tool_result", { toolName: "bash", input: { command: "make" }, isError: false, content: "ok" });
		h.pi.idle = false;
		expect(probe.context?.deliverLate("[exo a] later help")).toBe(true);
		expect(h.pi.sent).toEqual([
			{
				message: {
					customType: "exo.a",
					content: "[exo a] later help",
					display: true,
					details: { exo: { module: "a", late: true } },
				},
				options: { deliverAs: "steer" },
			},
		]);
		h.pi.idle = true;
		expect(probe.context?.deliverLate("[exo a] too late")).toBe(false);
		expect(h.pi.sent).toHaveLength(1);
	});

	it("stops a module's job when another starts and when the session ends", async () => {
		const probe = newProbe() as Probe & { signal?: AbortSignal };
		const job = jobModule(probe);
		const { h } = setup({ a: job.factory }, { a: { enabled: true } });
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		const first = probe.signal;
		await h.pi.emit("agent_before_settle", settleEvent());
		expect(first?.aborted).toBe(true);
		const second = probe.signal;
		await h.pi.emit("session_shutdown");
		expect(second?.aborted).toBe(true);
	});
});
