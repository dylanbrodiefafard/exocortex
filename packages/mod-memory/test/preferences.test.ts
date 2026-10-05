import { describe, expect, it } from "vitest";
import {
	activePreferences,
	admitPreference,
	alreadySaid,
	quotedSentence,
	renderPreferences,
} from "../src/preferences.ts";
import type { Sighting, StoredPreference } from "../src/store.ts";

const sighting = (scope: string, session: string, standing = false, seenAt = 1): Sighting => ({
	scope,
	session,
	standing,
	quote: "q",
	seenAt,
});
const preference = (id: number, rule: string, sightings: Sighting[]): StoredPreference => ({
	id,
	rule,
	injected: 0,
	createdAt: 0,
	sightings,
});

describe("quotedSentence", () => {
	it("finds the sentence around a verbatim quote, ignoring case and line breaks", () => {
		const message = "Fix the parser.  From now on, run\nthe linter before you commit! Thanks.";
		expect(quotedSentence(message, "run the LINTER before you commit")).toBe(
			"From now on, run the linter before you commit!",
		);
		expect(quotedSentence(message, "run the formatter")).toBeUndefined();
		expect(quotedSentence(message, "Fix")).toBeUndefined();
	});
});

describe("activePreferences", () => {
	it("applies standing rules here, repeated ones after enough sessions, and ones said in two repos everywhere", () => {
		const live = [
			preference(1, "once here", [sighting("a", "s1")]),
			preference(2, "standing here", [sighting("a", "s1", true, 5)]),
			preference(3, "twice here", [sighting("a", "s1"), sighting("a", "s2", false, 9)]),
			preference(4, "twice in one session", [sighting("a", "s1"), sighting("a", "s1")]),
			preference(5, "standing elsewhere", [sighting("b", "s3", true)]),
			preference(6, "two other repos", [sighting("b", "s3"), sighting("c", "s4")]),
		];
		expect(activePreferences(live, "a", 2).map((p) => p.id)).toEqual([3, 6, 2]);
		expect(activePreferences(live, "a", 1).map((p) => p.id)).toEqual([3, 6, 2, 1, 4]);
		expect(activePreferences(live, "b", 2).map((p) => p.id)).toEqual([6, 5]);
	});
});

describe("alreadySaid and renderPreferences", () => {
	it("treats a prompt carrying most of a rule's words as stating it", () => {
		expect(alreadySaid("please make the commit message short", "Keep commits small.")).toBe(false);
		expect(alreadySaid("keep the commits small and focused", "Keep commits small.")).toBe(true);
		expect(alreadySaid("anything", "a b")).toBe(true);
	});

	it("stops at the character budget and renders nothing when no rule fits", () => {
		const many = [1, 2, 3].map((id) => ({ id, rule: `Rule number ${id}.`, sessions: id, lastSeenAt: 0 }));
		const all = renderPreferences(many, 10_000).split("\n");
		expect(all.slice(1)).toEqual([
			"- Rule number 1.",
			"- Rule number 2. (said in 2 sessions)",
			"- Rule number 3. (said in 3 sessions)",
		]);
		const header = all[0]?.length ?? 0;
		expect(renderPreferences(many, header + 60).split("\n")).toHaveLength(3);
		expect(renderPreferences(many, header + 10)).toBe("");
	});
});

describe("admitPreference", () => {
	const known = [preference(1, "Write the failing test before the implementation.", [sighting("a", "s1", true)])];
	const message = "Always run the linter before you commit. And stop writing tests first.";

	it("admits a new standing rule and decides 'standing' from the user's wording", () => {
		expect(
			admitPreference(
				{
					rule: "Run the linter before committing.",
					quote: "run the linter before you commit",
					standing: false,
					same_as: 0,
					replaces: 0,
				},
				message,
				known,
				known,
				"/nowhere",
			),
		).toEqual({
			stated: {
				existing: undefined,
				rule: "Run the linter before committing.",
				standing: true,
				quote: "run the linter before you commit",
			},
		});
	});

	it("retires what the user withdraws, and replaces it when a new rule comes with it", () => {
		const withdrawal = { rule: "", quote: "stop writing tests first", standing: false, same_as: 0, replaces: 1 };
		expect(admitPreference(withdrawal, message, known, known, "/nowhere")).toEqual({ retire: 1 });
		expect(
			admitPreference({ ...withdrawal, rule: "Write tests after the code.", same_as: 1 }, message, known, known, "/x"),
		).toMatchObject({ retire: 1, stated: { existing: undefined, rule: "Write tests after the code." } });
	});

	it("ignores references to preferences that were not shown or are no longer live", () => {
		const proposal = {
			rule: "Run the linter before committing.",
			quote: "run the linter",
			standing: false,
			same_as: 9,
			replaces: 9,
		};
		expect(admitPreference(proposal, message, known, known, "/nowhere")).toMatchObject({
			stated: { existing: undefined },
		});
		expect(admitPreference({ ...proposal, same_as: 1, replaces: 0 }, message, [], known, "/x").stated?.existing).toBe(
			undefined,
		);
		expect(admitPreference({ ...proposal, same_as: 1, replaces: 0 }, message, known, known, "/x").stated).toMatchObject(
			{
				existing: 1,
				rule: known[0]?.rule,
			},
		);
	});
});
