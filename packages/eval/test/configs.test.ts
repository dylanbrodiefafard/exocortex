import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@exocortex/core";
import { describe, expect, it } from "vitest";

const CONFIGS_DIR = join(import.meta.dirname, "..", "configs");
/** Module ids the pi adapter hosts (packages/pi-adapter/src/modules.ts). */
const KNOWN_MODULES = ["trimmer", "triage", "memory", "supervisor", "compaction"];

describe("eval configs", () => {
	const files = readdirSync(CONFIGS_DIR).filter((f) => f.endsWith(".jsonc"));

	it.each(files)("%s is a valid Exocortex config naming known modules", (file) => {
		const path = join(CONFIGS_DIR, file);
		const { config, problems } = loadConfig({
			cwd: CONFIGS_DIR,
			env: { EXO_CONFIG: path },
			readFile: (p) => (p === path ? readFileSync(p, "utf8") : undefined),
		});
		expect(problems).toEqual([]);
		for (const id of Object.keys(config.modules)) expect(KNOWN_MODULES).toContain(id);
	});

	it("each supervisor A/B config turns on one research option; only supervisor-research combines them (D-056)", () => {
		const options = (name: string) => {
			const path = join(CONFIGS_DIR, `${name}.jsonc`);
			const { config } = loadConfig({
				cwd: CONFIGS_DIR,
				env: { EXO_CONFIG: path },
				readFile: (p) => (p === path ? readFileSync(p, "utf8") : undefined),
			});
			const settings: Record<string, unknown> = { ...config.modules["supervisor"] };
			delete settings["enabled"];
			delete settings["mode"];
			return settings;
		};
		expect(options("supervisor")).toEqual({});
		expect(options("supervisor-items")).toEqual({ verdictStyle: "per-criterion" });
		expect(options("supervisor-claims")).toEqual({ finalMessage: "claims" });
		expect(options("supervisor-votes")).toEqual({ completeVotes: 3 });
		expect(options("supervisor-think")).toEqual({ thinking: true });
		// preVerdict and warningSignals are one option group (R1.1/R1.2).
		expect(options("supervisor-pre")).toEqual({ preVerdict: true, warningSignals: true });
		expect(options("supervisor-research")).toEqual({
			...options("supervisor-pre"),
			...options("supervisor-items"),
			...options("supervisor-claims"),
			...options("supervisor-votes"),
		});
	});

	it("the example config is valid and documents every module", () => {
		const path = join(import.meta.dirname, "..", "..", "..", "exocortex.config.example.jsonc");
		const { config, problems } = loadConfig({
			cwd: CONFIGS_DIR,
			env: { EXO_CONFIG: path },
			readFile: (p) => (p === path ? readFileSync(p, "utf8") : undefined),
		});
		expect(problems).toEqual([]);
		expect(Object.keys(config.modules).sort()).toEqual([...KNOWN_MODULES].sort());
	});
});
