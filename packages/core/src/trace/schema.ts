import type { DatabaseSync } from "node:sqlite";

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
];

const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: DatabaseSync): void {
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
	const current = row?.user_version ?? 0;
	if (current > SCHEMA_VERSION) {
		throw new Error(`trace db schema v${current} is newer than this Exocortex (v${SCHEMA_VERSION})`);
	}
	for (let version = current; version < SCHEMA_VERSION; version++) {
		db.exec("BEGIN");
		try {
			db.exec(MIGRATIONS[version] ?? "");
			db.exec(`PRAGMA user_version = ${version + 1}`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
}
