import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const HOME = "/home/u";
const CWD = "/work/repo";

function load(files: Record<string, string>, env: Record<string, string> = {}) {
	return loadConfig({ cwd: CWD, env, homeDir: HOME, readFile: (path) => files[path] });
}

describe("loadConfig", () => {
	it("returns defaults when no files exist", () => {
		const { config, problems, sources } = load({});
		expect(problems).toEqual([]);
		expect(config).toEqual({
			enabled: true,
			trace: { enabled: true, dbPath: "/home/u/.exocortex/exocortex.db" },
			engine: { profile: "generic" },
			pool: {
				maxConcurrent: 6,
				reservedForMain: 2,
				timeoutMs: 20_000,
				sessionTokenBudget: 0,
				backgroundWhenIdleOnly: true,
			},
			embeddings: { timeoutMs: 2_000 },
			modules: {},
		});
		expect(sources).toEqual([
			{ path: "/home/u/.exocortex/config.jsonc", found: false },
			{ path: "/work/repo/.exocortex/config.jsonc", found: false },
		]);
	});

	it("merges global then project, deeply, with JSONC comments and trailing commas", () => {
		const { config, problems } = load({
			"/home/u/.exocortex/config.jsonc": `{
				// global
				"trace": { "dbPath": "~/traces/exo.db", },
				"modules": { "supervisor": { "enabled": true, "maxContinuations": 3 } },
			}`,
			"/work/repo/.exocortex/config.jsonc": `{ "modules": { "supervisor": { "maxContinuations": 1 } } }`,
		});
		expect(problems).toEqual([]);
		expect(config.trace.dbPath).toBe("/home/u/traces/exo.db");
		expect(config.modules["supervisor"]).toEqual({ enabled: true, maxContinuations: 1 });
	});

	it("EXO_CONFIG replaces the global file", () => {
		const { config, sources } = load(
			{ "/tmp/eval.jsonc": `{ "trace": { "dbPath": "/tmp/run.db" } }` },
			{ EXO_CONFIG: "/tmp/eval.jsonc" },
		);
		expect(config.trace.dbPath).toBe("/tmp/run.db");
		expect(sources[0]).toEqual({ path: "/tmp/eval.jsonc", found: true });
	});

	it("fails closed on a missing EXO_CONFIG file", () => {
		const { config, problems } = load({}, { EXO_CONFIG: "/nope.jsonc" });
		expect(config.enabled).toBe(false);
		expect(problems).toEqual(["EXO_CONFIG file not found: /nope.jsonc"]);
	});

	it("fails closed on invalid JSONC", () => {
		const { config, problems } = load({ "/home/u/.exocortex/config.jsonc": "{ trace: " });
		expect(config.enabled).toBe(false);
		expect(problems[0]).toMatch(/invalid JSONC/);
	});

	it("fails closed on schema violations, including unknown keys", () => {
		const { config, problems } = load({
			"/home/u/.exocortex/config.jsonc": `{ "enabled": "yes", "trcae": {} }`,
		});
		expect(config.enabled).toBe(false);
		expect(problems.length).toBeGreaterThanOrEqual(2);
		expect(config.trace.dbPath).toBe("/home/u/.exocortex/exocortex.db");
	});

	it("rejects a pool with no sidecar slots", () => {
		const { config, problems } = load({
			"/work/repo/.exocortex/config.jsonc": `{ "pool": { "maxConcurrent": 2, "reservedForMain": 2 } }`,
		});
		expect(config.enabled).toBe(false);
		expect(problems[0]).toMatch(/reservedForMain/);
	});

	it("respects the master switch", () => {
		const { config, problems } = load({ "/work/repo/.exocortex/config.jsonc": `{ "enabled": false }` });
		expect(problems).toEqual([]);
		expect(config.enabled).toBe(false);
	});
});
