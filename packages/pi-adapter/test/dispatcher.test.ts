import { join } from "node:path";
import type { CompactionRequest, ExoModule, JsonValue, ModuleContext, ModuleFactory } from "@exocortex/core";
import { afterEach, describe, expect, it } from "vitest";
import { registerExoCommand } from "../src/command.ts";
import { registerModuleHost } from "../src/modules.ts";
import { registerTraceRecorder } from "../src/trace-recorder.ts";
import { type AdapterHarness, createAdapterHarness } from "./harness.ts";

/** Regression tests for the hardening pass over the hook dispatcher (D-078, HARDENING_PLAN section B). */

let harness: AdapterHarness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

type Budgets = { rewrite?: number; settle?: number; compact?: number; userTurn?: number; dispose?: number };

function setup(
	modules: Record<string, ModuleFactory>,
	options: { budgetsMs?: Budgets; maxContinuations?: number; config?: (dir: string) => Record<string, unknown> } = {},
) {
	const enabled = Object.fromEntries(Object.keys(modules).map((id) => [id, { enabled: true }]));
	harness = createAdapterHarness((dir) => ({ modules: enabled, ...options.config?.(dir) }));
	registerModuleHost(harness.pi.api, {
		runtime: harness.runtime,
		onError: harness.onError,
		log: () => {},
		modules,
		...(options.budgetsMs ? { budgetsMs: options.budgetsMs } : {}),
		...(options.maxContinuations === undefined ? {} : { maxContinuations: options.maxContinuations }),
	});
	return harness;
}

const STALLED = Symbol("stalled");
/** The promise's value, or STALLED when it has not settled within `ms`: a hook that holds pi. */
const within = <T>(promise: Promise<T>, ms = 1_000): Promise<T | typeof STALLED> =>
	Promise.race([promise, new Promise<typeof STALLED>((resolve) => setTimeout(() => resolve(STALLED), ms))]);
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const never = <T>() => new Promise<T>(() => {});

const settleEvent = () => ({
	outcome: "completed",
	context: { llmMessages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
});

const bash = (id: string, text = "boom") => ({
	toolName: "bash",
	toolCallId: id,
	input: { command: "make" },
	isError: true,
	content: [{ type: "text", text }],
	structuredContent: { exit_code: 2 },
});

function compactEvent(extra: Record<string, unknown> = {}, signal = new AbortController().signal) {
	return {
		reason: "threshold",
		willRetry: false,
		signal,
		branchEntries: [],
		...extra,
		preparation: {
			firstKeptEntryId: "entry-9",
			tokensBefore: 1_000,
			isSplitTurn: false,
			messagesToSummarize: [{ role: "user", content: "implement forth", timestamp: 1 }],
			turnPrefixMessages: [],
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
			...(extra["preparation"] as Record<string, unknown> | undefined),
		},
	};
}

const statuses = (h: AdapterHarness) => h.pi.ui.filter((c) => c.method === "setStatus").map((c) => c.args[1]);

describe("B2: the settle hook is bounded and stops when the user moves on", () => {
	it("gives pi back at the budget when a module never answers", async () => {
		const h = setup({ a: () => ({ id: "a", onSettle: () => never() }) }, { budgetsMs: { settle: 40 } });
		await h.pi.emit("session_start");
		expect(await within(h.pi.emit("agent_before_settle", settleEvent()))).toBeUndefined();
	});

	it("stops at once and applies nothing when the session is being replaced, shut down or interrupted", async () => {
		const stops: Record<string, (h: AdapterHarness) => unknown> = {
			session_before_switch: (h) => h.pi.emit("session_before_switch", { reason: "new" }),
			session_before_fork: (h) => h.pi.emit("session_before_fork", { entryId: "e" }),
			session_shutdown: (h) => h.pi.emit("session_shutdown", { reason: "reload" }),
			escape: (h) => h.pi.key("\u001b"),
			"escape (kitty)": (h) => h.pi.key("\u001b[27u"),
		};
		for (const [name, stop] of Object.entries(stops)) {
			let release: (action: { kind: "continue"; text: string; summary: string }) => void = () => {};
			let signal: AbortSignal | undefined;
			const h = setup({
				a: () => ({
					id: "a",
					onSettle: (_info, s) => {
						signal = s;
						return new Promise((resolve) => {
							release = resolve;
						});
					},
				}),
			});
			await h.pi.emit("session_start");
			const settling = h.pi.emit("agent_before_settle", settleEvent());
			await tick();
			h.pi.key("x");
			expect(signal?.aborted, name).toBe(false);
			await stop(h);
			expect(await within(settling), name).toBeUndefined();
			expect(signal?.aborted, name).toBe(true);
			// The module answers late: pi must not be handed a continuation nobody is waiting for.
			release({ kind: "continue", text: "keep going", summary: "s" });
			await tick();
			expect(h.pi.ui.filter((c) => c.method === "setEditorText" || c.method === "notify")).toEqual([]);
			h.cleanup();
		}
	});
});

describe("B3: the host caps consecutive continuations", () => {
	it("refuses to continue past the cap until the user speaks again", async () => {
		const h = setup(
			{ a: () => ({ id: "a", onSettle: async () => ({ kind: "continue", text: "more", summary: "unfinished" }) }) },
			{ maxContinuations: 3 },
		);
		await h.pi.emit("session_start");
		const run = async () =>
			((await h.pi.emit("agent_before_settle", settleEvent())) as { continue?: boolean } | undefined)?.continue ===
			true;
		expect([await run(), await run(), await run(), await run(), await run()]).toEqual([true, true, true, false, false]);
		expect(h.pi.ui.filter((c) => c.method === "notify" && c.args[1] === "warning")).toHaveLength(2);
		// An extension's own prompt is not the user.
		await h.pi.emit("input", { text: "go on", source: "extension" });
		expect(await run()).toBe(false);
		await h.pi.emit("input", { text: "try another way", source: "interactive" });
		expect(await run()).toBe(true);
	});
});

describe("B4: a module learns whether its result was used", () => {
	it("commits user-turn context only when it reached the prompt", async () => {
		const committed: string[] = [];
		let slow = false;
		const provider =
			(id: string): ModuleFactory =>
			() => ({
				id,
				contextForUserTurn: async () => {
					if (slow) await tick(80);
					return { text: `note from ${id}`, commit: () => committed.push(id) };
				},
			});
		const h = setup({ a: provider("a") }, { budgetsMs: { userTurn: 40 } });
		await h.pi.emit("session_start");
		await h.pi.emit("input", { text: "add a parser", source: "interactive" });
		expect(await h.pi.emit("before_agent_start", {})).toBeDefined();
		expect(committed).toEqual(["a"]);
		slow = true;
		await h.pi.emit("input", { text: "add tests", source: "interactive" });
		expect(await h.pi.emit("before_agent_start", {})).toBeUndefined();
		await tick(100);
		expect(committed).toEqual(["a"]);
	});

	it("commits rewrites, settle actions and summaries it applies, and not the ones it drops", async () => {
		const committed: string[] = [];
		const commit = (name: string) => () => committed.push(name);
		const h = setup({
			a: () => ({
				id: "a",
				rewriteToolResult: async (d) => ({ text: `${d.current}!`, note: "n", commit: commit("a.rewrite") }),
				onSettle: async () => ({ kind: "notify", summary: "ok", level: "info", commit: commit("a.settle") }),
				compact: async () => ({ summary: "first", commit: commit("a.compact") }),
			}),
			b: () => ({
				id: "b",
				// Same text: nothing to apply.
				rewriteToolResult: async (d) => ({ text: d.current, note: "noop", commit: commit("b.rewrite") }),
				onSettle: async () => ({ kind: "suggest", text: "t", summary: "s", commit: commit("b.settle") }),
				compact: async () => ({ summary: "second", commit: commit("b.compact") }),
			}),
			c: () => ({
				id: "c",
				onSettle: async () => ({ kind: "notify", summary: "late", level: "info", commit: commit("c.settle") }),
				dispose: () => {
					throw new Error("dispose");
				},
			}),
			bad: () => ({
				id: "bad",
				rewriteToolResult: async (d) => ({
					text: `${d.current}?`,
					note: "n",
					commit: () => {
						throw new Error("commit");
					},
				}),
			}),
		});
		await h.pi.emit("session_start");
		expect(await h.pi.emit("tool_result", bash("c1"))).toMatchObject({ content: [{ type: "text", text: "boom!?" }] });
		await h.pi.emit("agent_before_settle", settleEvent());
		await h.pi.emit("session_before_compact", compactEvent());
		// One actionable settle result per settle: c was never asked. The first summary wins.
		expect(committed).toEqual(["a.rewrite", "a.settle", "b.settle", "a.compact"]);
		expect(h.errors.map((e) => e.where)).toEqual(["bad.commit"]);
		await h.pi.emit("session_shutdown", { reason: "quit" });
		expect(h.errors.map((e) => e.where)).toEqual(["bad.commit", "c.dispose"]);
	});

	it("does not commit a suggestion nobody can see", async () => {
		const committed: string[] = [];
		const h = setup({
			a: () => ({
				id: "a",
				onSettle: async () => ({ kind: "suggest", text: "t", summary: "s", commit: () => committed.push("a") }),
			}),
		});
		await h.pi.emit("session_start", {}, h.pi.ctx({ hasUI: false }));
		await h.pi.emit("agent_before_settle", settleEvent(), h.pi.ctx({ hasUI: false }));
		expect(committed).toEqual([]);
	});
});

describe("B5: a suggestion never overwrites what the user is typing", () => {
	it("shows the suggestion and leaves the draft, and still recognises it when sent unchanged", async () => {
		const origins: string[] = [];
		const h = setup({
			a: () => ({
				id: "a",
				onUserTurn: (turn) => void origins.push(turn.origin),
				onSettle: async () => ({ kind: "suggest", text: "run the tests", summary: "tests not run" }),
			}),
		});
		await h.pi.emit("session_start");
		h.pi.editorText = "  also rename the fi";
		await h.pi.emit("agent_before_settle", settleEvent());
		expect(h.pi.ui.filter((c) => c.method === "setEditorText")).toEqual([]);
		const notice = h.pi.ui.find((c) => c.method === "notify");
		expect(String(notice?.args[0])).toContain("run the tests");
		expect(String(notice?.args[0])).toContain("draft");
		await h.pi.emit("input", { text: "run the tests", source: "interactive" });
		expect(origins).toEqual(["suggestion"]);
	});
});

describe("B6: Exocortex's own messages are not the user's in a compaction request", () => {
	it("labels them and keeps them out of the user's messages", async () => {
		const requests: CompactionRequest[] = [];
		const h = setup({
			a: () => ({
				id: "a",
				compact: async (request) => {
					requests.push(request);
					return undefined;
				},
			}),
		});
		await h.pi.emit("session_start");
		await h.pi.emit(
			"session_before_compact",
			compactEvent({
				preparation: {
					messagesToSummarize: [
						{ role: "user", content: "implement forth", timestamp: 1 },
						{ role: "custom", customType: "exo.memory", content: "Prefer small commits.", display: true, timestamp: 2 },
						{ role: "assistant", content: [{ type: "text", text: "on it" }], timestamp: 3 },
						{ role: "custom", customType: "exo.supervisor", content: "Not done: add the README", timestamp: 4 },
						{ role: "custom", customType: "other.ext", content: "from another extension", timestamp: 5 },
						{ role: "assistant", content: [{ type: "text", text: "added" }], timestamp: 6 },
					],
				},
			}),
		);
		const [request] = requests;
		expect(request?.userMessages).toEqual(["implement forth"]);
		expect(request?.conversation).toBe(
			[
				"[User]: implement forth",
				"[Exocortex memory, not the user]: Prefer small commits.",
				"[Assistant]: on it",
				"[Exocortex supervisor, not the user]: Not done: add the README",
				"[User]: from another extension",
				"[Assistant]: added",
			].join("\n\n"),
		);
	});
});

describe("B8: tool results are handled one at a time", () => {
	it("finishes one result's hooks before starting the next, in arrival order", async () => {
		const log: string[] = [];
		const h = setup({
			a: () => ({
				id: "a",
				onToolResult: (tool) => void log.push(`seen ${tool.output}`),
				rewriteToolResult: async (d) => {
					log.push(`start ${d.toolCallId}`);
					await tick(d.toolCallId === "c1" ? 40 : 1);
					log.push(`end ${d.toolCallId}`);
					return { text: `${d.current} (${d.toolCallId})`, note: "n" };
				},
			}),
		});
		await h.pi.emit("session_start");
		const results = await Promise.all([
			h.pi.emit("tool_result", bash("c1", "one")),
			h.pi.emit("tool_result", bash("c2", "two")),
		]);
		expect(log).toEqual(["seen one", "start c1", "end c1", "seen two", "start c2", "end c2"]);
		expect(results.map((r) => (r as { content: { text: string }[] }).content[0]?.text)).toEqual([
			"one (c1)",
			"two (c2)",
		]);
	});

	it("gives each rewriter a share of the budget, so a hanging first one does not starve the rest", async () => {
		const h = setup(
			{
				hangs: () => ({ id: "hangs", rewriteToolResult: () => never() }),
				late: () => ({ id: "late", rewriteToolResult: async (d) => ({ text: `${d.current}!`, note: "late" }) }),
			},
			{ budgetsMs: { rewrite: 80 } },
		);
		await h.pi.emit("session_start");
		const started = Date.now();
		const result = await within(h.pi.emit("tool_result", bash("c1")));
		expect(result).toMatchObject({ content: [{ type: "text", text: "boom!" }] });
		expect(Date.now() - started).toBeLessThan(80 + 200);
	});

	it("stops rewriting when the run is aborted, and a failed result does not block the next", async () => {
		const run = new AbortController();
		let calls = 0;
		const h = setup({
			a: () => ({
				id: "a",
				onToolResult: () => {
					calls += 1;
					if (calls === 1) throw new Error("observer");
				},
				rewriteToolResult: () => never(),
			}),
		});
		await h.pi.emit("session_start");
		const first = h.pi.emit("tool_result", bash("c1"), h.pi.ctx({ signal: run.signal }));
		const second = h.pi.emit("tool_result", bash("c2"), h.pi.ctx({ signal: run.signal }));
		await tick();
		run.abort();
		expect(await within(Promise.all([first, second]))).toEqual([undefined, undefined]);
		expect(calls).toBe(2);
	});
});

describe("B10: toggles keep the modules they do not change, and state follows the session", () => {
	function counting(id: string, built: string[], disposed: string[]): ModuleFactory {
		return (settings) => {
			built.push(`${id}:${String(settings["mode"] ?? "-")}`);
			return { id, dispose: () => void disposed.push(id) };
		};
	}

	it("rebuilds only the module whose settings changed and disposes what it drops", async () => {
		const built: string[] = [];
		const disposed: string[] = [];
		const h = setup({ a: counting("a", built, disposed), b: counting("b", built, disposed) });
		await h.pi.emit("session_start");
		expect(built).toEqual(["a:-", "b:-"]);
		h.runtime.overrides.modules["b"] = { enabled: true, mode: "auto" };
		h.runtime.rebuildModules();
		expect(built).toEqual(["a:-", "b:-", "b:auto"]);
		expect(disposed).toEqual(["b"]);
		h.runtime.overrides.modules["a"] = { enabled: false };
		h.runtime.rebuildModules();
		h.runtime.rebuildModules();
		expect(disposed).toEqual(["b", "a"]);
		expect(h.runtime.moduleStatus()).toEqual(["b"]);
		h.runtime.overrides.allOff = true;
		h.runtime.rebuildModules();
		expect(disposed).toEqual(["b", "a", "b"]);
		await h.pi.emit("session_shutdown", { reason: "quit" });
		expect(disposed).toEqual(["b", "a", "b"]);
	});

	it("disposes every module at shutdown, without waiting on one that never finishes", async () => {
		const disposed: string[] = [];
		const h = setup(
			{
				a: () => ({ id: "a", dispose: () => never<void>() }),
				b: () => ({
					id: "b",
					dispose: async () => {
						disposed.push("b");
						throw new Error("late");
					},
				}),
			},
			{ budgetsMs: { dispose: 30 } },
		);
		await h.pi.emit("session_start");
		expect(await within(h.pi.emit("session_shutdown", { reason: "new" }))).toBeUndefined();
		expect(disposed).toEqual(["b"]);
		expect(h.errors.map((e) => e.where)).toEqual(["b.dispose"]);
	});

	it("persists /exo toggles in the session and restores them when it is reloaded", async () => {
		const first = setup({ trimmer: () => ({ id: "trimmer" }), supervisor: () => ({ id: "supervisor" }) });
		registerExoCommand(first.pi.api, first.runtime);
		await first.pi.emit("session_start");
		await first.pi.command("exo", "trimmer off");
		await first.pi.command("exo", "supervisor auto");
		expect(first.pi.entries.at(-1)).toEqual({
			type: "custom",
			customType: "exo.overrides",
			data: { allOff: false, modules: { trimmer: { enabled: false }, supervisor: { enabled: true, mode: "auto" } } },
		});
		const entries = [...first.pi.entries, { type: "custom", customType: "exo.overrides", data: "garbage" }];
		first.cleanup();

		// A reload runs the extension factory again: new runtime, same session entries.
		const settings: Record<string, unknown>[] = [];
		const second = setup({
			trimmer: () => ({ id: "trimmer" }),
			supervisor: (s) => {
				settings.push(s);
				return { id: "supervisor" };
			},
		});
		second.pi.entries.push(...entries.slice(0, -1));
		await second.pi.emit("session_start", { reason: "reload" });
		expect(second.runtime.moduleStatus()).toEqual(["supervisor"]);
		expect(settings.at(-1)).toMatchObject({ mode: "auto" });
		expect(second.runtime.overrides.allOff).toBe(false);

		// An entry that is not ours to trust is ignored.
		const third = setup({ trimmer: () => ({ id: "trimmer" }) });
		third.pi.entries.push(...entries);
		await third.pi.emit("session_start", { reason: "resume" });
		expect(third.runtime.moduleStatus()).toEqual(["trimmer"]);
	});

	it("closes the trace store whenever a session ends, and opens it again for the next", async () => {
		const h = setup(
			{ a: () => ({ id: "a" }) },
			{ config: (dir) => ({ trace: { enabled: true, dbPath: join(dir, "t.db") } }) },
		);
		registerTraceRecorder(h.pi.api, { runtime: h.runtime, env: h.env, onError: h.onError });
		await h.pi.emit("session_start", { reason: "startup" });
		const store = h.runtime.store;
		expect(store).toBeDefined();
		await h.pi.emit("session_shutdown", { reason: "new" });
		expect(h.runtime.store).toBeUndefined();
		await h.pi.emit("session_start", { reason: "new" });
		expect(h.runtime.store).toBeDefined();
		expect(h.runtime.store).not.toBe(store);
		expect(h.runtime.traceSession).toBeDefined();
	});
});

describe("B11: module state that outlives the instance", () => {
	function stateful(seen: { context?: ModuleContext; restored: (JsonValue | undefined)[] }): ModuleFactory {
		return (_settings, context) => {
			seen.context = context;
			seen.restored.push(context.savedState);
			return { id: "a" };
		};
	}

	it("gives modules the session id and what they last saved, across rebuilds and reloads", async () => {
		const seen = { restored: [] as (JsonValue | undefined)[] } as Parameters<typeof stateful>[0];
		const h = setup({ a: stateful(seen) });
		await h.pi.emit("session_start");
		expect(seen.context?.sessionId).toBe("fake-session");
		expect(seen.restored).toEqual([undefined]);
		seen.context?.saveState({ count: 1 });
		seen.context?.saveState({ count: 1 });
		seen.context?.saveState({ count: 2 });
		expect(h.pi.entries).toEqual([
			{ type: "custom", customType: "exo.a.state", data: { count: 1 } },
			{ type: "custom", customType: "exo.a.state", data: { count: 2 } },
		]);
		// A settings change rebuilds the module: the new instance starts from the saved state.
		h.runtime.overrides.modules["a"] = { enabled: true, mode: "auto" };
		h.runtime.rebuildModules();
		expect(seen.restored).toEqual([undefined, { count: 2 }]);
		const entries = [...h.pi.entries];
		const stale = seen.context;
		await h.pi.emit("session_shutdown", { reason: "reload" });
		// The old instance's background work finishes after the session is gone: nothing is written.
		stale?.saveState({ count: 99 });
		stale?.record({ kind: "exo.action", data: {} });
		stale?.progress("too late");
		expect(stale?.pool()).toBeUndefined();
		expect(h.pi.entries).toEqual(entries);
		h.cleanup();

		const again = { restored: [] as (JsonValue | undefined)[] } as Parameters<typeof stateful>[0];
		const reloaded = setup({ a: stateful(again), b: stateful({ restored: [] }) });
		reloaded.pi.entries.push(...entries, { type: "custom", customType: "exo.a.state.extra", data: { count: 7 } });
		await reloaded.pi.emit("session_start", { reason: "reload" });
		expect(again.restored).toEqual([{ count: 2 }]);
		expect(reloaded.errors).toEqual([]);
	});

	it("drops a state too large to keep in the session file, and survives a stale pi", async () => {
		const seen = { restored: [] as (JsonValue | undefined)[] } as Parameters<typeof stateful>[0];
		const h = setup({ a: stateful(seen) });
		await h.pi.emit("session_start");
		seen.context?.saveState({ blob: "x".repeat(300_000) });
		expect(h.pi.entries).toEqual([]);
		h.pi.invalidate();
		seen.context?.saveState({ count: 1 });
		expect(h.errors.map((e) => e.where)).toEqual(["a.saveState", "a.saveState"]);
	});

	it("hands a module the details it returned with the previous summary", async () => {
		const requests: Record<string, CompactionRequest[]> = { a: [], b: [] };
		const compactor =
			(id: string, summary: string | undefined): ModuleFactory =>
			() => ({
				id,
				compact: async (request) => {
					requests[id]?.push(request);
					return summary === undefined ? undefined : { summary, details: { facts: ["f1"], module: "ignored" } };
				},
			});
		const h = setup({ a: compactor("a", undefined), b: compactor("b", "the summary") });
		await h.pi.emit("session_start");
		const result = (await h.pi.emit("session_before_compact", compactEvent())) as {
			compaction: { summary: string; details: Record<string, unknown> };
		};
		expect(result.compaction.details).toEqual({ exo: { facts: ["f1"], module: "b" } });
		expect(requests["b"]?.[0]?.previousDetails).toBeNull();
		const branchEntries = [
			{ type: "compaction", summary: "older", details: { exo: { module: "b", facts: ["f0"] } } },
			{ type: "message", message: { role: "user", content: "x" } },
			{ type: "compaction", summary: "the summary", details: result.compaction.details },
			{ type: "custom", customType: "exo.b.state", data: 1 },
		];
		await h.pi.emit("session_before_compact", compactEvent({ branchEntries }));
		expect(requests["a"]?.[1]?.previousDetails).toBeNull();
		expect(requests["b"]?.[1]?.previousDetails).toEqual({ facts: ["f1"], module: "b" });
		// Pi's own summary, or another extension's, carries nothing for us.
		await h.pi.emit(
			"session_before_compact",
			compactEvent({ branchEntries: [...branchEntries, { type: "compaction", summary: "pi's", details: { x: 1 } }] }),
		);
		expect(requests["b"]?.[2]?.previousDetails).toBeNull();
	});
});

describe("B12: one message from several modules is tagged as shared", () => {
	it("uses exo.context and lists every contributor", async () => {
		const provider =
			(id: string): ModuleFactory =>
			() => ({ id, contextForUserTurn: async () => ({ text: `from ${id}` }) });
		const h = setup({ a: provider("a"), b: provider("b") });
		await h.pi.emit("session_start");
		await h.pi.emit("input", { text: "add a parser", source: "interactive" });
		expect(await h.pi.emit("before_agent_start", {})).toEqual({
			message: {
				customType: "exo.context",
				content: "from a\n\nfrom b",
				display: true,
				details: { exo: { modules: ["a", "b"] } },
			},
		});
	});
});

describe("B13: synthetic trace events carry the turn they happened in", () => {
	it("stamps module records, rewrites and continuations with the current turn", async () => {
		let context: ModuleContext | undefined;
		const h = setup(
			{
				a: (_settings, ctx) => {
					context = ctx;
					return {
						id: "a",
						rewriteToolResult: async (d) => ({ text: `${d.current}!`, note: "n" }),
						onSettle: async () => ({ kind: "continue", text: "more", summary: "s" }),
					};
				},
			},
			{ config: (dir) => ({ trace: { enabled: true, dbPath: join(dir, "t.db") } }) },
		);
		registerTraceRecorder(h.pi.api, { runtime: h.runtime, env: h.env, onError: h.onError });
		await h.pi.emit("session_start", { reason: "startup" });
		const sessionId = h.runtime.traceSession?.id ?? "";
		const store = h.runtime.store;
		context?.record({ kind: "exo.action", data: { before: "any turn" } });
		await h.pi.emit("turn_start", { turnIndex: 4 });
		context?.record({ kind: "exo.action", data: {} });
		await h.pi.emit("tool_result", bash("c1"));
		await h.pi.emit("agent_before_settle", settleEvent());
		store?.flush();
		const synthetic = (store?.events(sessionId) ?? []).filter((e) => e.synthetic);
		expect(synthetic.map((e) => [e.kind, e.turn])).toEqual([
			["exo.action", null],
			["exo.action", 4],
			["exo.rewrite", 4],
			["message", 4],
		]);
	});
});

describe("B14: an abort that already happened is honoured", () => {
	it("does not wait on a compaction module when pi's signal was aborted before the hook ran", async () => {
		let calls = 0;
		const hanging =
			(id: string): ModuleFactory =>
			() => ({
				id,
				compact: () => {
					calls += 1;
					return never();
				},
			});
		const h = setup({ a: hanging("a"), b: hanging("b") });
		await h.pi.emit("session_start");
		const aborted = new AbortController();
		aborted.abort();
		expect(await within(h.pi.emit("session_before_compact", compactEvent({}, aborted.signal)))).toBeUndefined();
		expect(calls).toBe(0);
		// Aborted while the first module works: the second is never asked.
		const live = new AbortController();
		const compacting = h.pi.emit("session_before_compact", compactEvent({}, live.signal));
		await tick();
		live.abort();
		expect(await within(compacting)).toBeUndefined();
		expect(calls).toBe(1);
	});
});

describe("B15: settle shows what it is waiting on", () => {
	it("puts a module's progress on the status line while it settles, then the result", async () => {
		const h = setup({
			a: (_settings, ctx): ExoModule => ({
				id: "a",
				onSettle: async () => {
					ctx.progress("running: cargo test");
					return { kind: "notify", summary: "a: complete", level: "info" };
				},
			}),
		});
		await h.pi.emit("session_start");
		await h.pi.emit("agent_before_settle", settleEvent());
		expect(statuses(h)).toEqual(["exo: checking the work…", "exo: running: cargo test", "exo: a: complete"]);
		expect(h.pi.ui.filter((c) => c.method === "setWorkingMessage").map((c) => c.args)).toEqual([
			["checking the work…"],
			["running: cargo test"],
			[],
		]);
	});
});
