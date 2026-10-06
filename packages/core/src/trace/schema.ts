import type { DatabaseSync } from "node:sqlite";
import { rollback } from "./sqlite.ts";

/**
 * Ordered migrations. Index + 1 is the schema version stored in `PRAGMA user_version`.
 * Never edit a released migration; append a new one.
 */
const MIGRATIONS: readonly string[] = [
	`
	CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		harness TEXT NOT NULL,
		harness_session_id TEXT,
		cwd TEXT NOT NULL,
		label TEXT,
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		meta TEXT NOT NULL DEFAULT '{}'
	);
	CREATE TABLE events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL REFERENCES sessions(id),
		seq INTEGER NOT NULL,
		ts INTEGER NOT NULL,
		kind TEXT NOT NULL,
		turn INTEGER,
		synthetic INTEGER NOT NULL DEFAULT 0,
		module TEXT,
		data TEXT NOT NULL,
		UNIQUE (session_id, seq)
	);
	CREATE INDEX events_kind ON events (kind, session_id);
	`,
	`
	CREATE TABLE sidecar_calls (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL REFERENCES sessions(id),
		ts INTEGER NOT NULL,
		module TEXT NOT NULL,
		priority TEXT NOT NULL,
		outcome TEXT NOT NULL,
		prompt_hash TEXT NOT NULL,
		queue_ms INTEGER NOT NULL,
		latency_ms INTEGER NOT NULL,
		attempts INTEGER NOT NULL,
		max_tokens INTEGER NOT NULL,
		prompt_tokens INTEGER NOT NULL,
		cached_tokens INTEGER,
		completion_tokens INTEGER NOT NULL,
		error TEXT
	);
	CREATE INDEX sidecar_calls_session ON sidecar_calls (session_id, module);
	`,
];

const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Brings the database to the current schema. Two processes may open a new file at once, so the
 * version is read again inside a write transaction: the one that waited finds the work done.
 */
export function migrate(db: DatabaseSync): void {
	if (checkedVersion(db) === SCHEMA_VERSION) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		for (let version = checkedVersion(db); version < SCHEMA_VERSION; version++) {
			db.exec(MIGRATIONS[version] ?? "");
		}
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		db.exec("COMMIT");
	} catch (error) {
		rollback(db);
		throw error;
	}
}

function checkedVersion(db: DatabaseSync): number {
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
	const current = row?.user_version ?? 0;
	if (current > SCHEMA_VERSION) {
		throw new Error(`trace db schema v${current} is newer than this Exocortex (v${SCHEMA_VERSION})`);
	}
	return current;
}
