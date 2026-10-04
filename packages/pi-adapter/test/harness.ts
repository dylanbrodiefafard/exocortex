import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type Runtime } from "../src/runtime.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

export interface AdapterHarness {
	readonly dir: string;
	/** The global config file (EXO_CONFIG); rewrite it before `activate` to change config. */
	readonly configPath: string;
	readonly env: Record<string, string | undefined>;
	readonly runtime: Runtime;
	readonly pi: FakePi;
	readonly errors: { where: string; error: unknown }[];
	readonly onError: (where: string, error: unknown) => void;
	cleanup(): void;
}

/**
 * A temp cwd with `config` as the global Exocortex config, a runtime and a fake pi. Pass a
 * function to build config from the temp dir (e.g. a trace dbPath inside it).
 */
export function createAdapterHarness(
	configOrBuild: Record<string, unknown> | ((dir: string) => Record<string, unknown>),
	options: { hasUI?: boolean } = {},
): AdapterHarness {
	const dir = mkdtempSync(join(tmpdir(), "exo-adapter-"));
	const configPath = join(dir, "global.jsonc");
	const config = typeof configOrBuild === "function" ? configOrBuild(dir) : configOrBuild;
	writeFileSync(configPath, JSON.stringify({ trace: { enabled: false }, ...config }));
	const env = { EXO_CONFIG: configPath };
	const errors: { where: string; error: unknown }[] = [];
	const onError = (where: string, error: unknown) => {
		errors.push({ where, error });
	};
	const runtime = createRuntime({ env, onError });
	const pi = createFakePi({ cwd: dir, ...(options.hasUI === undefined ? {} : { hasUI: options.hasUI }) });
	return {
		dir,
		configPath,
		env,
		runtime,
		pi,
		errors,
		onError,
		cleanup() {
			runtime.pool?.close();
			runtime.shutdown();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
