import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "@exocortex/core";

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
	close(): void;
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
