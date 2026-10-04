import { describe, expect, it } from "vitest";
import { keywords, openMemoryStore } from "../src/store.ts";

const card = (scope: string, signature: string, trigger = "error[E0502]: cannot borrow `self.items` as mutable") => ({
	scope,
	signature,
	trigger,
	lesson: `lesson for ${signature} in ${scope}`,
	evidence: "{}",
});

describe("memory store", () => {
	it("adds cards and merges repeats of the same scope and signature", () => {
		const store = openMemoryStore(":memory:");
		const first = store.upsert(card("repo-a", "sig-1"));
		const again = store.upsert({ ...card("repo-a", "sig-1"), evidence: '{"second":true}' });
		expect(first.merged).toBe(false);
		expect(again).toEqual({ id: first.id, merged: true });
		const [stored] = store.cards("repo-a");
		expect(stored).toMatchObject({ seen: 2, lesson: "lesson for sig-1 in repo-a", validTo: null });
		expect(stored?.evidence).toContain('{"second":true}');
		store.close();
	});

	it("finds cards by signature in this repo, else only when 2+ other repos share it", () => {
		const store = openMemoryStore(":memory:");
		store.upsert(card("repo-a", "sig-1"));
		expect(store.bySignature("repo-a", "sig-1")).toHaveLength(1);
		expect(store.bySignature("repo-z", "sig-1")).toEqual([]);
		store.upsert(card("repo-b", "sig-1"));
		expect(
			store
				.bySignature("repo-z", "sig-1")
				.map((c) => c.scope)
				.sort(),
		).toEqual(["repo-a", "repo-b"]);
		expect(store.bySignature("repo-a", "sig-1").map((c) => c.scope)).toEqual(["repo-a"]);
		store.close();
	});

	it("searches triggers by keyword overlap within the repo", () => {
		const store = openMemoryStore(":memory:");
		store.upsert(card("repo-a", "sig-1"));
		store.upsert(card("repo-a", "sig-2", "undefined reference to `ring_push'"));
		store.upsert(card("repo-b", "sig-3"));
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
		const { id } = store.upsert(card("repo-a", "sig-1"));
		for (let i = 0; i < 3; i++) store.markInjected(id);
		store.credit(id, "hurt");
		store.credit(id, "hurt");
		store.credit(id, "helped");
		expect(store.retireUnhelpful()).toBe(0);
		store.credit(id, "hurt");
		now = 2_000;
		expect(store.retireUnhelpful()).toBe(1);
		expect(store.bySignature("repo-a", "sig-1")).toEqual([]);
		expect(store.cards("repo-a")[0]).toMatchObject({ injected: 3, helped: 1, hurt: 3, validTo: 2_000 });

		const { id: other } = store.upsert(card("repo-a", "sig-2"));
		const replacement = store.supersede(other, { ...card("repo-a", "sig-2"), lesson: "better" });
		expect(store.bySignature("repo-a", "sig-2").map((c) => [c.id, c.lesson])).toEqual([[replacement, "better"]]);
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
