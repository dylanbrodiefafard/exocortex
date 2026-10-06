import "./home-guard.ts";
import { describe, expect, it } from "vitest";
import { refusalOf } from "../src/admission.ts";
import { createEpisodeTracker, type FixEpisode } from "../src/episodes.ts";
import { deterministicLesson } from "../src/learn.ts";
import { shellEffect } from "../src/shell-effects.ts";
import { openMemoryStore } from "../src/store.ts";
import {
	bash,
	draft,
	edit,
	editOf,
	fail,
	idle,
	pass,
	SETTLED,
	setup,
	signal,
	until,
	workspace,
	writeOf,
} from "./helpers.ts";

const space = workspace();
const tracker = () => createEpisodeTracker({ cwd: "/repo", minDetail: 0.6 });
const cards = () => openMemoryStore(space.dbPath()).cards();
const live = () => cards().filter((c) => c.validTo === null);
const LESSON = { lesson: "Clone the value before pushing onto `self.stack` in lib.rs.", applies_when: "" };

/** fail → the given steps → pass, with no sidecar: whatever is admitted becomes a deterministic card. */
async function attempt(steps: readonly ReturnType<typeof bash>[], command = "cargo test") {
	const s = setup(space, { distill: false });
	s.memory.onToolResult?.(fail(command));
	for (const step of steps) s.memory.onToolResult?.(step);
	s.memory.onToolResult?.(pass(command));
	await idle(150);
	return s;
}

describe("admission: a pass is not a fix whatever the edits were (M1)", () => {
	it("stores no card when only tests were edited", async () => {
		const s = await attempt([editOf("tests/stack.rs", "assert_eq!(pop(), 3)", "assert_eq!(pop(), 4)")]);
		expect(live()).toEqual([]);
		expect(s.reasons()).toEqual(["only_tests"]);
	});

	it("stores no card when an edit skips a test or drops an assertion", async () => {
		const skipped = await attempt([edit, editOf("src/lib.rs", "#[test]\nfn pops()", "#[test]\n#[ignore]\nfn pops()")]);
		expect(skipped.reasons()).toEqual(["weakens_test"]);
		const loosened = await attempt([
			edit,
			editOf("tests/stack.rs", "assert_eq!(a, 1);\nassert_eq!(b, 2);", "assert_eq!(a, 1);"),
		]);
		expect(loosened.reasons()).toEqual(["weakens_test"]);
		expect(live()).toEqual([]);
	});

	it.each([
		"@pytest.mark.skip(reason='flaky')\ndef test_pop():",
		"@pytest.mark.xfail\ndef test_pop():",
		"@unittest.skip('later')\ndef test_pop(self):",
		'func TestPop(t *testing.T) {\n\tt.Skip("later")',
		"it.skip('pops', () => {",
		"xit('pops', () => {",
		"TEST(Stack, DISABLED_Pops) {",
	])("reads %j as a skip marker", (after) => {
		const episode = episodeWith([{ path: "src/stack.x", before: "def test_pop():", after }]);
		expect(refusalOf(episode)).toBe("weakens_test");
	});

	it("admits a fix that also adds a test, or tightens one", () => {
		expect(
			refusalOf(
				episodeWith([
					{ path: "src/lib.rs", before: "a", after: "b" },
					{ path: "tests/stack.rs", before: "assert!(a);", after: "assert!(a);\nassert!(b);" },
				]),
			),
		).toBeUndefined();
	});

	it("stores no card when a shell command changed files between the failure and the pass", async () => {
		for (const command of [
			"git checkout -- src/",
			"git stash",
			"rm tests/flaky.rs",
			"sed -i 's/3/4/' tests/stack.rs",
			"pip install pyyaml",
			"cargo fmt",
			"echo 'fn main() {}' > src/main.rs",
		]) {
			const s = await attempt([edit, bash(command)]);
			expect([command, s.reasons()]).toEqual([command, ["shell_change"]]);
		}
		expect(live()).toEqual([]);
		// Looking around changes nothing.
		const read = await attempt([
			edit,
			bash("git diff && cat src/lib.rs | head -20"),
			bash("grep -rn stack src > /dev/null"),
		]);
		expect(read.actions()).toEqual(["learned"]);
	});

	it("tells commands that change files from ones that read and ones it cannot tell", () => {
		const effect = (line: string) => shellEffect(line, "/repo");
		for (const line of [
			"git restore .",
			"git -C sub reset --hard",
			"mv a.rs b.rs",
			"perl -pi -e 's/a/b/' x.rs",
			"npm install left-pad",
			"cd app && cargo add serde",
			"npx prettier --write src",
			"cat > src/gen.rs <<EOF\nfn x() {}\nEOF",
			"cargo test 2>&1 | tee src/snapshot.rs",
		]) {
			expect([line, effect(line)]).toEqual([line, "changes"]);
		}
		for (const line of [
			"ls -la",
			"git status --short",
			"git stash list",
			"sed -n '1,20p' src/lib.rs",
			"cargo test 2>&1 | tail -20",
			"cargo test > /tmp/out.txt 2>&1; tail /tmp/out.txt",
			"cargo build 2>&1 | tee build.log",
			"rg 'a > b' src",
			"find . -name '*.rs' | wc -l",
		]) {
			expect([line, effect(line)]).toEqual([line, "reads"]);
		}
		for (const line of [
			"python scripts/regen.py",
			"./configure",
			"find . -name '*.orig' -delete",
			"docker compose up -d",
		]) {
			expect([line, effect(line)]).toEqual([line, "other"]);
		}
	});

	it("shows the lesson sidecar the commands it cannot tell, and asks it to refuse a loosened test", async () => {
		const s = setup(space, {}, { reply: () => LESSON });
		s.memory.onToolResult?.(fail());
		s.memory.onToolResult?.(edit);
		s.memory.onToolResult?.(bash("python scripts/regen.py"));
		s.memory.onToolResult?.(bash("ls"));
		s.memory.onToolResult?.(pass());
		await until(() => s.t.requests.length > 0);
		const prompt = String(s.t.requests[0]?.messages[0]?.["content"]);
		expect(prompt).toContain("- python scripts/regen.py");
		expect(prompt).not.toContain("- ls");
		expect(prompt).toMatch(/loosen/);
	});

	it("does not count an edit outside the working directory", async () => {
		const outside = await attempt([editOf("/tmp/scratch/notes.rs", "a", "b"), editOf("../other/lib.rs", "a", "b")]);
		expect(outside.t.records).toEqual([]);
		const both = await attempt([
			editOf("/tmp/scratch/notes.rs", "a", "b"),
			editOf(`${space.dir()}/src/lib.rs`, "a", "b"),
		]);
		expect(both.actions()).toEqual(["learned"]);
		expect(live().map((c) => c.files)).toEqual([["src/lib.rs"]]);
	});
});

describe("the lesson and its gate (M2)", () => {
	it("writes no card when the sidecar fails, and asks again at the next settle", async () => {
		let down = true;
		const s = setup(space, {}, { reply: () => (down ? new Error("engine down") : LESSON) });
		s.memory.onToolResult?.(fail());
		s.memory.onToolResult?.(edit);
		s.memory.onToolResult?.(pass());
		await until(() => s.t.logs.some((l) => l.startsWith("lesson error")));
		await idle();
		expect(cards()).toEqual([]);
		down = false;
		await s.memory.onSettle?.(SETTLED, signal);
		await until(() => s.actions().includes("learned"));
		expect(live().map((c) => c.lesson)).toEqual([LESSON.lesson]);
	});

	it("gives up on a lesson the sidecar never delivers, without a card", async () => {
		const s = setup(space, {}, { reply: () => new Error("engine down") });
		s.memory.onToolResult?.(fail());
		s.memory.onToolResult?.(edit);
		s.memory.onToolResult?.(pass());
		for (let i = 0; i < 4; i++) {
			await idle(60);
			await s.memory.onSettle?.(SETTLED, signal);
		}
		await until(() => s.reasons().includes("no_lesson"));
		expect(s.reasons()).toEqual(["no_lesson"]);
		expect(cards()).toEqual([]);
		expect(s.t.requests).toHaveLength(3);
	});

	it("makes one card when the same problem is verified twice while the first lesson is being written", async () => {
		const s = setup(space, {}, { reply: () => new Promise((r) => setTimeout(() => r(LESSON), 30)) });
		for (const command of ["cargo build", "cargo test"]) s.memory.onToolResult?.(fail(command));
		s.memory.onToolResult?.(edit);
		for (const command of ["cargo build", "cargo test"]) s.memory.onToolResult?.(pass(command));
		await until(() => s.t.records.length === 2);
		expect(s.actions()).toEqual(["learned", "merged"]);
		expect(live()).toHaveLength(1);
		expect(s.t.requests).toHaveLength(1);
	});

	it("names only the file when the fix rewrote it", () => {
		expect(
			deterministicLesson(episodeWith([{ path: "src/a.rs", before: "(file rewritten)", after: "fn main() {\n}" }])),
		).toBe("Fixed before by rewriting src/a.rs");
		const s = tracker();
		s.observe(fail());
		s.observe(writeOf("src/a.rs", "fn main() {}"));
		const [episode] = s.observe(pass());
		expect(episode && deterministicLesson(episode)).toBe("Fixed before by rewriting src/a.rs");
	});
});

describe("one problem is a signature and its names, in the tracker too (M3)", () => {
	const failing = (test: string) =>
		`thread '${test}' (31) panicked at tests/${test}.rs:4:5:\nerror: test failed, to rerun pass \`--test ${test}\``;

	it("opens a new step when another test fails with the same signature", () => {
		const t = tracker();
		t.observe(fail("cargo test", failing("empty_input")));
		t.observe(editOf("src/parser.rs", "a", "b"));
		t.observe(fail("cargo test", failing("simple_table")));
		t.observe(editOf("src/render.rs", "c", "d"));
		const episodes = t.observe(pass("cargo test"));
		expect(
			episodes.map((e) => [e.detail, e.steps.map((s) => s.edits.map((x) => x.path)), e.steps[0]?.retries]),
		).toEqual([
			[["empty_input"], [["src/parser.rs"], ["src/render.rs"]], 0],
			[["simple_table"], [["src/render.rs"]], 0],
		]);
	});

	it("keeps collecting while the same test keeps failing, whatever else fails beside it", () => {
		const t = tracker();
		t.observe(fail("cargo test", failing("empty_input")));
		t.observe(editOf("src/parser.rs", "a", "b"));
		t.observe(fail("cargo test", `${failing("simple_table")}\n${failing("empty_input")}`));
		t.observe(editOf("src/parser.rs", "b", "c"));
		const episodes = t.observe(pass("cargo test"));
		expect(episodes).toHaveLength(1);
		expect(episodes[0]?.steps[0]?.retries).toBe(1);
	});
});

describe("a wrong card can get out (M4)", () => {
	const settle = async (s: ReturnType<typeof setup>) => s.memory.onSettle?.(SETTLED, signal);

	it("replaces a card when its problem is fixed again by edits to other files", async () => {
		await attempt([editOf("src/unrelated.rs", "a", "b")], "cargo build");
		const [first] = live();
		expect(first?.files).toEqual(["src/unrelated.rs"]);

		const again = await attempt(
			[editOf("src/stack.rs", "self.stack.push(x)", "self.stack.push(x.clone())")],
			"cargo build",
		);
		expect(again.actions()).toEqual(["superseded"]);
		expect(again.t.records[0]?.data).toMatchObject({ replaces: first?.id });
		expect(live().map((c) => c.files)).toEqual([["src/stack.rs"]]);
		expect(cards().find((c) => c.id === first?.id)?.validTo).not.toBeNull();

		// The same files again: the card's fix held, so it is the same card seen twice.
		const third = await attempt([editOf("src/stack.rs", "x", "y")], "cargo build");
		expect(third.actions()).toEqual(["merged"]);
		expect(live().map((c) => c.seen)).toEqual([2]);
	});

	it("credits a card only when the pass followed edits to the files it names", async () => {
		await attempt([edit], "cargo build");
		const ignored = setup(space);
		await ignored.recall(fail());
		ignored.memory.onToolResult?.(editOf("src/elsewhere.rs", "a", "b"));
		ignored.memory.onToolResult?.(pass());
		await settle(ignored);
		expect(ignored.actions()).toEqual(["recalled", "credit_withheld"]);

		const flaky = setup(space);
		await flaky.recall(fail());
		flaky.memory.onToolResult?.(pass());
		await settle(flaky);
		expect(flaky.actions()).toEqual(["recalled", "credit_withheld"]);

		const followed = setup(space, { learn: false });
		await followed.recall(fail());
		followed.memory.onToolResult?.(editOf(`${space.dir()}/lib.rs`, "a", "b"));
		followed.memory.onToolResult?.(pass());
		await settle(followed);
		expect(followed.t.records.at(-1)?.data).toMatchObject({ action: "credited", outcome: "helped" });
		expect(cards()[0]).toMatchObject({ injected: 3, helped: 1, hurt: 0 });
	});

	it("does not count a card as shown when its rewrite never reached the agent", async () => {
		await attempt([edit], "cargo build");
		const s = setup(space);
		const dropped = await s.memory.rewriteToolResult?.(draft(fail()), signal);
		expect(dropped?.text).toContain("exo memory");
		expect(s.t.records).toEqual([]);
		expect(cards()[0]?.injected).toBe(0);
		// Not shown, so it is offered again.
		expect((await s.recall(fail()))?.note).toBe("recalled 1 card(s)");
		expect(cards()[0]?.injected).toBe(1);
	});

	it("lists this repo's cards and retires one on the user's word", async () => {
		await attempt([edit], "cargo build");
		const s = setup(space);
		const [card] = live();
		expect(await s.memory.command?.("cards")).toBe(
			`${card?.id}. Fixed before by editing lib.rs: \`self.stack.push(x)\` → \`let v = x.clone(); self.stack.push(v)\` (for: error[E0502]: cannot borrow \`self.stack\` as mutable; files: lib.rs; seen 1×, shown 0×, helped 0×, hurt 0×)\n/exo memory forget card <id> removes one.`,
		);
		expect(s.memory.command?.("forget card 999")).toBe("No card 999.");
		expect(s.memory.command?.("forget card")).toBe("Usage: /exo memory forget card <id>");
		expect(s.memory.command?.(`forget card ${card?.id}`)).toBe(`Forgot card ${card?.id}.`);
		expect(s.t.records.at(-1)?.data).toEqual({ action: "card_retired", card: card?.id, by: "user" });
		expect(live()).toEqual([]);
		expect(await s.recall(fail())).toBeUndefined();
		expect(await s.memory.command?.("cards")).toBe("No cards for this repo yet.");
	});
});

describe("what a long route keeps (M11)", () => {
	it("keeps the latest edits when there are more than fit, and every file that was touched last", () => {
		const t = tracker();
		t.observe(fail());
		for (let i = 0; i < 12; i++) t.observe(editOf(i < 10 ? "src/a.rs" : `src/b${i}.rs`, `before ${i}`, `after ${i}`));
		const [episode] = t.observe(pass());
		const edits = episode?.steps[0]?.edits ?? [];
		expect(edits).toHaveLength(8);
		expect(edits.at(-1)).toEqual({ path: "src/b11.rs", before: "before 11", after: "after 11" });
		expect(edits.map((e) => e.after)).toContain("after 9");
		expect(edits.map((e) => e.after)).not.toContain("after 0");
	});

	it("forgets a failing command the agent did not run again for a long time", () => {
		const t = tracker();
		t.observe(fail());
		t.observe(edit);
		for (let i = 0; i < 80; i++) t.observe(bash("ls"));
		expect(t.observe(pass())).toEqual([]);
		// Running it again in between keeps it open.
		t.observe(fail());
		for (let i = 0; i < 40; i++) t.observe(bash("ls"));
		t.observe(fail());
		t.observe(edit);
		for (let i = 0; i < 40; i++) t.observe(bash("ls"));
		expect(t.observe(pass())).toHaveLength(1);
	});
});

function episodeWith(edits: FixEpisode["steps"][number]["edits"]): FixEpisode {
	return {
		command: "cargo test",
		signature: "s",
		errorLine: "e",
		detail: [],
		shell: [],
		steps: [{ errorLine: "e", excerpt: "", retries: 0, edits }],
	};
}
