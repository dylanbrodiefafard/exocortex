import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dialog } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTERVIEW, INTERVIEW_OPEN_QUESTION, runInterview } from "../src/interview.ts";
import { createMemory } from "../src/memory.ts";
import { openMemoryStore, TASK_KINDS } from "../src/store.ts";

let dir: string;
let dbPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-interview-"));
	dbPath = join(dir, "memory.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const NONE = "No preference";
const first = (question: number) => INTERVIEW[question]?.options[0] ?? { label: "" };

/** A user who gives `answers` in order (an option label, then the open answer) and cancels when they run out. */
function user(answers: readonly (string | undefined)[]) {
	const left = [...answers];
	const asked: { title: string; options?: readonly string[] }[] = [];
	const notices: string[] = [];
	const dialog: Dialog = {
		select: async (title, options) => {
			asked.push({ title, options });
			return left.shift();
		},
		input: async (title) => {
			asked.push({ title });
			return left.shift();
		},
		notify: (message) => notices.push(message),
	};
	return { dialog, asked, notices };
}

function setup(settings: Record<string, unknown> = { preferences: true }, reply?: () => SidecarReply) {
	const t = createTestModuleContext({ cwd: dir, ...(reply ? { reply } : {}) });
	return { t, memory: createMemory({ dbPath, ...settings }, t.context) };
}

const skipAll = (picked: Record<number, string>, more = "") => [...INTERVIEW.map((_, i) => picked[i] ?? NONE), more];

describe("interview questions (D-066)", () => {
	it("offers 'no preference' last on every question, with distinct labels and rules that fit a card", () => {
		const rules = INTERVIEW.flatMap((q) => q.options.flatMap((o) => (o.rule === undefined ? [] : [o.rule])));
		expect(new Set(rules).size).toBe(rules.length);
		for (const question of INTERVIEW) {
			const labels = question.options.map((o) => o.label);
			expect(new Set(labels).size).toBe(labels.length);
			expect(question.options.at(-1)).toEqual({ label: NONE });
			for (const option of question.options.slice(0, -1)) {
				expect(option.rule?.length).toBeGreaterThanOrEqual(8);
				expect(option.rule?.length).toBeLessThanOrEqual(200);
				expect(TASK_KINDS).toContain(option.kind);
			}
		}
	});

	it("asks each question, then the open one, and keeps the answers given before a cancel", async () => {
		const all = user(skipAll({ 0: first(0).label }, "  never push  "));
		const done = await runInterview(all.dialog, INTERVIEW);
		expect(done).toMatchObject({ more: "never push", cancelled: false });
		expect(done.answers.map((a) => a.option.label)).toEqual(skipAll({ 0: first(0).label }).slice(0, -1));
		expect(all.asked[0]).toEqual({
			title: `Question 1 of ${INTERVIEW.length + 1}\n${INTERVIEW[0]?.ask}`,
			options: INTERVIEW[0]?.options.map((o) => o.label),
		});
		expect(all.asked.at(-1)?.title).toBe(
			`Question ${INTERVIEW.length + 1} of ${INTERVIEW.length + 1}\n${INTERVIEW_OPEN_QUESTION}`,
		);

		const stopped = await runInterview(user([first(0).label]).dialog, INTERVIEW);
		expect(stopped).toMatchObject({ more: "", cancelled: true });
		expect(stopped.answers.map((a) => a.option)).toEqual([first(0)]);
	});
});

describe("/exo memory interview (D-066)", () => {
	const actions = (t: { records: { data: unknown }[] }) => t.records.map((r) => (r.data as { action: string }).action);
	const ask = (memory: ReturnType<typeof createMemory>, text: string) =>
		memory.contextForUserTurn?.({ text, origin: "user" }, signal);

	it("stores each chosen option as a standing preference that applies at once, and nothing for 'no preference'", async () => {
		const { memory, t } = setup({ preferences: true, preferenceSelect: false });
		const reply = await memory.command?.("interview", user(skipAll({ 0: first(0).label, 5: first(5).label })).dialog);
		expect(reply).toBe(
			"Interview finished. Preferences saved: 2 (2 new). They apply in every repo, starting with your next prompt. /exo memory preferences lists them; /exo memory forget <id> removes one.",
		);
		expect(t.records.map((r) => r.data)).toEqual([
			{ action: "preference_learned", preference: 1, rule: first(0).rule, source: "interview" },
			{ action: "preference_learned", preference: 2, rule: first(5).rule, source: "interview" },
			{ action: "interview", answered: INTERVIEW.length, added: 2, retired: 0, cancelled: false },
		]);
		// No sidecar was needed, and none was called.
		expect(t.requests).toEqual([]);
		expect(openMemoryStore(dbPath).preferences()[0]).toMatchObject({
			rule: first(0).rule,
			taskKind: "fix",
			sightings: [
				{ standing: true, correction: false, source: "interview", quote: `${INTERVIEW[0]?.ask} → ${first(0).label}` },
			],
		});
		expect(await memory.command?.("preferences")).toBe(
			[
				`1. For bug fixes: ${first(0).rule} (said in 1 session; from the interview; applies here; added 0×)`,
				`2. ${first(5).rule} (said in 1 session; from the interview; applies here; added 0×)`,
			].join("\n"),
		);
		const added = await ask(memory, "Fix the crash on empty input");
		expect(added).toContain(`- For bug fixes: ${first(0).rule}`);
		expect(added).toContain(`- ${first(5).rule}`);
	});

	it("keeps the answers given before a cancel", async () => {
		const { memory, t } = setup();
		const reply = await memory.command?.("interview", user([first(0).label]).dialog);
		expect(reply).toContain("Interview stopped early; the answers so far are kept. Preferences saved: 1 (1 new).");
		expect(actions(t)).toEqual(["preference_learned", "interview"]);
		expect(await setup().memory.command?.("interview", user([]).dialog)).toContain("No preferences were saved.");
	});

	it("replaces an earlier answer to the same question, and withdraws it on 'no preference'", async () => {
		const other = INTERVIEW[0]?.options[1] ?? { label: "" };
		await setup().memory.command?.("interview", user(skipAll({ 0: first(0).label, 5: first(5).label })).dialog);

		const again = setup();
		const reply = await again.memory.command?.(
			"interview",
			user(skipAll({ 0: other.label, 5: first(5).label })).dialog,
		);
		expect(reply).toContain("Preferences saved: 2 (1 new).");
		expect(again.t.records.map((r) => r.data)).toEqual([
			{ action: "preference_retired", preference: 1, by: "interview" },
			{ action: "preference_learned", preference: 3, rule: other.rule, source: "interview" },
			{ action: "preference_seen", preference: 2, rule: first(5).rule, source: "interview" },
			{ action: "interview", answered: INTERVIEW.length, added: 1, retired: 1, cancelled: false },
		]);

		const cleared = setup();
		await cleared.memory.command?.("interview", user(skipAll({})).dialog);
		expect(actions(cleared.t)).toEqual(["preference_retired", "preference_retired", "interview"]);
		expect(openMemoryStore(dbPath).preferences()).toEqual([]);
	});

	it("admits the open answer like a typed message, as standing rules", async () => {
		const more = "Use British spelling in comments, and keep functions short.";
		const proposed = (quote: string, rule: string) => ({
			preferences: [{ rule, quote, standing: false, applies_to: "any", correction: false, same_as: 0, replaces: 0 }],
		});
		const { memory, t } = setup({ preferences: true }, () => proposed("Use British spelling", "Use British spelling."));
		const u = user(skipAll({}, more));
		expect(await memory.command?.("interview", u.dialog)).toContain("Preferences saved: 1 (1 new).");
		expect(u.notices).toEqual(["Reading your last answer…"]);
		expect(String(t.requests[0]?.messages[0]?.["content"])).toContain(more);
		expect(openMemoryStore(dbPath).preferences()[0]).toMatchObject({
			rule: "Use British spelling.",
			sightings: [{ standing: true, source: "interview", quote: "Use British spelling" }],
		});

		// The quote must still be the user's words.
		const invented = setup({ preferences: true }, () => proposed("always write tests first", "Write tests first."));
		expect(await invented.memory.command?.("interview", user(skipAll({}, more)).dialog)).toContain(
			"No preferences were saved.",
		);
		expect(openMemoryStore(dbPath).preferences()).toHaveLength(1);
	});

	it("says so when the open answer cannot be read, when preferences are off and when there is no UI", async () => {
		expect(await setup().memory.command?.("interview", user(skipAll({}, "Never push to main.")).dialog)).toContain(
			"No preferences were saved. Your last answer was not read: that needs a sidecar engine.",
		);
		expect(await setup().memory.command?.("interview")).toBe("The interview needs an interactive session.");
		expect(await setup({}).memory.command?.("interview", user([]).dialog)).toBe(
			"Preference learning is off (memory.preferences): turn it on first.",
		);
		expect(openMemoryStore(dbPath).preferences()).toEqual([]);
	});
});
