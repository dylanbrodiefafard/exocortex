import "./home-guard.ts";
import { describe, expect, it } from "vitest";
import { admitRelation, alreadySaid } from "../src/preferences.ts";
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
const statement = (extra: Record<string, unknown>) => ({
	rule: "",
	quote: "",
	holds: "standing" as const,
	applies_to: "any" as const,
	correction: false,
	...extra,
});
const isRelate = (prompt: string) => prompt.includes("They have just stated one.");
const TABS = "Indent with tabs, not spaces.";
const TDD = "Write the failing test before the implementation.";
const SPACES = "Indent with spaces.";

describe("a preference retired on a sidecar's reading can be seen and undone (M6)", () => {
	it("tells the user at the next settle, lists what was retired and restores it on command", async () => {
		const store = openMemoryStore(space.dbPath());
		const id = store.addPreference(TABS);
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
			{
				reply: (prompt) =>
					isRelate(prompt)
						? { same: 0, contradicts: [1] }
						: { preferences: [statement({ rule: SPACES, quote: "use spaces for indenting from now on" })] },
			},
		);
		s.memory.onUserTurn?.({ text, origin: "user" });
		expect(await s.memory.onSettle?.(SETTLED, signal)).toBeUndefined();
		await until(() => s.actions().includes("preference_retired"));
		expect(s.t.records.at(-1)?.data).toEqual({ action: "preference_retired", preference: id, by: "model" });

		const notice = await s.memory.onSettle?.(SETTLED, signal);
		expect(notice).toEqual({
			kind: "notify",
			level: "warning",
			summary: `memory retired a preference after your last message: "${TABS}". /exo memory restore ${id} brings it back`,
		});
		// Said once.
		expect(await s.memory.onSettle?.(SETTLED, signal)).toBeUndefined();

		const retired = `Retired lately (/exo memory restore <id> brings one back):\n${id}. ${TABS} (retired by the model)`;
		expect(s.memory.command?.("preferences")).toBe(
			`2. ${SPACES} (said in 1 session; applies here; added 0×)\n${retired}`,
		);
		expect(s.memory.command?.("restore x")).toBe("Usage: /exo memory restore <id>");
		expect(s.memory.command?.("restore 99")).toBe("No retired preference 99.");
		expect(s.memory.command?.(`restore ${id}`)).toBe(`Restored preference ${id}.`);
		expect(s.t.records.at(-1)?.data).toEqual({ action: "preference_restored", preference: id });
		expect(s.memory.command?.("preferences")).toContain(`${id}. ${TABS} (`);
		// The user's own "forget" is listed as theirs.
		expect(s.memory.command?.(`forget ${id}`)).toContain("Forgot");
		expect(s.memory.command?.("preferences")).toContain("(retired by you)");
	});

	it("retires nothing the relation sidecar was not shown", async () => {
		const store = openMemoryStore(space.dbPath());
		store.addPreference(TABS);
		const s = setup(
			space,
			{ preferences: true },
			{
				reply: (prompt) =>
					isRelate(prompt)
						? { same: 0, contradicts: [2, 7] }
						: { preferences: [statement({ rule: SPACES, quote: "use spaces for indenting" })] },
			},
		);
		s.memory.onUserTurn?.({ text: "From now on use spaces for indenting.", origin: "user" });
		await s.memory.onSettle?.(SETTLED, signal);
		await until(() => s.t.records.length > 0);
		expect(s.actions()).toEqual(["preference_learned"]);
		expect(store.preferences().map((p) => p.rule)).toEqual([TABS, SPACES]);
	});
});

describe("a rule and its opposite are two rules (M7)", () => {
	const semicolons = preference(1, "Use semicolons in TypeScript code.");

	it("does not merge opposites when the sidecar's answer calls one preference both", () => {
		expect(admitRelation({ same: 1, contradicts: [1] }, [semicolons])).toEqual({ same: undefined, contradicts: [] });
	});

	it("leaves a rule out of a prompt that speaks about it, whichever way the prompt puts it", () => {
		// Said the other way, the request wins; said the same way, the rule would only repeat it.
		expect(
			alreadySaid("Fix the parser, and don't add comments to the code this time", "Add comments to the code."),
		).toBe(true);
		expect(alreadySaid("Fix the parser and add comments to the code", "Add comments to the code.")).toBe(true);
		expect(alreadySaid("Do not add any comments to the code", "Never add comments to the code.")).toBe(true);
		expect(alreadySaid("Fix the parser and update the README", "Add comments to the code.")).toBe(false);
	});

	it("finds the preference a rule restates among all live ones, not only the latest thirty", async () => {
		const store = openMemoryStore(space.dbPath());
		const first = store.addPreference(TDD);
		for (let i = 0; i < 31; i++) store.addPreference(`Name migration files with prefix number ${i}00${i}.`);
		const s = setup(
			space,
			{ preferences: true },
			{
				reply: (prompt) =>
					isRelate(prompt)
						? { same: Number(/(\d+)\. Write the failing test/.exec(prompt)?.[1] ?? 0), contradicts: [] }
						: {
								preferences: [
									statement({ rule: "Write a failing test first.", quote: "write the failing test first" }),
								],
							},
			},
		);
		s.memory.onUserTurn?.({ text: "From now on write the failing test first.", origin: "user" });
		await s.memory.onSettle?.(SETTLED, signal);
		await until(() => s.t.records.length > 0);
		expect(s.t.records[0]?.data).toMatchObject({ action: "preference_seen", preference: first });
		expect(store.preferences()).toHaveLength(32);
	});
});
