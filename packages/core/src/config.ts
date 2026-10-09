import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

/** The longest delay a Node timer takes; a longer one fires at once, so a huge timeout would mean none. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** A delay that is safe to hand to `setTimeout` or `AbortSignal.timeout`: 0 … 2^31−1, and 0 for NaN. */
export function clampTimeoutMs(ms: number): number {
	return Number.isNaN(ms) ? 0 : Math.min(Math.max(0, Math.round(ms)), MAX_TIMEOUT_MS);
}

/** Settings every module has; a module's own settings sit beside them. */
const ModuleConfig = Type.Object(
	{
		/** Modules are off unless this is true (D-001). */
		enabled: Type.Optional(Type.Boolean()),
		/** Upper bound on `max_tokens` for each of this module's sidecar calls. Default 4096. */
		maxTokensPerCall: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: true },
);

const FeatureFlags = Type.Object(
	{
		prefixCaching: Type.Optional(Type.Boolean()),
		cachedTokens: Type.Optional(Type.Boolean()),
		jsonSchema: Type.Optional(Type.Boolean()),
		thinkingToggle: Type.Optional(Type.Boolean()),
		priority: Type.Optional(Type.Boolean()),
		logprobs: Type.Optional(Type.Boolean()),
		n: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

/** Where sidecar calls go (docs/INFERENCE_ENGINES.md, D-032). Unset fields fall back to the harness's main model. */
const EngineConfig = Type.Object(
	{
		/** OpenAI-compatible base URL including `/v1`. */
		baseUrl: Type.Optional(Type.String({ minLength: 1 })),
		model: Type.Optional(Type.String({ minLength: 1 })),
		/** Literal key, or `$NAME` / `${NAME}` to read an environment variable. */
		apiKey: Type.Optional(Type.String()),
		profile: Type.Union(
			[
				Type.Literal("generic"),
				Type.Literal("vllm"),
				Type.Literal("sglang"),
				Type.Literal("llamacpp"),
				Type.Literal("ninfer"),
			],
			{ default: "generic" },
		),
		/** Per-feature overrides of the profile (F1–F7). */
		features: Type.Optional(FeatureFlags),
	},
	{ default: {}, additionalProperties: false },
);

const PoolConfig = Type.Object(
	{
		/** Requests the engine serves at once (its decode slots). */
		maxConcurrent: Type.Integer({ minimum: 1, default: 6 }),
		/** Slots sidecars never use, so the main agent is never queued behind them. */
		reservedForMain: Type.Integer({ minimum: 0, default: 2 }),
		/** Default end-to-end deadline (queue + generation) per sidecar call. */
		timeoutMs: Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS, default: 20_000 }),
		/**
		 * How long a `background` call may be held for the main agent in one stretch before it gives
		 * up (`expired_held`). Its deadline does not run while it is held (D-080). Default 10 minutes.
		 */
		maxHoldMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS })),
		/** Sidecar tokens (prompt + output) allowed per session; 0 = unlimited. */
		sessionTokenBudget: Type.Integer({ minimum: 0, default: 0 }),
		/** Hold `background` calls until the main agent is idle. */
		backgroundWhenIdleOnly: Type.Boolean({ default: true }),
	},
	{ default: {}, additionalProperties: false },
);

/**
 * An OpenAI-compatible `/embeddings` server, e.g. a small model on the CPU (D-026, D-062). Optional:
 * without `baseUrl` and `model`, modules match by keywords instead.
 */
const EmbeddingsConfig = Type.Object(
	{
		/** Base URL including `/v1`. */
		baseUrl: Type.Optional(Type.String({ minLength: 1 })),
		model: Type.Optional(Type.String({ minLength: 1 })),
		/** Literal key, or `$NAME` / `${NAME}` to read an environment variable. */
		apiKey: Type.Optional(Type.String()),
		/** Deadline per call; on the hot path a slow answer is worth less than the keyword fallback. */
		timeoutMs: Type.Integer({ minimum: 100, maximum: MAX_TIMEOUT_MS, default: 2_000 }),
	},
	{ default: {}, additionalProperties: false },
);

const ExoConfigSchema = Type.Object(
	{
		/** Master kill switch: false disables every module and the trace store. */
		enabled: Type.Boolean({ default: true }),
		trace: Type.Object(
			{
				enabled: Type.Boolean({ default: true }),
				/**
				 * SQLite file. `~` expands to the home directory; a relative path resolves against the
				 * directory of the config file that sets it.
				 */
				dbPath: Type.String({ default: "~/.exocortex/exocortex.db" }),
				/** Sessions older than this many days are deleted when the store opens; 0 keeps everything. */
				retentionDays: Type.Integer({ minimum: 0, maximum: 36_500, default: 0 }),
			},
			{ default: {}, additionalProperties: false },
		),
		engine: EngineConfig,
		pool: PoolConfig,
		embeddings: EmbeddingsConfig,
		/** Per-module settings keyed by module id. Modules are off unless enabled here (D-001). */
		modules: Type.Record(Type.String(), ModuleConfig, { default: {} }),
	},
	{ additionalProperties: false },
);

export type ExoConfig = Static<typeof ExoConfigSchema>;

/**
 * Who a setting belongs to (D-087). A project's own file (`<cwd>/.exocortex/config.jsonc`) arrives
 * with a cloned repository, so it is not the user's word. It may switch Exocortex and modules on
 * or off and tune them. Settings that say where things go, what is run or where files are
 * written belong to the user's file alone:
 * - here: everything but `enabled` and `modules`;
 * - in a module: the settings its schema marks with {@link USER_ONLY}.
 */
const PROJECT_KEYS: ReadonlySet<string> = new Set(["enabled", "modules"]);
const USER_ONLY_KEYS: ReadonlySet<string> = new Set(
	Object.keys(ExoConfigSchema.properties).filter((key) => !PROJECT_KEYS.has(key)),
);

/**
 * Schema option for a module setting only the user's own file may set: a command to run, a path
 * to write to. `Type.Array(Type.String(), { ...USER_ONLY })`.
 */
export const USER_ONLY = { userOnly: true } as const;

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
	/**
	 * Settings in the project's file that were left out because they are the user's to set. Not
	 * problems: someone else's file cannot switch Exocortex off this way, only fail to steer it.
	 */
	readonly ignored: readonly string[];
}

/** The modules that exist, by id, each with the schema of its own settings (`undefined`: any settings). */
export type ModuleSettingsSchemas = Readonly<Record<string, TSchema | undefined>>;

export interface LoadConfigOptions {
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly homeDir?: string;
	/** Returns file contents, or undefined when the file does not exist. */
	readonly readFile?: (path: string) => string | undefined;
	/**
	 * The modules that exist, by id, each with the schema of its own settings (`undefined`: any
	 * settings). When given, a `modules` entry under another id, a setting the schema does not
	 * name and a value the schema refuses are all problems. When left out, `modules` entries are
	 * checked only for the settings every module has.
	 */
	readonly modules?: ModuleSettingsSchemas;
}

const GLOBAL_CONFIG_RELATIVE = join(".exocortex", "config.jsonc");
const PROJECT_CONFIG_RELATIVE = join(".exocortex", "config.jsonc");

/**
 * Loads config from defaults, then the user's file (`~/.exocortex/config.jsonc`, or `EXO_CONFIG`
 * when set), then the project's file `<cwd>/.exocortex/config.jsonc`. Objects merge deeply; later
 * files win. The project's file may set only what is not the user's alone (D-087); the rest of
 * it is left out and listed in `ignored`. Never throws.
 */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
	const env = options.env ?? process.env;
	const home = options.homeDir ?? homedir();
	const readFile = options.readFile ?? readFileIfExists;
	const explicit = env["EXO_CONFIG"];
	const userPath = explicit ? resolve(options.cwd, explicit) : join(home, GLOBAL_CONFIG_RELATIVE);
	const projectPath = join(options.cwd, PROJECT_CONFIG_RELATIVE);
	// A file the user named with EXO_CONFIG is the user's file, wherever it is.
	const files = [
		{ path: userPath, project: false },
		...(projectPath === userPath ? [] : [{ path: projectPath, project: true }]),
	];

	const problems: string[] = [];
	const ignored: string[] = [];
	const sources: ConfigSource[] = [];
	let merged: Record<string, unknown> = {};
	for (const { path, project } of files) {
		const text = readSource(path, readFile, problems);
		sources.push({ path, found: text !== undefined });
		if (text === undefined) {
			if (!project && explicit) problems.push(`EXO_CONFIG file not found: ${path}`);
			continue;
		}
		const parsed = parseConfigText(text, path, problems);
		if (parsed) merged = deepMerge(merged, project ? projectSettings(parsed, options.modules, ignored) : parsed);
	}
	// A relative path resolves against the directory of the file that set it, and only the user's
	// file can set one.
	const config = validate(merged, home, dirname(userPath), options.modules, problems);
	return { config: problems.length > 0 ? { ...config, enabled: false } : config, sources, problems, ignored };
}

/** The merged settings as a config with defaults filled in; all defaults when they do not fit the schema. */
function validate(
	merged: Record<string, unknown>,
	home: string,
	pathBase: string,
	modules: ModuleSettingsSchemas | undefined,
	problems: string[],
): ExoConfig {
	const withDefaults = Value.Default(ExoConfigSchema, merged);
	if (!Value.Check(ExoConfigSchema, withDefaults)) {
		for (const error of Value.Errors(ExoConfigSchema, withDefaults)) {
			problems.push(`config ${error.instancePath || "/"}: ${error.message}`);
		}
		return disabledConfig(home);
	}
	const config: ExoConfig = {
		...withDefaults,
		trace: { ...withDefaults.trace, dbPath: expandPath(withDefaults.trace.dbPath, home, pathBase) },
	};
	checkValues(config, problems);
	if (modules) checkModules(config.modules, modules, problems);
	return config;
}

/** A config file's text; undefined when it does not exist or cannot be read (the latter is a problem). */
function readSource(
	path: string,
	readFile: (path: string) => string | undefined,
	problems: string[],
): string | undefined {
	try {
		return readFile(path);
	} catch (error) {
		problems.push(`${path}: cannot be read (${String(error)})`);
		return undefined;
	}
}

/** Rules the schema cannot state. */
function checkValues(config: ExoConfig, problems: string[]): void {
	if (config.pool.reservedForMain >= config.pool.maxConcurrent) {
		problems.push("config /pool: reservedForMain must be less than maxConcurrent (sidecars need at least one slot)");
	}
	for (const section of ["engine", "embeddings"] as const) {
		const baseUrl = config[section].baseUrl;
		if (baseUrl !== undefined && !isHttpUrl(baseUrl)) {
			problems.push(`config /${section}/baseUrl: not an http(s) URL: ${JSON.stringify(baseUrl)}`);
		}
	}
}

/** A project file's settings without the ones that are the user's alone; those are named in `ignored`. */
function projectSettings(
	parsed: Record<string, unknown>,
	modules: ModuleSettingsSchemas | undefined,
	ignored: string[],
): Record<string, unknown> {
	const allowed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (USER_ONLY_KEYS.has(key)) ignored.push(key);
		else if (key === "modules" && isPlainObject(value)) allowed[key] = projectModules(value, modules ?? {}, ignored);
		else allowed[key] = value;
	}
	return allowed;
}

function projectModules(
	entries: Record<string, unknown>,
	known: ModuleSettingsSchemas,
	ignored: string[],
): Record<string, unknown> {
	const allowed: Record<string, unknown> = {};
	for (const [id, settings] of Object.entries(entries)) {
		const userOnly = userOnlySettings(known[id]);
		if (!isPlainObject(settings) || userOnly.size === 0) {
			allowed[id] = settings;
			continue;
		}
		const kept: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(settings)) {
			if (userOnly.has(key)) ignored.push(`modules.${id}.${key}`);
			else kept[key] = value;
		}
		allowed[id] = kept;
	}
	return allowed;
}

/** The settings a module's schema marks {@link USER_ONLY}. */
function userOnlySettings(schema: TSchema | undefined): ReadonlySet<string> {
	const properties = (schema as { properties?: Record<string, { userOnly?: unknown }> } | undefined)?.properties ?? {};
	return new Set(Object.keys(properties).filter((key) => properties[key]?.userOnly === true));
}

/** Checks `modules` against the modules that exist and each one's own settings schema. */
function checkModules(modules: ExoConfig["modules"], known: ModuleSettingsSchemas, problems: string[]): void {
	const common = Object.keys(ModuleConfig.properties);
	for (const [id, settings] of Object.entries(modules)) {
		if (!Object.hasOwn(known, id)) {
			problems.push(`config /modules/${id}: no such module (known: ${Object.keys(known).join(", ") || "none"})`);
			continue;
		}
		const schema = known[id];
		if (!schema) continue;
		const named = Object.keys((schema as { properties?: Record<string, unknown> }).properties ?? {});
		// The module's schema is asked only about its own settings; a copy, since defaults are filled in.
		const own: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(settings)) {
			if (named.includes(key)) own[key] = structuredClone(value);
			else if (!common.includes(key)) problems.push(`config /modules/${id}/${key}: no such setting`);
		}
		const candidate = Value.Default(schema, own);
		if (Value.Check(schema, candidate)) continue;
		for (const error of Value.Errors(schema, candidate)) {
			problems.push(`config /modules/${id}${error.instancePath}: ${error.message}`);
		}
	}
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
	} catch {
		return false;
	}
}

function parseConfigText(text: string, path: string, problems: string[]): Record<string, unknown> | undefined {
	const errors: ParseError[] = [];
	const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const detail = errors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join(", ");
		problems.push(`${path}: invalid JSONC (${detail})`);
		return undefined;
	}
	const plain = withoutProtoKeys(value);
	if (!isPlainObject(plain)) {
		problems.push(`${path}: top level must be an object`);
		return undefined;
	}
	return plain;
}

/**
 * A copy without `__proto__` keys at any depth. The parser turns one into the object's
 * prototype, through which a file could supply keys that no check on its own keys would see.
 */
function withoutProtoKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutProtoKeys);
	if (!isPlainObject(value)) return value;
	const copy: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key !== "__proto__") copy[key] = withoutProtoKeys(item);
	}
	return copy;
}

function disabledConfig(home: string): ExoConfig {
	const defaults = Value.Default(ExoConfigSchema, {}) as ExoConfig;
	return {
		...defaults,
		enabled: false,
		trace: { ...defaults.trace, dbPath: expandPath(defaults.trace.dbPath, home, home) },
	};
}

function expandPath(path: string, home: string, base: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return isAbsolute(path) ? path : resolve(base, path);
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
