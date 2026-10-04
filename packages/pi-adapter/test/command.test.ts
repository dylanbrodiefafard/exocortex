import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExoCommand } from "../src/command.ts";
import { type AdapterHarness, createAdapterHarness } from "./harness.ts";

let harness: AdapterHarness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	vi.restoreAllMocks();
});

function setup(config: Record<string, unknown> = {}, options: { hasUI?: boolean } = {}) {
	harness = createAdapterHarness(config, options);
	harness.runtime.moduleIds = () => ["trimmer", "supervisor"];
	registerExoCommand(harness.pi.api, harness.runtime);
	return harness;
}

const notices = (h: AdapterHarness) => h.pi.ui.filter((c) => c.method === "notify").map((c) => c.args);

describe("/exo", () => {
	it("reports status before activation, when disabled, and when enabled", async () => {
		const h = setup({ enabled: false });
		await h.pi.command("exo");
		h.runtime.activate(h.dir);
		await h.pi.command("exo", "status");
		expect(notices(h)).toEqual([
			["Exocortex: not activated yet", "info"],
			["Exocortex: disabled", "info"],
		]);
	});

	it("lists modules and sidecar stats", async () => {
		const h = setup();
		h.runtime.activate(h.dir);
		h.runtime.moduleStatus = () => ["supervisor (suggest)"];
		await h.pi.command("exo", "status");
		const [text] = notices(h).at(-1) ?? [];
		expect(text).toContain("Exocortex: enabled · trace off");
		expect(text).toContain("modules: supervisor (suggest)");
		expect(text).toContain("sidecars: no engine configured");
		h.runtime.pool = {
			stats: () => ({
				running: 1,
				queued: { critical: 0, interactive: 2, background: 3 },
				maxRunningObserved: 1,
				sessionTokensUsed: 42,
				outcomes: { ok: 4, timeout: 1, error: 0 },
			}),
			close: () => {},
		} as never;
		await h.pi.command("exo", "status");
		expect(notices(h).at(-1)?.[0]).toContain(
			"sidecars: 1 running · queued 0/2/3 (crit/int/bg) · 42 tokens · ok 4, timeout 1",
		);
	});

	it("toggles every module off and back on", async () => {
		const h = setup();
		h.runtime.activate(h.dir);
		const rebuild = vi.fn();
		h.runtime.rebuildModules = rebuild;
		await h.pi.command("exo", "off");
		expect(h.runtime.overrides.allOff).toBe(true);
		await h.pi.command("exo", "status");
		expect(notices(h).at(-1)?.[0]).toContain("modules: off (/exo on to re-enable)");
		await h.pi.command("exo", " on ");
		expect(h.runtime.overrides.allOff).toBe(false);
		expect(rebuild).toHaveBeenCalledTimes(2);
	});

	it("switches the supervisor on, off and between modes", async () => {
		const h = setup();
		await h.pi.command("exo", "supervisor on");
		expect(notices(h).at(-1)?.[0]).toBe("Supervisor: on (configured mode) for this session.");
		await h.pi.command("exo", "supervisor auto");
		expect(h.runtime.overrides.modules["supervisor"]).toEqual({ enabled: true, mode: "auto" });
		expect(notices(h).at(-1)?.[0]).toBe("Supervisor: on (auto) for this session.");
		await h.pi.command("exo", "supervisor off");
		expect(notices(h).at(-1)?.[0]).toBe("Supervisor: off for this session.");
		await h.pi.command("exo", "supervisor sideways");
		expect(notices(h).at(-1)).toEqual(["Usage: /exo supervisor on|off|suggest|auto", "warning"]);
	});

	it("toggles any hosted module on and off", async () => {
		const h = setup();
		await h.pi.command("exo", "trimmer on");
		expect(h.runtime.overrides.modules["trimmer"]).toEqual({ enabled: true });
		expect(notices(h).at(-1)?.[0]).toBe("Trimmer: on for this session.");
		await h.pi.command("exo", "trimmer auto");
		expect(notices(h).at(-1)).toEqual(["Usage: /exo trimmer on|off", "warning"]);
		await h.pi.command("exo", "trimmer off");
		expect(notices(h).at(-1)?.[0]).toBe("Trimmer: off for this session.");
	});

	it("warns on unknown subcommands and reports handler failures", async () => {
		const h = setup();
		await h.pi.command("exo", "frobnicate");
		expect(notices(h).at(-1)?.[1]).toBe("warning");
		h.runtime.rebuildModules = () => {
			throw new Error("kaput");
		};
		await h.pi.command("exo", "off");
		expect(notices(h).at(-1)).toEqual(["/exo failed: Error: kaput", "error"]);
	});

	it("completes subcommands", () => {
		const h = setup();
		const complete = h.pi.commands.get("exo")?.getArgumentCompletions;
		expect(complete?.("s")).toEqual([
			{ value: "status", label: "status" },
			{ value: "supervisor", label: "supervisor" },
		]);
		expect(complete?.("t")).toEqual([{ value: "trimmer", label: "trimmer" }]);
	});

	it("prints to stderr without a UI", async () => {
		harness = createAdapterHarness({}, { hasUI: false });
		const pi = (await import("./fake-pi.ts")).createFakePi({ cwd: harness.dir, hasUI: false });
		registerExoCommand(pi.api, harness.runtime);
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await pi.command("exo", "status");
		expect(write).toHaveBeenCalledWith("Exocortex: not activated yet\n");
		expect(pi.ui).toEqual([]);
	});
});
