import { describe, expect, it } from "vitest";
import { keywords, openMemoryStore } from "../src/store.ts";

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
