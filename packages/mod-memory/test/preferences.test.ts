import "./home-guard.ts";
import { describe, expect, it } from "vitest";
import {
	activePreferences,
	admitRelation,
	admitStatement,
	alreadySaid,
	nearestPreferences,
	renderPreferences,
	saidVerbatim,
	withKind,
} from "../src/preferences.ts";
import type { Sighting, StoredPreference } from "../src/store.ts";

const sighting = (scope: string, session: string, standing = false, seenAt = 1): Sighting => ({
	scope,
	session,
	standing,
	correction: false,
	quote: "q",
	source: "message",
	seenAt,
});
const preference = (id: number, rule: string, sightings: Sighting[]): StoredPreference => ({
	id,
	rule,
	taskKind: "any",
	injected: 0,
	repeated: 0,
	createdAt: 0,
	sightings,
});

describe("saidVerbatim", () => {
	it("finds a quote word for word, ignoring case and line breaks", () => {
		const message = "Fix the parser.  From now on, run\nthe linter before you commit! Thanks.";
		expect(saidVerbatim(message, "run the LINTER before you commit")).toBe(true);
		expect(saidVerbatim(message, "run the formatter")).toBe(false);
		// Too short to show that anything was said.
		expect(saidVerbatim(message, "Fix")).toBe(false);
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

describe("activePreferences and the interview (D-066)", () => {
	it("applies an interview answer in every repo, from the first session", () => {
		const answered = preference(1, "Do not commit.", [{ ...sighting("repo-a", "s1", true), source: "interview" }]);
		const said = preference(2, "Keep commits small.", [sighting("repo-a", "s1", true)]);
		expect(activePreferences([answered, said], "repo-b", 2).map((p) => p.id)).toEqual([1]);
		expect(activePreferences([answered, said], "repo-a", 2).map((p) => p.id)).toEqual([1, 2]);
	});
});

describe("alreadySaid and renderPreferences", () => {
	it("treats a prompt carrying most of a rule's words as stating it", () => {
		expect(alreadySaid("please make the commit message short", "Keep commits small.")).toBe(false);
		expect(alreadySaid("keep the commits small and focused", "Keep commits small.")).toBe(true);
		expect(alreadySaid("anything", "a b")).toBe(true);
	});

	it("stops at the character budget and renders nothing when no rule fits", () => {
		const many = [1, 2, 3].map((id) => ({
			id,
			rule: `Rule number ${id}.`,
			taskKind: "any" as const,
			sessions: id,
			lastSeenAt: 0,
		}));
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

	it("says which kind of task an expectation is for (D-064)", () => {
		const regression = { id: 1, rule: "Add a regression test.", taskKind: "fix" as const, sessions: 1, lastSeenAt: 0 };
		expect(withKind(regression)).toBe("For bug fixes: Add a regression test.");
		expect(withKind({ ...regression, taskKind: "any" })).toBe("Add a regression test.");
		expect(renderPreferences([regression], 10_000)).toContain("\n- For bug fixes: Add a regression test.");
	});
});

describe("admitStatement", () => {
	const message = "Run the linter before you commit. No, don't refactor the code around it when you fix a bug.";
	const proposal = {
		rule: "Run the linter before committing.",
		quote: "Run the  linter before you commit",
		holds: "task" as const,
		applies_to: "any" as const,
		correction: false,
	};

	it("admits what the user said, with the sidecar's reading of how long it holds", () => {
		expect(admitStatement(proposal, message, "/nowhere")).toEqual({
			statement: {
				rule: "Run the linter before committing.",
				quote: "Run the linter before you commit",
				standing: false,
				kind: "any",
				correction: false,
			},
		});
		expect(admitStatement({ ...proposal, holds: "standing" }, message, "/nowhere")).toMatchObject({
			statement: { standing: true },
		});
	});

	it("carries the kind of task and whether it was a correction (D-064)", () => {
		const corrected = {
			...proposal,
			rule: "Do not refactor nearby code.",
			quote: "don't refactor the code around it when you fix a bug",
			applies_to: "fix" as const,
			correction: true,
		};
		expect(admitStatement(corrected, message, "/nowhere")).toMatchObject({
			statement: { kind: "fix", correction: true, standing: false },
		});
	});

	it("refuses what the message does not bear out, and says why", () => {
		const refused = (extra: object) => admitStatement({ ...proposal, ...extra }, message, "/nowhere");
		expect(refused({ quote: "always run the formatter" })).toEqual({ refused: "not_said" });
		expect(refused({ holds: "exception" })).toEqual({ refused: "exception" });
		expect(refused({ rule: "Lint." })).toEqual({ refused: "rule_length" });
		expect(refused({ rule: "x".repeat(201) })).toEqual({ refused: "rule_length" });
		expect(refused({ rule: "Run the linter and update `docs/STYLE.md`." })).toEqual({ refused: "ungrounded" });
		// An invented quote is refused whatever else the proposal says.
		expect(refused({ quote: "always run the formatter", holds: "exception" })).toEqual({ refused: "not_said" });
	});
});

describe("admitRelation", () => {
	const shown = [preference(4, "Indent with tabs.", []), preference(9, "Keep commits small.", [])];

	it("reads the sidecar's numbers as the preferences it was shown", () => {
		expect(admitRelation({ same: 0, contradicts: [] }, shown)).toEqual({ same: undefined, contradicts: [] });
		expect(admitRelation({ same: 2, contradicts: [1] }, shown)).toEqual({ same: shown[1], contradicts: [shown[0]] });
		expect(admitRelation({ same: 0, contradicts: [1, 1, 2] }, shown).contradicts).toEqual(shown);
	});

	it("ignores a number that points at nothing it was shown", () => {
		expect(admitRelation({ same: 3, contradicts: [7, 2] }, shown)).toEqual({
			same: undefined,
			contradicts: [shown[1]],
		});
		expect(admitRelation({ same: 1, contradicts: [] }, [])).toEqual({ same: undefined, contradicts: [] });
	});

	it("takes a preference named both the same and contradicted as neither (M7)", () => {
		expect(admitRelation({ same: 1, contradicts: [1, 2] }, shown)).toEqual({
			same: undefined,
			contradicts: [shown[1]],
		});
	});
});

describe("nearestPreferences", () => {
	const live = [
		preference(1, "Write the failing test before the implementation.", []),
		preference(2, "Keep each commit to one change.", []),
		preference(3, "Indent with tabs.", []),
		preference(4, "Answer questions briefly.", []),
	];
	const ids = (found: readonly StoredPreference[]) => found.map((p) => p.id);

	it("is every preference while they fit", () => {
		expect(ids(nearestPreferences("Anything at all.", live, 4))).toEqual([1, 2, 3, 4]);
	});

	it("is the ones sharing most keywords with the rule otherwise, the later ones on a tie, oldest first", () => {
		expect(ids(nearestPreferences("Write a failing test first.", live, 2))).toEqual([1, 4]);
		expect(ids(nearestPreferences("Nothing in common.", live, 2))).toEqual([3, 4]);
	});

	it("goes by an embedding model's similarity when there is one", () => {
		const similarity = (p: StoredPreference) => (p.id === 2 ? 0.9 : p.id === 3 ? 0.4 : 0.1);
		expect(ids(nearestPreferences("Write a failing test first.", live, 2, similarity))).toEqual([2, 3]);
	});
});
