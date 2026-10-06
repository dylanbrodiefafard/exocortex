import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decodeVector, encodeVector, openDatabase } from "@exocortex/core";

/**
 * One problem and the fix that was verified for it (brief §6.4, D-072). Phase 5 v1 stores only
 * `pitfall` cards (research R5.1).
 */
export interface Card {
	readonly id: number;
	/** Repo identity (D-018): git remote URL, else the root commit's tree hash, else the path. */
	readonly scope: string;
	readonly type: "pitfall";
	/** Normalized error signature: the kind of failure. Several problems can share one (D-072). */
	readonly signature: string;
	/** The names the failure mentioned (tests, symbols, error codes): which problem of that kind it was. */
	readonly detail: readonly string[];
	/** The files that were edited before the command passed. */
	readonly files: readonly string[];
	/** The error line it was learned from (full-text retrieval). */
	readonly trigger: string;
	readonly lesson: string;
	/**
	 * A sidecar wrote the lesson and found the fix worth keeping. Otherwise it is the deterministic
	 * summary, which quotes the edit: it is never shown in another repo.
	 */
	readonly distilled: boolean;
	/** Trace references and the fix, for audit. */
	readonly evidence: string;
	readonly seen: number;
	readonly injected: number;
	readonly helped: number;
	readonly hurt: number;
	readonly createdAt: number;
	/** Set when retired or superseded (cards are never deleted). */
	readonly validTo: number | null;
}

export interface NewCard {
	readonly scope: string;
	readonly signature: string;
	readonly detail: readonly string[];
	readonly files: readonly string[];
	readonly trigger: string;
	readonly lesson: string;
	readonly evidence: string;
	readonly distilled?: boolean;
}

/** Who retired a preference: the user's `forget`, a later interview answer, or a sidecar's reading of a message. */
export type RetiredBy = "user" | "interview" | "model";

interface RetiredPreference {
	readonly id: number;
	readonly rule: string;
	readonly taskKind: TaskKind;
	readonly retiredAt: number;
	readonly retiredBy: RetiredBy;
}

export interface MemoryStore {
	/** Live cards for a signature, from every repo. The caller decides which are the same problem (D-072). */
	bySignature(signature: string): Card[];
	/**
	 * Live cards of one repo whose trigger shares at least {@link MIN_SHARED_KEYWORDS} keywords with
	 * `text`, best first. `overlap` is the smaller of the two shares: how much of the text's keywords
	 * the trigger has, and how much of the trigger's the text has. A text with fewer keywords than
	 * that says too little to match on.
	 */
	search(scope: string, text: string, limit: number): { card: Card; overlap: number }[];
	card(id: number): Card | undefined;
	/** ADD (delta ops only, R5.5). */
	add(card: NewCard): number;
	/** MERGE: the card's problem was fixed again. `seen` goes up and the evidence is appended. */
	merge(id: number, evidence: string): void;
	/** SUPERSEDE: retires `id` and adds its replacement. */
	supersede(id: number, card: NewCard): number;
	/** RETIRE one card. False when it was not live. */
	retire(id: number): boolean;
	/**
	 * RETIRE a repo's live cards beyond `max`, the least useful first (helped − hurt, then the
	 * oldest). Returns how many it retired.
	 */
	trim(scope: string, max: number): number;
	markInjected(id: number): void;
	credit(id: number, outcome: "helped" | "hurt"): void;
	/** RETIRE cards that hurt more than they help (R5.3): hurt − helped ≥ 2 after 3+ injections. */
	retireUnhelpful(): number;
	cards(scope?: string): Card[];
	/** Live preferences with every sighting, oldest first (D-060). */
	preferences(): StoredPreference[];
	/** ADD a preference; its first sighting is recorded separately. */
	addPreference(rule: string, taskKind?: TaskKind): number;
	/** The user stated it for a second kind of task: it now applies to any (D-064). */
	widenPreference(id: number): void;
	/** The user had to correct the agent on it although it was in the conversation (D-064). */
	markPreferenceRepeated(id: number): void;
	/** MERGE: the user stated this preference (again). */
	addSighting(
		preferenceId: number,
		sighting: Omit<Sighting, "seenAt" | "source"> & { readonly source?: SightingSource },
	): void;
	/** RETIRE: the user withdrew it, or asked to forget it. False when it was not live. */
	retirePreference(id: number, by?: RetiredBy): boolean;
	/** The preferences retired last, newest first. */
	retiredPreferences(limit: number): RetiredPreference[];
	/** Makes a retired preference live again, with the sightings it had. False when it was not retired. */
	restorePreference(id: number): boolean;
	markPreferencesInjected(ids: readonly number[]): void;
	/** Stores the embedding of a card's trigger or a preference's rule, per embedding model (D-062). */
	setVector(kind: VectorKind, id: number, model: string, vector: Float32Array): void;
	/**
	 * Stored vectors of one kind and model, by card or preference id. With `scope`: only those of
	 * that repo's live cards.
	 */
	vectors(kind: VectorKind, model: string, scope?: string): Map<number, Float32Array>;
	close(): void;
}

type VectorKind = "card" | "preference";

/** The kind of task an expectation is about (D-064); `any` is a preference for all work. */
export const TASK_KINDS = ["any", "fix", "feature", "refactor", "test", "review", "explain", "docs"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** Where a sighting came from: a message the user typed, or an answer in the interview (D-066). */
export type SightingSource = "message" | "interview";

/** One time the user stated a preference, in their own words. */
export interface Sighting {
	readonly scope: string;
	/** The harness session it was said in: separate sessions are separate evidence. */
	readonly session: string;
	/** Said as a standing rule ("always…", "from now on…"). */
	readonly standing: boolean;
	/** Said to correct what the agent had just done (D-064). */
	readonly correction: boolean;
	/** The user's words, verbatim. For an interview answer: the question and the option they picked. */
	readonly quote: string;
	readonly source: SightingSource;
	readonly seenAt: number;
}

/**
 * How the user likes work done (D-060), or what they expect of one kind of task (D-064). Global;
 * its sightings say where it applies.
 */
export interface StoredPreference {
	readonly id: number;
	readonly rule: string;
	readonly taskKind: TaskKind;
	readonly injected: number;
	/** Times the user corrected the agent on it after it had been added to the conversation. */
	readonly repeated: number;
	readonly createdAt: number;
	readonly sightings: readonly Sighting[];
}

/**
 * The schema's version. Nothing is released, so there is one schema and no migrations (D-088): a
 * store at any other version is set aside and a new one started. The first change after a release
 * adds a migration here and stops setting stores aside.
 */
const SCHEMA_VERSION = 1;

const SCHEMA = `
	CREATE TABLE cards (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		scope TEXT NOT NULL,
		type TEXT NOT NULL DEFAULT 'pitfall',
		signature TEXT NOT NULL,
		detail TEXT NOT NULL DEFAULT '',
		files TEXT NOT NULL DEFAULT '',
		trigger TEXT NOT NULL,
		lesson TEXT NOT NULL,
		distilled INTEGER NOT NULL DEFAULT 0,
		evidence TEXT NOT NULL,
		seen INTEGER NOT NULL DEFAULT 1,
		injected INTEGER NOT NULL DEFAULT 0,
		helped INTEGER NOT NULL DEFAULT 0,
		hurt INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		valid_to INTEGER
	);
	CREATE INDEX cards_signature ON cards (signature, valid_to);
	CREATE INDEX cards_scope ON cards (scope, valid_to);
	CREATE VIRTUAL TABLE cards_fts USING fts5(trigger, lesson, card_id UNINDEXED, tokenize = 'unicode61');
	CREATE TABLE preferences (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		rule TEXT NOT NULL,
		task_kind TEXT NOT NULL DEFAULT 'any',
		injected INTEGER NOT NULL DEFAULT 0,
		repeated INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		valid_to INTEGER,
		retired_by TEXT
	);
	CREATE TABLE preference_sightings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		preference_id INTEGER NOT NULL REFERENCES preferences(id),
		scope TEXT NOT NULL,
		session TEXT NOT NULL,
		standing INTEGER NOT NULL DEFAULT 0,
		correction INTEGER NOT NULL DEFAULT 0,
		quote TEXT NOT NULL,
		source TEXT NOT NULL DEFAULT 'message',
		seen_at INTEGER NOT NULL
	);
	CREATE INDEX preference_sightings_preference ON preference_sightings (preference_id);
	CREATE TABLE vectors (
		kind TEXT NOT NULL,
		ref_id INTEGER NOT NULL,
		model TEXT NOT NULL,
		vector BLOB NOT NULL,
		PRIMARY KEY (kind, ref_id, model)
	);
`;

/** Fewer shared keywords than this is a coincidence, not a similar error. */
const MIN_SHARED_KEYWORDS = 3;
/** Keyword candidates read from the index before they are rescored. */
const SEARCH_CANDIDATES = 500;

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"not",
	"with",
	"from",
	"this",
	"that",
	"error",
	"errors",
	"line",
	"file",
]);

interface Row {
	id: number;
	scope: string;
	type: string;
	signature: string;
	detail: string;
	files: string;
	trigger: string;
	lesson: string;
	evidence: string;
	distilled: number;
	seen: number;
	injected: number;
	helped: number;
	hurt: number;
	created_at: number;
	valid_to: number | null;
}

interface PreferenceRow {
	id: number;
	rule: string;
	task_kind: string;
	injected: number;
	repeated: number;
	created_at: number;
}

interface SightingRow {
	preference_id: number;
	scope: string;
	session: string;
	standing: number;
	correction: number;
	quote: string;
	source: string;
	seen_at: number;
}

/**
 * Opens the memory card store, creating it when new. `:memory:` for tests.
 * - The file is the user's alone (mode 600): it holds their words and pieces of their code.
 * - A file that is not a database, or a damaged one, is set aside as `<name>.corrupt-<time>` and a
 *   new store is started; `report` is told. So is a store at another schema version, as
 *   `<name>.other-schema-<time>` (D-088).
 */
export function openMemoryStore(
	path: string,
	now: () => number = Date.now,
	report: (message: string) => void = () => {},
): MemoryStore {
	const db = openStoreFile(path, now, report);
	const live = "valid_to IS NULL";
	const select = (where: string) => db.prepare(`SELECT * FROM cards WHERE ${where}`);
	let depth = 0;

	/** Runs `work` as one write transaction: all of it is stored, or none. Nests. */
	function atomically<T>(work: () => T): T {
		if (depth > 0) return work();
		db.exec("BEGIN IMMEDIATE");
		depth += 1;
		try {
			const result = work();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		} finally {
			depth -= 1;
		}
	}

	function insert(card: NewCard): number {
		return atomically(() => {
			const result = db
				.prepare(
					"INSERT INTO cards (scope, signature, detail, files, trigger, lesson, evidence, distilled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					card.scope,
					card.signature,
					card.detail.join(" "),
					card.files.join("\n"),
					card.trigger,
					card.lesson,
					card.evidence,
					card.distilled ? 1 : 0,
					now(),
				);
			const id = Number(result.lastInsertRowid);
			db.prepare("INSERT INTO cards_fts (trigger, lesson, card_id) VALUES (?, ?, ?)").run(
				card.trigger,
				card.lesson,
				id,
			);
			return id;
		});
	}

	return {
		bySignature(signature) {
			return (select(`${live} AND signature = ? ORDER BY id`).all(signature) as unknown as Row[]).map(toCard);
		},

		search(scope, text, limit) {
			const words = keywords(text);
			if (words.length < MIN_SHARED_KEYWORDS) return [];
			const query = words.map((w) => `"${w}"`).join(" OR ");
			// The index only finds candidates: its ranking favours a rare word repeated over many
			// words shared, so every candidate is rescored before the list is cut.
			const rows = db
				.prepare(
					`SELECT c.* FROM cards_fts f JOIN cards c ON c.id = f.card_id
					 WHERE cards_fts MATCH ? AND c.${live} AND c.scope = ? ORDER BY bm25(cards_fts) LIMIT ?`,
				)
				.all(`trigger : (${query})`, scope, SEARCH_CANDIDATES) as unknown as Row[];
			return rows
				.flatMap((row) => {
					const card = toCard(row);
					const triggerWords = new Set(keywords(card.trigger));
					const shared = words.filter((w) => triggerWords.has(w)).length;
					if (shared < MIN_SHARED_KEYWORDS) return [];
					return [{ card, overlap: shared / Math.max(words.length, triggerWords.size) }];
				})
				.sort((a, b) => b.overlap - a.overlap || a.card.id - b.card.id)
				.slice(0, limit);
		},

		card(id) {
			const row = select("id = ?").get(id) as unknown as Row | undefined;
			return row && toCard(row);
		},

		add(card) {
			return insert(card);
		},

		merge(id, evidence) {
			atomically(() => {
				const existing = select("id = ?").get(id) as unknown as Row | undefined;
				if (!existing) return;
				db.prepare("UPDATE cards SET seen = seen + 1, evidence = ? WHERE id = ?").run(
					mergeEvidence(existing.evidence, evidence),
					id,
				);
			});
		},

		supersede(id, card) {
			return atomically(() => {
				db.prepare("UPDATE cards SET valid_to = ? WHERE id = ? AND valid_to IS NULL").run(now(), id);
				return insert(card);
			});
		},

		retire(id) {
			return Number(db.prepare(`UPDATE cards SET valid_to = ? WHERE id = ? AND ${live}`).run(now(), id).changes) > 0;
		},

		trim(scope, max) {
			return Number(
				db
					.prepare(
						`UPDATE cards SET valid_to = ? WHERE id IN (
							SELECT id FROM cards WHERE ${live} AND scope = ?
							ORDER BY helped - hurt DESC, created_at DESC, id DESC LIMIT -1 OFFSET ?)`,
					)
					.run(now(), scope, Math.max(0, max)).changes,
			);
		},

		markInjected(id) {
			db.prepare("UPDATE cards SET injected = injected + 1 WHERE id = ?").run(id);
		},

		credit(id, outcome) {
			db.prepare(
				`UPDATE cards SET ${outcome === "helped" ? "helped = helped + 1" : "hurt = hurt + 1"} WHERE id = ?`,
			).run(id);
		},

		retireUnhelpful() {
			return Number(
				db.prepare(`UPDATE cards SET valid_to = ? WHERE ${live} AND injected >= 3 AND hurt - helped >= 2`).run(now())
					.changes,
			);
		},

		cards(scope) {
			const rows = (scope === undefined ? select("1 = 1").all() : select("scope = ?").all(scope)) as unknown as Row[];
			return rows.map(toCard);
		},

		preferences() {
			const sightings = new Map<number, Sighting[]>();
			const rows = db.prepare("SELECT * FROM preference_sightings ORDER BY id").all() as unknown as SightingRow[];
			for (const row of rows) {
				sightings.set(row.preference_id, [
					...(sightings.get(row.preference_id) ?? []),
					{
						scope: row.scope,
						session: row.session,
						standing: row.standing === 1,
						correction: row.correction === 1,
						quote: row.quote,
						source: row.source === "interview" ? "interview" : "message",
						seenAt: row.seen_at,
					},
				]);
			}
			const live = db.prepare("SELECT * FROM preferences WHERE valid_to IS NULL ORDER BY id").all();
			return (live as unknown as PreferenceRow[]).map((row) => ({
				id: row.id,
				rule: row.rule,
				taskKind: TASK_KINDS.find((kind) => kind === row.task_kind) ?? "any",
				injected: row.injected,
				repeated: row.repeated,
				createdAt: row.created_at,
				sightings: sightings.get(row.id) ?? [],
			}));
		},

		addPreference(rule, taskKind = "any") {
			return Number(
				db.prepare("INSERT INTO preferences (rule, task_kind, created_at) VALUES (?, ?, ?)").run(rule, taskKind, now())
					.lastInsertRowid,
			);
		},

		widenPreference(id) {
			db.prepare("UPDATE preferences SET task_kind = 'any' WHERE id = ?").run(id);
		},

		markPreferenceRepeated(id) {
			db.prepare("UPDATE preferences SET repeated = repeated + 1 WHERE id = ?").run(id);
		},

		addSighting(preferenceId, sighting) {
			db.prepare(
				"INSERT INTO preference_sightings (preference_id, scope, session, standing, correction, quote, source, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				preferenceId,
				sighting.scope,
				sighting.session,
				sighting.standing ? 1 : 0,
				sighting.correction ? 1 : 0,
				sighting.quote,
				sighting.source ?? "message",
				now(),
			);
		},

		retirePreference(id, by = "user") {
			return (
				Number(
					db
						.prepare("UPDATE preferences SET valid_to = ?, retired_by = ? WHERE id = ? AND valid_to IS NULL")
						.run(now(), by, id).changes,
				) > 0
			);
		},

		retiredPreferences(limit) {
			const rows = db
				.prepare("SELECT * FROM preferences WHERE valid_to IS NOT NULL ORDER BY valid_to DESC, id DESC LIMIT ?")
				.all(limit) as unknown as (PreferenceRow & { valid_to: number; retired_by: string | null })[];
			return rows.map((row) => ({
				id: row.id,
				rule: row.rule,
				taskKind: TASK_KINDS.find((kind) => kind === row.task_kind) ?? "any",
				retiredAt: row.valid_to,
				retiredBy: row.retired_by === "model" || row.retired_by === "interview" ? row.retired_by : "user",
			}));
		},

		restorePreference(id) {
			return (
				Number(
					db
						.prepare("UPDATE preferences SET valid_to = NULL, retired_by = NULL WHERE id = ? AND valid_to IS NOT NULL")
						.run(id).changes,
				) > 0
			);
		},

		markPreferencesInjected(ids) {
			const update = db.prepare("UPDATE preferences SET injected = injected + 1 WHERE id = ?");
			for (const id of ids) update.run(id);
		},

		setVector(kind, id, model, vector) {
			db.prepare("INSERT OR REPLACE INTO vectors (kind, ref_id, model, vector) VALUES (?, ?, ?, ?)").run(
				kind,
				id,
				model,
				encodeVector(vector),
			);
		},

		vectors(kind, model, scope) {
			const rows =
				scope === undefined
					? db.prepare("SELECT ref_id, vector FROM vectors WHERE kind = ? AND model = ?").all(kind, model)
					: db
							.prepare(
								`SELECT v.ref_id, v.vector FROM vectors v JOIN cards c ON c.id = v.ref_id
								 WHERE v.kind = ? AND v.model = ? AND c.scope = ? AND c.${live}`,
							)
							.all(kind, model, scope);
			return new Map(
				(rows as unknown as { ref_id: number; vector: Uint8Array }[]).map((row) => [
					row.ref_id,
					decodeVector(row.vector),
				]),
			);
		},

		close() {
			db.close();
		},
	};

	function toCard(row: Row): Card {
		return {
			id: row.id,
			scope: row.scope,
			type: "pitfall",
			signature: row.signature,
			detail: row.detail === "" ? [] : row.detail.split(" "),
			files: row.files === "" ? [] : row.files.split("\n"),
			trigger: row.trigger,
			lesson: row.lesson,
			distilled: row.distilled === 1,
			evidence: row.evidence,
			seen: row.seen,
			injected: row.injected,
			helped: row.helped,
			hurt: row.hurt,
			createdAt: row.created_at,
			validTo: row.valid_to,
		};
	}
}

/** Distinctive lowercase words of an error line: identifiers and codes, not numbers or filler. */
export function keywords(text: string): string[] {
	const words = text
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
	return [...new Set(words)].slice(0, 16);
}

function mergeEvidence(previous: string, next: string): string {
	const merged = `${previous}\n---\n${next}`;
	return merged.length > 8_000 ? merged.slice(merged.length - 8_000) : merged;
}

/**
 * Creates the schema in a new database. The write transaction is taken before the version is
 * read, so of two processes opening a new store at once, the second waits and then finds it made.
 * Throws {@link OtherSchema} for a store at another version.
 */
export function ensureSchema(db: DatabaseSync): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
		const version = row?.user_version ?? 0;
		if (version !== 0 && version !== SCHEMA_VERSION) throw new OtherSchema(version);
		if (version === 0) {
			db.exec(SCHEMA);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/** The store was written with another schema version. */
class OtherSchema extends Error {
	constructor(version: number) {
		super(`schema v${version} is not this Exocortex's (v${SCHEMA_VERSION})`);
	}
}

/** What SQLite says when the file is not a database or its pages are damaged. */
const CORRUPT = /not a database|malformed|SQLITE_NOTADB|SQLITE_CORRUPT/i;

function openStoreFile(path: string, now: () => number, report: (message: string) => void): DatabaseSync {
	if (path === ":memory:") {
		const db = openDatabase(path);
		ensureSchema(db);
		return db;
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const open = (): DatabaseSync => {
		// Created before SQLite opens it, so the file and its journals never exist with wider access.
		if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
		for (const file of [path, `${path}-wal`, `${path}-shm`]) {
			try {
				if (existsSync(file)) chmodSync(file, 0o600);
			} catch {
				// Not ours to change (a shared store): SQLite decides whether it can be used.
			}
		}
		const db = openDatabase(path);
		try {
			ensureSchema(db);
			return db;
		} catch (error) {
			db.close();
			throw error;
		}
	};
	try {
		return open();
	} catch (error) {
		const other = error instanceof OtherSchema;
		if (!other && !CORRUPT.test(String(error))) throw error;
		const aside = `${path}.${other ? "other-schema" : "corrupt"}-${now()}`;
		renameSync(path, aside);
		for (const suffix of ["-wal", "-shm"]) {
			if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${aside}${suffix}`);
		}
		report(`memory store ${path}: ${String(error)}; set aside as ${aside}, starting a new one`);
		return open();
	}
}
