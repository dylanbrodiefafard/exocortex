import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const ModuleConfig = Type.Object({ enabled: Type.Boolean({ default: false }) }, { additionalProperties: true });

const ExoConfigSchema = Type.Object(
	{
		/** Master kill switch: false disables every module and the trace store. */
		enabled: Type.Boolean({ default: true }),
		trace: Type.Object(
			{
				enabled: Type.Boolean({ default: true }),
				/** SQLite file. `~` expands to the home directory; relative paths resolve against the config dir. */
				dbPath: Type.String({ default: "~/.exocortex/exocortex.db" }),
			},
			{ default: {}, additionalProperties: false },
		),
		/** Per-module settings keyed by module id. Modules are off unless enabled here (D-001). */
		modules: Type.Record(Type.String(), ModuleConfig, { default: {} }),
	},
	{ additionalProperties: false },
);

export type ExoConfig = Static<typeof ExoConfigSchema>;

export interface ConfigSource {
	readonly path: string;
	readonly found: boolean;
}

export interface LoadedConfig {
	readonly config: ExoConfig;
	/** Files consulted, in precedence order (later wins). */
	readonly sources: readonly ConfigSource[];
	/** Problems found. Any problem disables Exocortex (`config.enabled = false`): fail closed. */
	readonly problems: readonly string[];
}

export interface LoadConfigOptions {
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly homeDir?: string;
	/** Returns file contents, or undefined when the file does not exist. */
	readonly readFile?: (path: string) => string | undefined;
}

const GLOBAL_CONFIG_RELATIVE = join(".exocortex", "config.jsonc");
const PROJECT_CONFIG_RELATIVE = join(".exocortex", "config.jsonc");

/**
 * Loads config from defaults, then the global file (`~/.exocortex/config.jsonc`, or `EXO_CONFIG`
 * when set), then `<cwd>/.exocortex/config.jsonc`. Objects merge deeply; later files win.
 */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
	const env = options.env ?? process.env;
	const home = options.homeDir ?? homedir();
	const readFile = options.readFile ?? readFileIfExists;
	const explicit = env["EXO_CONFIG"];
	const paths = [
		explicit ? resolve(options.cwd, explicit) : join(home, GLOBAL_CONFIG_RELATIVE),
		join(options.cwd, PROJECT_CONFIG_RELATIVE),
	];

	const problems: string[] = [];
	const sources: ConfigSource[] = [];
	let merged: Record<string, unknown> = {};
	for (const path of [...new Set(paths)]) {
		const text = readFile(path);
		sources.push({ path, found: text !== undefined });
		if (text === undefined) {
			if (path === paths[0] && explicit) problems.push(`EXO_CONFIG file not found: ${path}`);
			continue;
		}
		const parsed = parseConfigText(text, path, problems);
		if (parsed) merged = deepMerge(merged, parsed);
	}

	const withDefaults = Value.Default(ExoConfigSchema, merged);
	if (!Value.Check(ExoConfigSchema, withDefaults)) {
		for (const error of Value.Errors(ExoConfigSchema, withDefaults)) {
			problems.push(`config ${error.instancePath || "/"}: ${error.message}`);
		}
		return { config: disabledConfig(home), sources, problems };
	}
	const config: ExoConfig = {
		...withDefaults,
		trace: { ...withDefaults.trace, dbPath: expandPath(withDefaults.trace.dbPath, home) },
	};
	return { config: problems.length > 0 ? { ...config, enabled: false } : config, sources, problems };
}

function parseConfigText(text: string, path: string, problems: string[]): Record<string, unknown> | undefined {
	const errors: ParseError[] = [];
	const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const detail = errors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join(", ");
		problems.push(`${path}: invalid JSONC (${detail})`);
		return undefined;
	}
	if (!isPlainObject(value)) {
		problems.push(`${path}: top level must be an object`);
		return undefined;
	}
	return value;
}

function disabledConfig(home: string): ExoConfig {
	const defaults = Value.Default(ExoConfigSchema, {}) as ExoConfig;
	return {
		...defaults,
		enabled: false,
		trace: { ...defaults.trace, dbPath: expandPath(defaults.trace.dbPath, home) },
	};
}

function expandPath(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return isAbsolute(path) ? path : resolve(path);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = result[key];
		result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
	}
	return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFileIfExists(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
