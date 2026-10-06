import "./home-guard.ts";
import { describe, expect, it } from "vitest";
import { admitPreference, alreadySaid, sameRule } from "../src/preferences.ts";
import { openMemoryStore, type StoredPreference } from "../src/store.ts";
import { SETTLED, setup, signal, until, workspace } from "./helpers.ts";

const space = workspace();
const preference = (id: number, rule: string): StoredPreference => ({
	id,
	rule,
	taskKind: "any",
	injected: 0,
	repeated: 0,
	createdAt: 0,
	sightings: [],
});
const proposal = (extra: Record<string, unknown>) => ({
	rule: "",
	quote: "",
	standing: false,
	applies_to: "any" as const,
	correction: false,
	same_as: 0,
	replaces: 0,
	...extra,
});
const TABS = preference(1, "Indent with tabs, not spaces.");
const TDD = preference(2, "Write the failing test before the implementation.");

describe("the sidecar cannot retire a preference the user did not speak about (M6)", () => {
	const known = [TABS, TDD];

	it("retires only when the user's words or the new rule are about the preference", () => {
		const message = "Keep the commit messages short. Actually, use spaces for indenting from now on.";
		// The sidecar points at the wrong preference.
		expect(
			admitPreference(proposal({ quote: "Keep the commit messages short", replaces: 2 }), message, known, known, "/x"),
		).toEqual({});
		expect(
			admitPreference(
				proposal({ rule: "Keep commit messages short.", quote: "Keep the commit messages short", replaces: 2 }),
				message,
				known,
				known,
				"/x",
			),
		).toMatchObject({ stated: { rule: "Keep commit messages short." } });
		expect(
			admitPreference(
				proposal({ rule: "Keep commit messages short.", quote: "Keep the commit messages short", replaces: 2 }),
				message,
				known,
				known,
				"/x",
			).retire,
		).toBeUndefined();
		// The user did speak about it.
		expect(
			admitPreference(
				proposal({ rule: "Indent with spaces.", quote: "use spaces for indenting from now on", replaces: 1 }),
				message,
				known,
				known,
				"/x",
			),
		).toMatchObject({ retire: 1, stated: { existing: undefined, rule: "Indent with spaces." } });
		// The embedding model found it nearest in meaning: that counts as being about it.
		expect(
			admitPreference(
				proposal({ quote: "Keep the commit messages short", replaces: 2 }),
				message,
				known,
				known,
				"/x",
				TDD,
			),
		).toEqual({ retire: 2 });
	});

	it("tells the user at the next settle, lists what was retired and restores it on command", async () => {
		const store = openMemoryStore(space.dbPath());
		const id = store.addPreference(TABS.rule);
		store.addSighting(id, {
			scope: "x",
			session: "s",
			standing: true,
			correction: false,
			quote: "q",
			source: "interview",
		});
		const text = "Actually, use spaces for indenting from now on.";
		const s = setup(
			space,
			{ preferences: true },
			{ reply: () => ({ preferences: [proposal({ quote: "use spaces for indenting from now on", replaces: 1 })] }) },
		);
		s.memory.onUserTurn?.({ text, origin: "user" });
		expect(await s.memory.onSettle?.(SETTLED, signal)).toBeUndefined();
		await until(() => s.actions().includes("preference_retired"));
		expect(s.t.records.at(-1)?.data).toEqual({ action: "preference_retired", preference: id, by: "model" });

		const notice = await s.memory.onSettle?.(SETTLED, signal);
		expect(notice).toEqual({
			kind: "notify",
			level: "warning",
			summary: `memory retired a preference after your last message: "${TABS.rule}". /exo memory restore ${id} brings it back`,
		});
		// Said once.
		expect(await s.memory.onSettle?.(SETTLED, signal)).toBeUndefined();

		expect(s.memory.command?.("preferences")).toBe(
			`No live preferences.\nRetired lately (/exo memory restore <id> brings one back):\n${id}. ${TABS.rule} (retired by the model)`,
		);
		expect(s.memory.command?.("restore x")).toBe("Usage: /exo memory restore <id>");
		expect(s.memory.command?.("restore 99")).toBe("No retired preference 99.");
		expect(s.memory.command?.(`restore ${id}`)).toBe(`Restored preference ${id}.`);
		expect(s.t.records.at(-1)?.data).toEqual({ action: "preference_restored", preference: id });
		expect(s.memory.command?.("preferences")).toContain(`${id}. ${TABS.rule} (`);
		// The user's own "forget" is listed as theirs.
		expect(s.memory.command?.(`forget ${id}`)).toContain("Forgot");
		expect(s.memory.command?.("preferences")).toContain("(retired by you)");
	});
});

describe("a rule and its opposite are two rules (M7)", () => {
	const semicolons = preference(1, "Use semicolons in TypeScript code.");

	it("does not take a negated rule for the rule", () => {
		expect(sameRule("Do not use semicolons in TypeScript code.", [semicolons])).toBeUndefined();
		expect(sameRule("Never use semicolons in TypeScript code.", [semicolons])).toBeUndefined();
		expect(sameRule("Use semicolons in all TypeScript code.", [semicolons])?.id).toBe(1);
		const never = preference(2, "Never add comments to the code.");
		expect(sameRule("Don't add comments to code.", [never])?.id).toBe(2);
	});

	it("does not take a prompt that says the opposite as stating the rule", () => {
		expect(
			alreadySaid("Fix the parser, and don't add comments to the code this time", "Add comments to the code."),
		).toBe(false);
		expect(alreadySaid("Fix the parser and add comments to the code", "Add comments to the code.")).toBe(true);
		// A negation elsewhere in the prompt is not about the rule.
		expect(
			alreadySaid("Don't touch the README. Add comments to the code you change.", "Add comments to the code."),
		).toBe(true);
		expect(alreadySaid("Do not add any comments to the code", "Never add comments to the code.")).toBe(true);
	});

	it("does not merge opposites on the sidecar's or the embedding model's word", () => {
		const message = "From now on do not use semicolons in TypeScript code.";
		const said = proposal({
			rule: "Do not use semicolons in TypeScript code.",
			quote: "do not use semicolons in TypeScript code",
		});
		for (const admitted of [
			admitPreference({ ...said, same_as: 1 }, message, [semicolons], [semicolons], "/x"),
			admitPreference(said, message, [semicolons], [semicolons], "/x", semicolons),
		]) {
			expect(admitted.stated).toMatchObject({ existing: undefined, rule: "Do not use semicolons in TypeScript code." });
		}
	});

	it("recognises a rule among all live preferences, not only the latest thirty", async () => {
		const store = openMemoryStore(space.dbPath());
		const first = store.addPreference(TDD.rule);
		for (let i = 0; i < 31; i++) store.addPreference(`Name migration files with prefix number ${i}00${i}.`);
		const s = setup(
			space,
			{ preferences: true },
			{ reply: () => ({ preferences: [proposal({ rule: TDD.rule, quote: "write the failing test first" })] }) },
		);
		s.memory.onUserTurn?.({ text: "From now on write the failing test first.", origin: "user" });
		await s.memory.onSettle?.(SETTLED, signal);
		await until(() => s.t.records.length > 0);
		expect(s.t.records[0]?.data).toMatchObject({ action: "preference_seen", preference: first });
		expect(store.preferences()).toHaveLength(32);
	});
});
