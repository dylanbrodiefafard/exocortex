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

const DEFAULT_BUSY_TIMEOUT_MS = 2_000;

export interface OpenDatabaseOptions {
	/**
	 * How long a statement waits for another connection's lock before failing with `SQLITE_BUSY`.
	 * Every call is synchronous, so this is also how long one statement can block the event loop.
	 */
	readonly busyTimeoutMs?: number;
}

/**
 * Opens a SQLite file in WAL mode with foreign keys on. The busy timeout is set first, so the
 * pragmas after it wait for another process that is opening the same file instead of failing (D-080).
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
	const { DatabaseSync } = loadSqlite();
	const db = new DatabaseSync(path);
	try {
		const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
		setBusyTimeout(db, busyTimeoutMs);
		enableWal(db, busyTimeoutMs);
		db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

/**
 * Switches a new file to WAL. The switch takes an exclusive lock and SQLite does not wait for
 * it (the busy timeout does not apply), so when another process is opening the same new file
 * this retries until that one is done, for as long as the busy timeout.
 */
function enableWal(db: DatabaseSync, busyTimeoutMs: number): void {
	const deadline = performance.now() + busyTimeoutMs;
	const pause = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
			if (mode?.journal_mode === "wal") return;
			db.exec("PRAGMA journal_mode = WAL");
			return;
		} catch (error) {
			if (!isTransientSqliteError(error) || performance.now() >= deadline) throw error;
			Atomics.wait(pause, 0, 0, 5);
		}
	}
}

export function setBusyTimeout(db: DatabaseSync, ms: number): void {
	db.exec(`PRAGMA busy_timeout = ${Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : DEFAULT_BUSY_TIMEOUT_MS}`);
}

/**
 * True when a SQLite error says "try again later" (another connection holds the lock, the disk is
 * full, an I/O error) and not "this statement is wrong".
 */
export function isTransientSqliteError(error: unknown): boolean {
	const code = (error as { errcode?: unknown } | null)?.errcode;
	if (typeof code !== "number") return false;
	// The primary result code is the low byte: BUSY 5, LOCKED 6, NOMEM 7, IOERR 10, FULL 13.
	return [5, 6, 7, 10, 13].includes(code & 0xff);
}

/** Rolls back an open transaction; never throws. */
export function rollback(db: DatabaseSync): void {
	try {
		if (db.isOpen && db.isTransaction) db.exec("ROLLBACK");
	} catch {
		// The transaction is gone either way.
	}
}
