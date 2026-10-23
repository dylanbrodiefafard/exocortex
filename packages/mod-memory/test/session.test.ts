import "./home-guard.ts";
import { openDatabase, type UserTurnContext } from "@exocortex/core";
import { describe, expect, it } from "vitest";
import { openMemoryStore } from "../src/store.ts";
import { edit, fail, idle, LESSON, pass, SETTLED, setup, signal, until, workspace } from "./helpers.ts";

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
	const s = setup(space, {}, { reply: () => LESSON });
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
		const settings = { preferences: true };
		const reply = () => ({ apply: [1] });
		const first = setup(space, settings, { sessionId: "pi-1", reply });
		expect(await ask(first)).toContain(TDD);
		expect(first.t.states.at(-1)).toMatchObject({ preferences: [id] });

		const rebuilt = setup(space, settings, { sessionId: "pi-1", savedState: first.t.states.at(-1), reply });
		expect(await ask(rebuilt)).toBeUndefined();
		rebuilt.memory.onCompacted?.();
		expect(rebuilt.t.states.at(-1)).toMatchObject({ preferences: [] });
		expect(await ask(rebuilt)).toContain(TDD);
		// State from another version of the module is not trusted.
		for (const savedState of [
			{ v: 99, preferences: [id] },
			// Before D-109 card ids started again: an older state is not read.
			{ v: 1, preferences: [id] },
			"nonsense",
			{ v: 2, preferences: "x", cards: [{ id: "y" }] },
		]) {
			expect(await ask(setup(space, settings, { sessionId: "pi-1", savedState, reply }))).toContain(TDD);
		}
	});

	it("keeps the cards shown across a rebuild, and credits them in the next instance", async () => {
		await learnCard();
		const first = setup(space, {}, { sessionId: "pi-2" });
		expect((await first.recall(fail()))?.note).toBe("recalled 1 card(s)");
		first.memory.onToolResult?.(edit);
		// The host builds the next instance before it lets the old one go.
		const rebuilt = setup(space, {}, { sessionId: "pi-2", savedState: first.t.states.at(-1) });
		await first.memory.dispose?.();
		// Nothing conclusive yet: no credit.
		expect(first.actions()).toEqual(["recalled"]);

		expect(await rebuilt.recall(fail())).toBeUndefined();
		rebuilt.memory.onToolResult?.(pass());
		expect(rebuilt.t.records.at(-1)?.data).toMatchObject({ action: "credited", outcome: "helped" });
		expect(openMemoryStore(space.dbPath()).cards()[0]).toMatchObject({ injected: 1, helped: 1 });
	});

	it("credits one showing once, however many instances saw it end (D-109)", async () => {
		await learnCard();
		const first = setup(space, {}, { sessionId: "pi-4" });
		await first.recall(fail());
		first.memory.onToolResult?.(fail());
		const rebuilt = setup(space, {}, { sessionId: "pi-4", savedState: first.t.states.at(-1) });
		await first.memory.dispose?.();
		await rebuilt.memory.dispose?.();
		expect(first.t.records.at(-1)?.data).toMatchObject({ action: "credited", outcome: "hurt" });
		expect(rebuilt.actions()).toEqual([]);
		expect(openMemoryStore(space.dbPath()).cards()[0]).toMatchObject({ injected: 1, hurt: 1 });
	});

	it("does not show a credited card again in the session, until the context is compacted", async () => {
		await learnCard();
		const first = setup(space, {}, { sessionId: "pi-3" });
		await first.recall(fail());
		first.memory.onToolResult?.(edit);
		first.memory.onToolResult?.(pass());
		expect(first.t.records.at(-1)?.data).toMatchObject({ action: "credited", outcome: "helped" });
		await first.memory.dispose?.();

		const resumed = setup(space, {}, { sessionId: "pi-3", savedState: first.t.states.at(-1) });
		expect(await resumed.recall(fail())).toBeUndefined();
		resumed.memory.onUserTurn?.({ text: "now the other bug", origin: "user" });
		expect(await resumed.recall(fail())).toBeUndefined();
		resumed.memory.onCompacted?.();
		expect((await resumed.recall(fail()))?.note).toBe("recalled 1 card(s)");
	});

	it("carries on cleanly when the store fails while crediting (M10)", async () => {
		await learnCard();
		const s = setup(space, { preferences: true }, { reply: () => proposal });
		await s.recall(fail());
		s.memory.onToolResult?.(edit);
		const raw = openDatabase(space.dbPath());
		raw.exec("ALTER TABLE cards RENAME TO cards_gone");
		raw.close();
		try {
			expect(() => s.memory.onToolResult?.(pass())).not.toThrow();
			expect(s.t.logs.some((l) => l.includes("credit"))).toBe(true);
		} finally {
			const back = openDatabase(space.dbPath());
			back.exec("ALTER TABLE cards_gone RENAME TO cards");
			back.close();
		}
		// The user's message is still heard, and the card was let go.
		s.memory.onUserTurn?.({ text: said, origin: "user" });
		await s.memory.onSettle?.(SETTLED, signal);
		await until(() => s.actions().includes("preference_learned"));
		await idle();
		expect(s.actions().filter((a) => a === "credited")).toEqual([]);
	});
});
