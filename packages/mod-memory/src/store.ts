import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decodeVector, encodeVector, openDatabase } from "@exocortex/core";

/** One lesson (brief §6.4). Phase 5 v1 stores only `pitfall` cards (research R5.1). */
export interface Card {
	readonly id: number;
	/** Repo identity (D-018): git remote URL, else the root commit's tree hash, else the path. */
	readonly scope: string;
	readonly type: "pitfall";
	/** Normalized error signature: the exact retrieval key. */
	readonly signature: string;
	/** The error line it was learned from (full-text retrieval). */
	readonly trigger: string;
	readonly lesson: string;
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
	readonly trigger: string;
	readonly lesson: string;
	readonly evidence: string;
}

export interface MemoryStore {
	/** Live cards for a signature: this repo's first, then cards seen in 2+ other repos (D-018 promotion). */
	bySignature(scope: string, signature: string): Card[];
	/** Live cards whose trigger shares words with `text`, best first (FTS5 candidates, rescored). */
	search(scope: string, text: string, limit: number): { card: Card; overlap: number }[];
	/** ADD, or MERGE into the live card with the same scope and signature (delta ops only, R5.5). */
	upsert(card: NewCard): { readonly id: number; readonly merged: boolean };
	/** SUPERSEDE: retires `id` and adds its replacement. */
	supersede(id: number, card: NewCard): number;
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
	retirePreference(id: number): boolean;
	markPreferencesInjected(ids: readonly number[]): void;
	/** Stores the embedding of a card's trigger or a preference's rule, per embedding model (D-062). */
	setVector(kind: VectorKind, id: number, model: string, vector: Float32Array): void;
	/** Every stored vector of one kind and model, by card or preference id. */
	vectors(kind: VectorKind, model: string): Map<number, Float32Array>;
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

const MIGRATIONS: readonly string[] = [
	`
	CREATE TABLE cards (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		scope TEXT NOT NULL,
		type TEXT NOT NULL DEFAULT 'pitfall',
		signature TEXT NOT NULL,
		trigger TEXT NOT NULL,
		lesson TEXT NOT NULL,
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
	`,
	`
	CREATE TABLE preferences (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		rule TEXT NOT NULL,
		injected INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		valid_to INTEGER
	);
	CREATE TABLE preference_sightings (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		preference_id INTEGER NOT NULL REFERENCES preferences(id),
		scope TEXT NOT NULL,
		session TEXT NOT NULL,
		standing INTEGER NOT NULL DEFAULT 0,
		quote TEXT NOT NULL,
		seen_at INTEGER NOT NULL
	);
	CREATE INDEX preference_sightings_preference ON preference_sightings (preference_id);
	`,
	`
	CREATE TABLE vectors (
		kind TEXT NOT NULL,
		ref_id INTEGER NOT NULL,
		model TEXT NOT NULL,
		vector BLOB NOT NULL,
		PRIMARY KEY (kind, ref_id, model)
	);
	`,
	`
	ALTER TABLE preferences ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'any';
	ALTER TABLE preferences ADD COLUMN repeated INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE preference_sightings ADD COLUMN correction INTEGER NOT NULL DEFAULT 0;
	`,
	`
	ALTER TABLE preference_sightings ADD COLUMN source TEXT NOT NULL DEFAULT 'message';
	`,
];

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
	trigger: string;
	lesson: string;
	evidence: string;
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

/** Opens (and migrates) the memory card store. `:memory:` for tests. */
export function openMemoryStore(path: string, now: () => number = Date.now): MemoryStore {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = openDatabase(path);
	migrate(db);
	const live = "valid_to IS NULL";
	const select = (where: string) => db.prepare(`SELECT * FROM cards WHERE ${where}`);

	function insert(card: NewCard): number {
		const result = db
			.prepare("INSERT INTO cards (scope, signature, trigger, lesson, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run(card.scope, card.signature, card.trigger, card.lesson, card.evidence, now());
		const id = Number(result.lastInsertRowid);
		db.prepare("INSERT INTO cards_fts (trigger, lesson, card_id) VALUES (?, ?, ?)").run(card.trigger, card.lesson, id);
		return id;
	}

	return {
		bySignature(scope, signature) {
			const local = (select(`${live} AND scope = ? AND signature = ?`).all(scope, signature) as unknown as Row[]).map(
				toCard,
			);
			if (local.length > 0) return local;
			const others = (select(`${live} AND signature = ? AND scope != ?`).all(signature, scope) as unknown as Row[]).map(
				toCard,
			);
			return new Set(others.map((c) => c.scope)).size >= 2 ? others : [];
		},

		search(scope, text, limit) {
			const words = keywords(text);
			if (words.length === 0) return [];
			const query = words.map((w) => `"${w}"`).join(" OR ");
			const rows = db
				.prepare(
					`SELECT c.* FROM cards_fts f JOIN cards c ON c.id = f.card_id
					 WHERE cards_fts MATCH ? AND c.${live} AND c.scope = ? ORDER BY bm25(cards_fts) LIMIT ?`,
				)
				.all(`trigger : (${query})`, scope, limit * 4) as unknown as Row[];
			return rows
				.map((row) => {
					const card = toCard(row);
					const triggerWords = new Set(keywords(card.trigger));
					return { card, overlap: words.filter((w) => triggerWords.has(w)).length / words.length };
				})
				.sort((a, b) => b.overlap - a.overlap)
				.slice(0, limit);
		},

		upsert(card) {
			const existing = select(`${live} AND scope = ? AND signature = ?`).get(card.scope, card.signature) as unknown as
				| Row
				| undefined;
			if (existing) {
				db.prepare("UPDATE cards SET seen = seen + 1, evidence = ? WHERE id = ?").run(
					mergeEvidence(existing.evidence, card.evidence),
					existing.id,
				);
				return { id: existing.id, merged: true };
			}
			return { id: insert(card), merged: false };
		},

		supersede(id, card) {
			db.prepare("UPDATE cards SET valid_to = ? WHERE id = ? AND valid_to IS NULL").run(now(), id);
			return insert(card);
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

		retirePreference(id) {
			return (
				Number(
					db.prepare("UPDATE preferences SET valid_to = ? WHERE id = ? AND valid_to IS NULL").run(now(), id).changes,
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

		vectors(kind, model) {
			const rows = db.prepare("SELECT ref_id, vector FROM vectors WHERE kind = ? AND model = ?").all(kind, model);
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
			trigger: row.trigger,
			lesson: row.lesson,
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

function migrate(db: DatabaseSync): void {
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
	const current = row?.user_version ?? 0;
	if (current > MIGRATIONS.length) throw new Error(`memory store schema v${current} is newer than this Exocortex`);
	for (let version = current; version < MIGRATIONS.length; version++) {
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
