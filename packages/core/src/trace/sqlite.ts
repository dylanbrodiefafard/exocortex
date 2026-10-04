import type { DatabaseSync } from "node:sqlite";

type SqliteModule = typeof import("node:sqlite");

let cached: SqliteModule | undefined;

/**
 * Loads `node:sqlite` without printing Node 22's one-time "SQLite is an experimental feature"
 * warning, which would otherwise land in pi's TUI. Only that exact warning is suppressed, and
 * only during the load.
 */
function loadSqlite(): SqliteModule {
	if (cached) return cached;
	const original = process.emitWarning;
	const filtered = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
		const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
		const message = typeof warning === "string" ? warning : warning.message;
		if (type === "ExperimentalWarning" && message.includes("SQLite")) return;
		Reflect.apply(original, this, [warning, ...rest]);
	};
	process.emitWarning = filtered as typeof process.emitWarning;
	try {
		const loaded = process.getBuiltinModule("node:sqlite");
		cached = loaded;
		return loaded;
	} finally {
		process.emitWarning = original;
	}
}

export function openDatabase(path: string): DatabaseSync {
	const { DatabaseSync } = loadSqlite();
	const db = new DatabaseSync(path);
	db.exec(
		"PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;",
	);
	return db;
}
