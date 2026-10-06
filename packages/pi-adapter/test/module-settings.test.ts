import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@exocortex/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import exocortex from "../src/index.ts";
import { MODULE_SETTINGS } from "../src/module-settings.ts";
import { createFakePi } from "./fake-pi.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const EVAL_CONFIGS = join(ROOT, "packages", "eval", "configs");

describe("module settings in config (D7)", () => {
	const shipped = [
		join(ROOT, "exocortex.config.example.jsonc"),
		...readdirSync(EVAL_CONFIGS)
			.filter((file) => file.endsWith(".jsonc"))
			.map((file) => join(EVAL_CONFIGS, file)),
	];

	it.each(shipped)("%s names only real modules and real settings", (path) => {
		const { problems } = loadConfig({
			cwd: ROOT,
			env: { EXO_CONFIG: path },
			readFile: (p) => (p === path ? readFileSync(p, "utf8") : undefined),
			modules: MODULE_SETTINGS,
		});
		expect(problems).toEqual([]);
	});

	it("knows the five modules", () => {
		expect(Object.keys(MODULE_SETTINGS).sort()).toEqual(["compaction", "memory", "supervisor", "triage", "trimmer"]);
	});
});

describe("a mistyped module or setting (D7, D-033)", () => {
	let dir: string | undefined;
	afterEach(() => {
		vi.unstubAllEnvs();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	async function start(config: Record<string, unknown>) {
		dir = mkdtempSync(join(tmpdir(), "exo-settings-"));
		const configPath = join(dir, "config.jsonc");
		writeFileSync(configPath, JSON.stringify({ trace: { enabled: false }, ...config }));
		vi.stubEnv("EXO_CONFIG", configPath);
		vi.stubEnv("EXO_DEBUG", "");
		const pi = createFakePi({ cwd: dir });
		exocortex(pi.api);
		await pi.emit("session_start", { reason: "startup" });
		return pi.ui.filter((call) => call.method === "notify").map((call) => String(call.args[0]));
	}

	it("disables Exocortex and tells the user which key", async () => {
		const typo = await start({ modules: { supervisor: { enabled: true, chekcs: ["npm test"] } } });
		expect(typo).toEqual([expect.stringContaining("config /modules/supervisor/chekcs: no such setting")]);
		expect(typo[0]).toMatch(/^Exocortex disabled by config problems/);

		const unknown = await start({ modules: { supervisr: { enabled: true } } });
		expect(unknown).toEqual([expect.stringContaining("config /modules/supervisr: no such module")]);

		const bad = await start({ modules: { triage: { loopThreshold: "three" } } });
		expect(bad).toEqual([expect.stringContaining("config /modules/triage/loopThreshold")]);
	});

	it("says nothing about a valid config, with or without `enabled`", async () => {
		expect(await start({ modules: { triage: { loopThreshold: 4 }, trimmer: { enabled: true } } })).toEqual([]);
	});
});
