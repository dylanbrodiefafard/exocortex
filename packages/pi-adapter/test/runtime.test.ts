import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AdapterHarness, createAdapterHarness } from "./harness.ts";

let harness: AdapterHarness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

describe("runtime", () => {
	it("activates once and opens the trace store when tracing is on", () => {
		harness = createAdapterHarness({});
		const dbPath = join(harness.dir, "trace.db");
		writeFileSync(harness.configPath, JSON.stringify({ trace: { enabled: true, dbPath } }));
		const { runtime } = harness;
		const loaded = runtime.activate(harness.dir);
		expect(runtime.activate("/elsewhere")).toBe(loaded);
		expect(runtime.config?.trace.dbPath).toBe(dbPath);
		expect(runtime.store).toBeDefined();
		expect(existsSync(dbPath)).toBe(true);
		runtime.shutdown();
		expect(runtime.store).toBeUndefined();
		runtime.shutdown();
	});

	it("does not open a store when tracing is off or Exocortex is disabled", () => {
		harness = createAdapterHarness({ enabled: false, trace: { enabled: true, dbPath: "x.db" } });
		harness.runtime.activate(harness.dir);
		expect(harness.runtime.store).toBeUndefined();
	});

	it("reports a store that cannot be opened instead of throwing", () => {
		harness = createAdapterHarness({});
		// The parent "directory" is a regular file, so the store cannot be created.
		const configPath = harness.configPath;
		writeFileSync(configPath, JSON.stringify({ trace: { enabled: true, dbPath: join(configPath, "trace.db") } }));
		harness.runtime.activate(harness.dir);
		expect(harness.runtime.store).toBeUndefined();
		expect(harness.errors.map((e) => e.where)).toEqual(["trace open"]);
	});

	it("fails closed on invalid config", () => {
		harness = createAdapterHarness({ pool: { maxConcurrent: 1, reservedForMain: 1 } });
		const loaded = harness.runtime.activate(harness.dir);
		expect(loaded.config.enabled).toBe(false);
		expect(loaded.problems.length).toBeGreaterThan(0);
	});
});
