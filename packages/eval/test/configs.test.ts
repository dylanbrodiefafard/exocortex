import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@exocortex/core";
import { describe, expect, it } from "vitest";

const CONFIGS_DIR = join(import.meta.dirname, "..", "configs");
/** Module ids the pi adapter hosts (packages/pi-adapter/src/modules.ts). */
const KNOWN_MODULES = ["trimmer", "tools", "triage", "memory", "supervisor", "compaction"];

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

	it("supervisor-lean turns off what D-107 turned on by default, and nothing else", () => {
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
		expect(options("supervisor-lean")).toEqual({ review: false, verifyUncertain: false });
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
