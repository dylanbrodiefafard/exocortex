import "./home-guard.ts";
import { openDatabase, type UserTurnContext } from "@exocortex/core";
import { describe, expect, it } from "vitest";
import { openMemoryStore } from "../src/store.ts";
import { edit, fail, idle, pass, SETTLED, setup, signal, until, workspace } from "./helpers.ts";

const space = workspace();
const TDD = "Write the failing test before the implementation.";
const said = "Write the tests first for the parser, then implement it.";
const proposal = {
	preferences: [
		{
			rule: TDD,
			quote: "Write the tests first",
			holds: "task",
			applies_to: "any",
			correction: false,
		},
	],
};
const taken = async (context: Promise<UserTurnContext | undefined> | undefined) => {
	const added = await context;
	added?.commit?.();
	return added?.text;
};
const ask = (s: ReturnType<typeof setup>, text = "Add a function that parses durations") =>
	taken(s.memory.contextForUserTurn?.({ text, origin: "user" }, signal));

async function learnCard() {
	const s = setup(space, { distill: false });
	for (const tool of [fail(), edit, pass()]) s.memory.onToolResult?.(tool);
	await until(() => s.t.records.length > 0);
}

describe("one harness session is one session, however often the module is rebuilt (M9)", () => {
	it("does not count a rebuilt module as a second session of evidence", async () => {
		const relation = { same: 1, contradicts: [] };
		const reply = (prompt: string) => (prompt.includes("They have just stated one.") ? relation : proposal);
		const options = { reply, sessionId: "pi-session-1" };
		for (let i = 0; i < 2; i++) {
			const s = setup(space, { preferences: true }, options);
			s.memory.onUserTurn?.({ text: said, origin: "user" });
			await s.memory.onSettle?.(SETTLED, signal);
			await until(() => s.t.records.length > 0);
		}
		const sightings = openMemoryStore(space.dbPath()).preferences()[0]?.sightings ?? [];
		expect(sightings.map((x) => x.session)).toEqual(["pi-session-1", "pi-session-1"]);
		// Said twice in one session: not yet established.
		expect(await ask(setup(space, { preferences: true }))).toBeUndefined();
	});

	it("remembers across a rebuild which preferences are already in the conversation", async () => {
		const store = openMemoryStore(space.dbPath());
		const id = store.addPreference(TDD);
		store.addSighting(id, {
			scope: "x",
			session: "s0",
			standing: true,
			correction: false,
			quote: "q",
			source: "interview",
		});
		const settings = { preferences: true, preferenceSelect: false };
		const first = setup(space, settings, { sessionId: "pi-1" });
		expect(await ask(first)).toContain(TDD);
		expect(first.t.states.at(-1)).toMatchObject({ preferences: [id] });

		const rebuilt = setup(space, settings, { sessionId: "pi-1", savedState: first.t.states.at(-1) });
		expect(await ask(rebuilt)).toBeUndefined();
		rebuilt.memory.onCompacted?.();
		expect(rebuilt.t.states.at(-1)).toMatchObject({ preferences: [] });
		expect(await ask(rebuilt)).toContain(TDD);
		// State from another version of the module is not trusted.
		for (const savedState of [
			{ v: 99, preferences: [id] },
			"nonsense",
			{ v: 1, preferences: "x", cards: [{ id: "y" }] },
		]) {
			expect(await ask(setup(space, settings, { sessionId: "pi-1", savedState }))).toContain(TDD);
		}
	});

	it("keeps the cards shown in a task across a rebuild, and credits them in the next instance", async () => {
		await learnCard();
		const first = setup(space, {}, { sessionId: "pi-2" });
		expect((await first.recall(fail()))?.note).toBe("recalled 1 card(s)");
		first.memory.onToolResult?.(edit);
		await first.memory.dispose?.();
		// Nothing conclusive yet: no credit, and the card is still the task's.
		expect(first.actions()).toEqual(["recalled"]);

		const rebuilt = setup(space, {}, { sessionId: "pi-2", savedState: first.t.states.at(-1) });
		expect(await rebuilt.recall(fail())).toBeUndefined();
		rebuilt.memory.onToolResult?.(pass());
		await rebuilt.memory.onSettle?.(SETTLED, signal);
		expect(rebuilt.t.records.at(-1)?.data).toMatchObject({ action: "credited", outcome: "helped" });
		expect(openMemoryStore(space.dbPath()).cards()[0]).toMatchObject({ injected: 1, helped: 1 });
	});

	it("credits what is settled when the session ends, and does not show that card again in the task", async () => {
		await learnCard();
		const first = setup(space, {}, { sessionId: "pi-3" });
		await first.recall(fail());
		first.memory.onToolResult?.(edit);
		first.memory.onToolResult?.(pass());
		await first.memory.dispose?.();
		expect(first.t.records.at(-1)?.data).toMatchObject({ action: "credited", outcome: "helped" });

		const resumed = setup(space, {}, { sessionId: "pi-3", savedState: first.t.states.at(-1) });
		expect(await resumed.recall(fail())).toBeUndefined();
		await resumed.memory.onSettle?.(SETTLED, signal);
		expect(resumed.actions()).toEqual([]);
		// The next task starts clean.
		resumed.memory.onUserTurn?.({ text: "now the other bug", origin: "user" });
		expect((await resumed.recall(fail()))?.note).toBe("recalled 1 card(s)");
	});

	it("ends a task cleanly when the store fails while crediting (M10)", async () => {
		await learnCard();
		const s = setup(space, { preferences: true }, { reply: () => proposal });
		await s.recall(fail());
		s.memory.onToolResult?.(edit);
		s.memory.onToolResult?.(pass());
		const raw = openDatabase(space.dbPath());
		raw.exec("ALTER TABLE cards RENAME TO cards_gone");
		raw.close();
		try {
			expect(() => s.memory.onUserTurn?.({ text: said, origin: "user" })).not.toThrow();
			expect(s.t.logs.some((l) => l.includes("credit"))).toBe(true);
		} finally {
			const back = openDatabase(space.dbPath());
			back.exec("ALTER TABLE cards_gone RENAME TO cards");
			back.close();
		}
		// The message was still heard, and the task's cards were let go.
		await s.memory.onSettle?.(SETTLED, signal);
		await until(() => s.actions().includes("preference_learned"));
		await idle();
		expect(s.actions().filter((a) => a === "credited")).toEqual([]);
	});
});
