import "./home-guard.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deadEndsIn } from "../src/dead-ends.ts";
import { createEpisodeTracker } from "../src/episodes.ts";
import { openMemoryStore } from "../src/store.ts";
import { editOf, fail, LESSON, pass, setup, until, workspace } from "./helpers.ts";

const space = workspace();

describe("what did not fix a problem is remembered with its fix", () => {
	it("names files edited before the same error came back, not those edited again after it", () => {
		const tracker = createEpisodeTracker({ cwd: space.dir(), minDetail: 0.5 });
		const route = [
			fail(),
			editOf("src/parser.rs", "a", "b"),
			editOf("src/stack.rs", "c", "d"),
			fail(),
			editOf("src/stack.rs", "d", "e"),
			editOf("lib.rs", "f", "g"),
			pass(),
		];
		const episodes = route.flatMap((tool) => tracker.observe(tool));
		expect(episodes.map((e) => e.deadEnds)).toEqual([["src/parser.rs"]]);
	});

	it("names none when the first edits changed the error", () => {
		const tracker = createEpisodeTracker({ cwd: space.dir(), minDetail: 0.5 });
		const other = "error[E0425]: cannot find value `depth` in this scope\n  --> src/parser.rs:9:5";
		const route = [
			fail(),
			editOf("src/parser.rs", "a", "b"),
			fail("cargo build", other),
			editOf("lib.rs", "c", "d"),
			pass(),
		];
		const episodes = route.flatMap((tool) => tracker.observe(tool));
		expect(episodes.every((e) => e.deadEnds.length === 0)).toBe(true);
	});

	it("shows the dead ends with the card in this repo", async () => {
		const learner = setup(space, {}, { reply: () => LESSON });
		for (const tool of [fail(), editOf("src/parser.rs", "a", "b"), fail(), editOf("lib.rs", "c", "d"), pass()])
			learner.memory.onToolResult?.(tool);
		await until(() => learner.actions().includes("learned"));
		const later = setup(space, {}, { reply: () => LESSON });
		const rewrite = await later.recall(fail());
		expect(rewrite?.text).toContain(
			`- (this error, this repo; the fix edited src/parser.rs, lib.rs; the error came back after the edits to src/parser.rs) ${LESSON.lesson}`,
		);
	});

	it("reads evidence it cannot parse, or from before dead ends were kept, as none", () => {
		const fix = (deadEnds: unknown) => JSON.stringify({ command: "cargo build", deadEnds });
		expect(deadEndsIn({ evidence: "not json" })).toEqual([]);
		expect(deadEndsIn({ evidence: JSON.stringify({ command: "cargo build" }) })).toEqual([]);
		expect(deadEndsIn({ evidence: fix([1, "a.rs", null]) })).toEqual(["a.rs"]);
		// Merged fixes: every fix's dead ends, once each.
		expect(deadEndsIn({ evidence: `${fix(["a.rs", "b.rs"])}\n---\n${fix(["b.rs", "c.rs"])}` })).toEqual([
			"a.rs",
			"b.rs",
			"c.rs",
		]);
	});
});

describe("a card whose files are gone is not shown", () => {
	it("skips it while every file it names is missing, and shows it again when one is back", async () => {
		const learner = setup(space, {}, { reply: () => LESSON });
		for (const tool of [fail(), editOf("lib.rs", "a", "b"), pass()]) learner.memory.onToolResult?.(tool);
		await until(() => learner.actions().includes("learned"));
		rmSync(join(space.dir(), "lib.rs"));
		const gone = setup(space, {}, { reply: () => LESSON });
		expect(await gone.recall(fail())).toBeUndefined();
		expect(gone.actions()).toContain("skipped_stale");
		expect(openMemoryStore(space.dbPath()).cards()[0]?.validTo).toBeNull();
	});
});
