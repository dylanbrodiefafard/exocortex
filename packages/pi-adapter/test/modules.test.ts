import type {
	ExoModule,
	ModuleContext,
	ModuleFactory,
	SettleAction,
	SettleInfo,
	ToolOutcome,
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
	options: { hasUI?: boolean } = {},
) {
	harness = createAdapterHarness({ modules: enabled }, options);
	const logs: string[] = [];
	registerModuleHost(harness.pi.api, {
		runtime: harness.runtime,
		onError: harness.onError,
		log: (message) => logs.push(message),
		modules,
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
