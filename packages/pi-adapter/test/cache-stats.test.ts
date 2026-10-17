import { afterEach, describe, expect, it } from "vitest";
import { cacheReport, cacheSummary, createCacheStats, registerCacheStats } from "../src/cache-stats.ts";
import { registerExoCommand } from "../src/command.ts";
import { type AdapterHarness, createAdapterHarness } from "./harness.ts";

let harness: AdapterHarness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

const usage = (input: number, cacheRead: number, cacheWrite = 0) => ({
	input,
	output: 10,
	cacheRead,
	cacheWrite,
	totalTokens: input + cacheRead + 10,
});
const sidecar = (module: string, promptTokens: number, cachedTokens: number | null) => ({
	module,
	usage: { promptTokens, cachedTokens, completionTokens: 5 },
});

describe("cache stats", () => {
	it("counts cached tokens of the main agent's prompts, pi's `input` leaving them out", () => {
		const stats = createCacheStats();
		expect(stats.addMain(usage(100, 900))).toEqual({ prompt: 1000, cached: 900 });
		expect(stats.addMain(usage(500, 0, 500))).toEqual({ prompt: 1000, cached: 0 });
		expect(stats.addMain(undefined)).toBeUndefined();
		expect(stats.addMain(usage(0, 0))).toBeUndefined();
		expect(stats.main().session).toMatchObject({ requests: 2, prompt: 2000, cached: 900 });
		const report = cacheReport(stats);
		expect(report).toContain("main agent, last request: 0% of 1,000 prompt tokens cached");
		expect(report).toContain("main agent, session: 45% of 2,000 prompt tokens cached (900 reused, 2 requests)");
		expect(report).toContain("sidecars: no calls yet");
	});

	it("says an engine that never reports cached tokens did not report them", () => {
		const stats = createCacheStats();
		stats.addMain(usage(1000, 0));
		stats.addMain(usage(1200, 0));
		expect(cacheReport(stats)).toContain(
			"main agent, session: not reported by the engine (2 requests, 2,200 prompt tokens)",
		);
		expect(cacheSummary(stats)).toContain("main not reported");
	});

	it("sums sidecar calls per module, leaving calls without a cache report out of the rate", () => {
		const stats = createCacheStats();
		stats.addSidecar(sidecar("triage", 1000, 800));
		stats.addSidecar(sidecar("triage", 1000, null));
		stats.addSidecar(sidecar("memory", 400, 0));
		stats.addSidecar(sidecar("memory", 0, null));
		const report = cacheReport(stats);
		expect(report).toContain(
			"sidecars, all: 57% of 1,400 prompt tokens cached (800 reused, 3 requests; 1 did not report)",
		);
		expect(report).toContain("  memory: 0% of 400 prompt tokens cached (0 reused, 1 request)");
		expect(report).toContain("  triage: 80% of 1,000 prompt tokens cached (800 reused, 2 requests; 1 did not report)");
		expect(cacheSummary(stats)).toBe("prompt cache: main no requests yet · sidecars 57% (/exo cache for more)");
		stats.reset();
		expect(stats.sidecars().size).toBe(0);
	});

	it("shows the hit rate on its own status key after each turn while Exocortex is on, and starts over per session", async () => {
		harness = createAdapterHarness({});
		const h = harness;
		registerCacheStats(h.pi.api, h.runtime, () => {});
		registerExoCommand(h.pi.api, h.runtime);
		h.runtime.activate(h.dir);
		const statuses = () => h.pi.ui.filter((c) => c.method === "setStatus").map((c) => c.args);
		await h.pi.emit("turn_end", {
			turnIndex: 0,
			message: { role: "assistant", usage: usage(100, 900) },
			toolResults: [],
		});
		await h.pi.emit("turn_end", {
			turnIndex: 1,
			message: { role: "assistant", usage: usage(1000, 0) },
			toolResults: [],
		});
		expect(statuses()).toEqual([
			["exo.cache", "cache 90% · session 90%"],
			["exo.cache", "cache 0% · session 45%"],
		]);
		await h.pi.command("exo", "cache");
		const notices = h.pi.ui.filter((c) => c.method === "notify").map((c) => c.args[0]);
		expect(notices.at(-1)).toContain("main agent, session: 45% of 2,000 prompt tokens cached");
		await h.pi.command("exo", "status");
		expect(h.pi.ui.at(-1)?.args[0]).toContain("prompt cache: main 45% · sidecars no calls yet");

		h.runtime.overrides.allOff = true;
		await h.pi.emit("turn_end", {
			turnIndex: 2,
			message: { role: "assistant", usage: usage(10, 990) },
			toolResults: [],
		});
		expect(statuses().at(-1)).toEqual(["exo.cache", undefined]);

		await h.pi.emit("session_start", { reason: "startup" });
		expect(h.runtime.cacheStats.main().session.requests).toBe(0);
	});

	it("is quiet without a UI and when Exocortex is disabled, and never throws into pi", async () => {
		harness = createAdapterHarness({ enabled: false }, { hasUI: false });
		const h = harness;
		const errors: string[] = [];
		registerCacheStats(h.pi.api, h.runtime, (where) => errors.push(where));
		registerExoCommand(h.pi.api, h.runtime);
		h.runtime.activate(h.dir);
		await h.pi.emit("turn_end", { turnIndex: 0, message: { role: "assistant", usage: usage(1, 1) }, toolResults: [] });
		expect(h.pi.ui).toEqual([]);
		await expect(h.pi.emit("turn_end", { turnIndex: 1, message: null, toolResults: [] })).resolves.toBeUndefined();
		const broken = {
			...h.pi.ctx(),
			hasUI: true,
			ui: {
				setStatus: () => {
					throw new Error("stale");
				},
			},
		};
		await h.pi.emit("session_start", { reason: "startup" }, broken as never);
		expect(errors).toEqual(["cache.session_start"]);
	});
});
