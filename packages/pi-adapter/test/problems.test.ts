import { describe, expect, it } from "vitest";
import { createProblems, problemLines } from "../src/problems.ts";

describe("what went wrong this session (D-106)", () => {
	it("keeps the latest, counts everything, and starts over for a new session", () => {
		let now = 1_000;
		const problems = createProblems(() => now);
		expect(problemLines(problems, now)).toEqual(["problems: none this session"]);
		problems.add("compaction", "summary failed: engine stopped answering", false);
		now += 90_000;
		problems.add("modules.rewrite", "TypeError: boom", true);
		expect(problems.counts()).toEqual({ errors: 1, notes: 1 });
		expect(problemLines(problems, now)).toEqual([
			"problems: 1 error(s), 1 note(s) this session; latest:",
			"  note · compaction · 2m ago: summary failed: engine stopped answering",
			"  error · modules.rewrite · 0s ago: TypeError: boom",
		]);
		problems.clear();
		expect(problems.counts()).toEqual({ errors: 0, notes: 0 });
		expect(problems.recent(5)).toEqual([]);
	});

	it("keeps 50 and cuts a long message, but counts on", () => {
		const problems = createProblems(() => 0);
		for (let i = 0; i < 60; i++) problems.add("memory", `note ${i} ${"x".repeat(400)}`, false);
		expect(problems.counts().notes).toBe(60);
		expect(problems.recent(100)).toHaveLength(50);
		expect(problems.recent(1)[0]?.message).toMatch(/^note 59 x+…$/);
		expect(problems.recent(1)[0]?.message.length).toBe(301);
		expect(problemLines(problems, 2 * 3_600_000, 1)[1]).toContain("2h ago");
	});
});
