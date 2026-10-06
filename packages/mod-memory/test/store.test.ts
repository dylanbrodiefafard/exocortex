import "./home-guard.ts";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@exocortex/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recall } from "../src/recall.ts";
import { ensureSchema, keywords, openMemoryStore } from "../src/store.ts";

const card = (scope: string, signature: string, trigger = "error[E0502]: cannot borrow `self.items` as mutable") => ({
	scope,
	signature,
	detail: ["e0502", "items"],
	files: ["src/lib.rs", "src/stack.rs"],
	trigger,
	lesson: `lesson for ${signature} in ${scope}`,
	evidence: "{}",
});

describe("memory store", () => {
	it("adds cards with their names and files, and merges a repeat into the card it is given", () => {
		const store = openMemoryStore(":memory:");
		const first = store.add(card("repo-a", "sig-1"));
		store.merge(first, '{"second":true}');
		store.merge(999, "{}");
		const [stored] = store.cards("repo-a");
		expect(stored).toMatchObject({
			seen: 2,
			lesson: "lesson for sig-1 in repo-a",
			detail: ["e0502", "items"],
			files: ["src/lib.rs", "src/stack.rs"],
			validTo: null,
		});
		expect(stored?.evidence).toContain('{"second":true}');
		expect(store.add({ ...card("repo-a", "sig-9"), detail: [], files: [] })).not.toBe(first);
		expect(store.bySignature("sig-9")[0]).toMatchObject({ detail: [], files: [] });
		store.close();
	});

	it("keeps several cards for one signature and returns them from every repo (D-072)", () => {
		const store = openMemoryStore(":memory:");
		store.add(card("repo-a", "sig-1"));
		store.add({ ...card("repo-a", "sig-1"), detail: ["e0502", "queue"] });
		store.add(card("repo-b", "sig-1"));
		store.add(card("repo-b", "sig-2"));
		expect(store.bySignature("sig-1").map((c) => [c.scope, c.detail[1]])).toEqual([
			["repo-a", "items"],
			["repo-a", "queue"],
			["repo-b", "items"],
		]);
		store.close();
	});

	it("searches triggers by keyword overlap within the repo", () => {
		const store = openMemoryStore(":memory:");
		store.add(card("repo-a", "sig-1"));
		store.add(card("repo-a", "sig-2", "undefined reference to `ring_push'"));
		store.add(card("repo-b", "sig-3"));
		const hits = store.search("repo-a", "error[E0502]: cannot borrow `self.stack` as mutable", 5);
		expect(hits[0]?.card.signature).toBe("sig-1");
		expect(hits[0]?.overlap).toBeGreaterThan(0.6);
		expect(hits.every((h) => h.card.scope === "repo-a")).toBe(true);
		expect(store.search("repo-a", "12 34", 5)).toEqual([]);
		store.close();
	});

	it("tracks utility, retires unhelpful cards and supersedes without deleting", () => {
		let now = 1_000;
		const store = openMemoryStore(":memory:", () => now);
		const id = store.add(card("repo-a", "sig-1"));
		for (let i = 0; i < 3; i++) store.markInjected(id);
		store.credit(id, "hurt");
		store.credit(id, "hurt");
		store.credit(id, "helped");
		expect(store.retireUnhelpful()).toBe(0);
		store.credit(id, "hurt");
		now = 2_000;
		expect(store.retireUnhelpful()).toBe(1);
		expect(store.bySignature("sig-1")).toEqual([]);
		expect(store.cards("repo-a")[0]).toMatchObject({ injected: 3, helped: 1, hurt: 3, validTo: 2_000 });

		const other = store.add(card("repo-a", "sig-2"));
		const replacement = store.supersede(other, { ...card("repo-a", "sig-2"), lesson: "better" });
		expect(store.bySignature("sig-2").map((c) => [c.id, c.lesson])).toEqual([[replacement, "better"]]);
		expect(store.cards().length).toBe(3);
		store.close();
	});
});

describe("keywords", () => {
	it("keeps distinctive identifiers and codes, drops numbers and filler", () => {
		expect(keywords("src/lib.rs:42:9: error[E0502]: cannot borrow `self.items` as mutable")).toEqual([
			"src",
			"lib",
			"e0502",
			"cannot",
			"borrow",
			"self",
			"items",
			"mutable",
		]);
	});
});

describe("vector store (D-062)", () => {
	it("keeps one vector per card or preference and embedding model", () => {
		const store = openMemoryStore(":memory:");
		store.setVector("card", 1, "model-a", Float32Array.from([1, 0]));
		store.setVector("card", 1, "model-a", Float32Array.from([0, 1]));
		store.setVector("card", 1, "model-b", Float32Array.from([1, 0, 0]));
		store.setVector("preference", 1, "model-a", Float32Array.from([0.5, 0.5]));
		expect([...store.vectors("card", "model-a")].map(([id, v]) => [id, Array.from(v)])).toEqual([[1, [0, 1]]]);
		expect(store.vectors("card", "model-b").get(1)).toHaveLength(3);
		expect(store.vectors("preference", "model-b").size).toBe(0);
		store.close();
	});
});

describe("preference store (D-060)", () => {
	it("keeps every sighting, retires without deleting and counts injections", () => {
		let clock = 100;
		const store = openMemoryStore(":memory:", () => clock++);
		const id = store.addPreference("Keep commits small.");
		store.addSighting(id, {
			scope: "repo-a",
			session: "s1",
			standing: true,
			correction: false,
			quote: "always keep commits small",
		});
		store.addSighting(id, {
			scope: "repo-b",
			session: "s2",
			standing: false,
			correction: true,
			quote: "small commits please",
		});
		store.markPreferencesInjected([id, id]);
		expect(store.preferences()).toEqual([
			{
				id,
				rule: "Keep commits small.",
				taskKind: "any",
				injected: 2,
				repeated: 0,
				createdAt: 100,
				sightings: [
					{
						scope: "repo-a",
						session: "s1",
						standing: true,
						correction: false,
						quote: "always keep commits small",
						source: "message",
						seenAt: 101,
					},
					{
						scope: "repo-b",
						session: "s2",
						standing: false,
						correction: true,
						quote: "small commits please",
						source: "message",
						seenAt: 102,
					},
				],
			},
		]);
		expect(store.retirePreference(id)).toBe(true);
		expect(store.retirePreference(id)).toBe(false);
		expect(store.preferences()).toEqual([]);
		store.close();
	});

	it("records where a sighting came from, a typed message unless told otherwise (D-066)", () => {
		const store = openMemoryStore(":memory:");
		const id = store.addPreference("Do not commit.");
		const said = { scope: "repo-a", session: "s1", standing: true, correction: false, quote: "q" };
		store.addSighting(id, said);
		store.addSighting(id, { ...said, source: "interview" });
		expect(store.preferences()[0]?.sightings.map((s) => s.source)).toEqual(["message", "interview"]);
		store.close();
	});

	it("keeps the kind of task an expectation is about until it is widened, and counts repeats (D-064)", () => {
		const store = openMemoryStore(":memory:");
		const id = store.addPreference("Add a regression test.", "fix");
		expect(store.preferences()[0]).toMatchObject({ taskKind: "fix", repeated: 0 });
		store.widenPreference(id);
		store.markPreferenceRepeated(id);
		expect(store.preferences()[0]).toMatchObject({ taskKind: "any", repeated: 1 });
		store.close();
	});
});

describe("keyword recall (M5)", () => {
	const settings = { maxCards: 2, minOverlap: 0.6, minDetail: 0.6 };
	const lock = "timeout waiting for the lock on the build directory";

	it("does not recall a card for one shared word, or for an error line that says too little", () => {
		const store = openMemoryStore(":memory:");
		store.add(card("repo-a", "sig-lock", lock));
		expect(recall(store, "repo-a", "sig-other", "error: timeout", settings)).toEqual([]);
		expect(recall(store, "repo-a", "sig-other", "error: timeout waiting", settings)).toEqual([]);
		expect(store.search("repo-a", "error: cannot open file `data.bin`", 5)).toEqual([]);
		// Most of both lines: a similar error.
		expect(
			recall(store, "repo-a", "sig-other", "error: timeout waiting for a lock on the build directory", settings).map(
				(r) => r.match,
			),
		).toEqual(["similar"]);
		store.close();
	});

	it("measures the overlap both ways: a short error inside a long trigger is not most of it", () => {
		const store = openMemoryStore(":memory:");
		store.add(
			card(
				"repo-a",
				"sig-long",
				"linker failed: undefined symbol ring_push referenced from queue_drain in libring archive member",
			),
		);
		const [hit] = store.search("repo-a", "undefined symbol ring_push", 5);
		expect(hit?.overlap).toBeLessThan(0.6);
		store.close();
	});

	it("rescores every candidate before cutting to the limit", () => {
		const store = openMemoryStore(":memory:");
		const terms = ["alpha_one", "beta_two", "gamma_three", "delta_four"];
		// Each of the target's words is common; the decoys share one rare word with the error, many times.
		for (let i = 0; i < 10; i++) {
			for (let a = 0; a < terms.length; a++) {
				for (let b = a + 1; b < terms.length; b++)
					store.add(card("repo-a", `pair-${i}-${a}-${b}`, `${terms[a]} ${terms[b]}`));
			}
		}
		for (let i = 0; i < 20; i++) store.add(card("repo-a", `decoy-${i}`, "rareword rareword rareword"));
		store.add(card("repo-a", "target", `${terms.join(" ")} common`));
		const hits = store.search("repo-a", `${terms.join(" ")} rareword`, 4);
		expect(hits[0]?.card.signature).toBe("target");
		expect(hits).toHaveLength(1);
		store.close();
	});
});

describe("store safety (M10, M8)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "exo-store-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("creates the schema once when two processes open a new store at the same moment", () => {
		const path = join(dir, "race.db");
		const ours = openDatabase(path);
		let raced = false;
		/** Another process that creates the schema in the same file right after we read its version. */
		const other = () => {
			const db = openDatabase(path, { busyTimeoutMs: 1 });
			try {
				ensureSchema(db);
			} catch (error) {
				if (!/locked|busy/i.test(String(error))) throw error;
			} finally {
				db.close();
			}
		};
		const racing = new Proxy(ours, {
			get(target, property) {
				const value = Reflect.get(target, property) as unknown;
				if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
				return (sql: string) => {
					const statement = target.prepare(sql);
					if (!/user_version/.test(sql) || raced) return statement;
					return {
						get: () => {
							const row = statement.get();
							raced = true;
							other();
							return row;
						},
					};
				};
			},
		});
		expect(() => ensureSchema(racing)).not.toThrow();
		expect(raced).toBe(true);
		ours.close();
		const store = openMemoryStore(path);
		expect(store.add(card("repo-a", "sig-1"))).toBe(1);
		store.close();
	});

	it("adds a card and its search row together or not at all", () => {
		const path = join(dir, "atomic.db");
		const store = openMemoryStore(path);
		const raw = openDatabase(path);
		raw.exec("DROP TABLE cards_fts");
		raw.close();
		expect(() => store.add(card("repo-a", "sig-1"))).toThrow();
		expect(() => store.supersede(1, card("repo-a", "sig-1"))).toThrow();
		expect(store.cards()).toEqual([]);
		store.close();
	});

	it("sets a corrupt file aside and starts fresh, and does the same for another schema version (D-088)", () => {
		const path = join(dir, "sub", "memory.db");
		openMemoryStore(path).close();
		writeFileSync(path, "this is not a database, it only has the name of one\n".repeat(40));
		const reports: string[] = [];
		const store = openMemoryStore(path, Date.now, (message) => reports.push(message));
		expect(store.cards()).toEqual([]);
		expect(store.add(card("repo-a", "sig-1"))).toBe(1);
		store.close();
		expect(readdirSync(join(dir, "sub")).filter((name) => name.includes(".corrupt-"))).toHaveLength(1);
		expect(reports).toEqual([expect.stringMatching(/not a database.*set aside as .*memory\.db\.corrupt-/)]);

		const raw = openDatabase(path);
		raw.exec("PRAGMA user_version = 999");
		raw.close();
		const again = openMemoryStore(path, Date.now, (message) => reports.push(message));
		// The card written above went with the old file, which is kept beside the new one.
		expect(again.cards()).toEqual([]);
		again.close();
		expect(readdirSync(join(dir, "sub")).filter((name) => name.includes(".other-schema-"))).toHaveLength(1);
		expect(reports[1]).toMatch(/schema v999 is not this Exocortex's.*set aside as .*memory\.db\.other-schema-/);
	});

	it("keeps the file to its owner", () => {
		const path = join(dir, "private", "memory.db");
		openMemoryStore(path).close();
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "private")).mode & 0o777).toBe(0o700);
	});

	it("returns only one repo's live card vectors when asked for a repo", () => {
		const store = openMemoryStore(":memory:");
		const here = store.add(card("repo-a", "sig-1"));
		const gone = store.add(card("repo-a", "sig-2"));
		const there = store.add(card("repo-b", "sig-3"));
		for (const id of [here, gone, there]) store.setVector("card", id, "m", Float32Array.from([1, 0]));
		store.retire(gone);
		expect([...store.vectors("card", "m", "repo-a").keys()]).toEqual([here]);
		expect(store.vectors("card", "m").size).toBe(3);
		store.close();
	});

	it("caps a repo's live cards, retiring the least useful first", () => {
		let now = 1;
		const store = openMemoryStore(":memory:", () => now++);
		const ids = [1, 2, 3, 4].map((n) => store.add(card("repo-a", `sig-${n}`)));
		store.add(card("repo-b", "sig-b"));
		store.credit(ids[0] ?? 0, "helped");
		store.credit(ids[2] ?? 0, "hurt");
		expect(store.trim("repo-a", 2)).toBe(2);
		// The one that hurt goes first, then the oldest that proved nothing.
		expect(
			store
				.cards("repo-a")
				.filter((c) => c.validTo === null)
				.map((c) => c.id),
		).toEqual([ids[0], ids[3]]);
		expect(store.trim("repo-a", 2)).toBe(0);
		expect(store.cards("repo-b")[0]?.validTo).toBeNull();
		store.close();
	});

	it("retires a card and finds one by id", () => {
		const store = openMemoryStore(":memory:");
		const id = store.add({ ...card("repo-a", "sig-1"), distilled: true });
		expect(store.card(id)).toMatchObject({ id, distilled: true, validTo: null });
		expect(store.card(99)).toBeUndefined();
		expect(store.retire(id)).toBe(true);
		expect(store.retire(id)).toBe(false);
		expect(store.card(id)?.validTo).not.toBeNull();
		store.close();
	});
});

describe("retired preferences (M6)", () => {
	it("remembers who retired a preference and restores it", () => {
		let now = 10;
		const store = openMemoryStore(":memory:", () => now++);
		const a = store.addPreference("Use tabs.");
		const b = store.addPreference("Keep commits small.", "fix");
		expect(store.retirePreference(a, "model")).toBe(true);
		expect(store.retirePreference(b)).toBe(true);
		expect(store.retiredPreferences(5)).toEqual([
			{ id: b, rule: "Keep commits small.", taskKind: "fix", retiredAt: 13, retiredBy: "user" },
			{ id: a, rule: "Use tabs.", taskKind: "any", retiredAt: 12, retiredBy: "model" },
		]);
		expect(store.restorePreference(a)).toBe(true);
		expect(store.restorePreference(a)).toBe(false);
		expect(store.preferences().map((p) => p.id)).toEqual([a]);
		expect(store.retiredPreferences(5).map((p) => p.id)).toEqual([b]);
		store.close();
	});
});
