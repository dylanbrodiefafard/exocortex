import "./home-guard.ts";
import type { CommandOutput, ModuleContext } from "@exocortex/core";
import { createTestModuleContext } from "@exocortex/testkit";
import { describe, expect, it } from "vitest";
import { createMemory } from "../src/memory.ts";
import { normalizeRemote, repoScope } from "../src/scope.ts";
import { openMemoryStore } from "../src/store.ts";
import { edit, fail, idle, pass, SETTLED, signal, workspace } from "./helpers.ts";

const space = workspace();

const ran = (output: string, exitCode = 0): CommandOutput => ({
	exitCode,
	timedOut: false,
	durationMs: 1,
	outputTail: output,
});
const TIMED_OUT: CommandOutput = { exitCode: null, timedOut: true, durationMs: 5_000, outputTail: "" };

/** A context whose git answers are scripted: the first for the remote, the second for the root tree. */
function withGit(answers: readonly (CommandOutput | Error)[]) {
	const t = createTestModuleContext({ cwd: space.dir(), reply: () => ({ preferences: [] }) });
	const left = [...answers];
	const context: ModuleContext = {
		...t.context,
		runCommand: async () => {
			const next = left.shift() ?? ran("", 128);
			if (next instanceof Error) throw next;
			return next;
		},
	};
	return { t, context };
}

describe("repo scope (M12)", () => {
	it.each([
		["git@github.com:Owner/Repo.git", "github.com/owner/repo"],
		["https://github.com/owner/repo", "github.com/owner/repo"],
		["https://github.com/owner/repo.git/", "github.com/owner/repo"],
		["https://user:secret-token@GitHub.com/owner/repo.git", "github.com/owner/repo"],
		["ssh://git@gitlab.example.com:2222/group/sub/repo.git", "gitlab.example.com/group/sub/repo"],
		["git://host.example/owner/repo", "host.example/owner/repo"],
		["  git@github.com:owner/repo  ", "github.com/owner/repo"],
		["/srv/git/Project.git", "/srv/git/Project"],
		["file:///srv/git/project.git", "/srv/git/project"],
	])("names %s as %s", (url, name) => {
		expect(normalizeRemote(url)).toBe(name);
	});

	it("is the remote in its normal form, else the root tree, else the path", async () => {
		expect(await repoScope(withGit([ran("git@github.com:Owner/Repo.git\n")]).context)).toEqual({
			id: "remote:github.com/owner/repo",
			known: true,
		});
		expect(await repoScope(withGit([ran("", 2), ran("abc123\n")]).context)).toEqual({ id: "tree:abc123", known: true });
		expect(await repoScope(withGit([ran("", 128), ran("", 128)]).context)).toEqual({
			id: `path:${space.dir()}`,
			known: true,
		});
	});

	it("does not guess when git did not answer in time", async () => {
		const unknown = { id: `path:${space.dir()}`, known: false };
		expect(await repoScope(withGit([TIMED_OUT]).context)).toEqual(unknown);
		expect(await repoScope(withGit([ran("", 2), TIMED_OUT]).context)).toEqual(unknown);
		expect(await repoScope(withGit([new Error("spawn failed")]).context)).toEqual(unknown);
	});

	it("learns and recalls nothing in a session whose repo it could not name", async () => {
		// A card that a path scope would find.
		const store = openMemoryStore(space.dbPath());
		const known = createMemory({ dbPath: space.dbPath(), distill: false }, withGit([]).context);
		for (const tool of [fail(), edit, pass()]) known.onToolResult?.(tool);
		await idle(80);
		expect(store.cards()).toHaveLength(1);

		const { t, context } = withGit([TIMED_OUT]);
		const memory = createMemory({ dbPath: space.dbPath(), distill: false, preferences: true }, context);
		for (const tool of [fail("make", "main.c:3:1: error: unknown type name 'u8'"), edit, pass("make")]) {
			memory.onToolResult?.(tool);
		}
		memory.onUserTurn?.({ text: "From now on always write the failing test first.", origin: "user" });
		await memory.onSettle?.(SETTLED, signal);
		await idle(80);
		expect(store.cards()).toHaveLength(1);
		expect(store.preferences()).toEqual([]);
		expect(t.requests).toEqual([]);
		const rewrite = await memory.rewriteToolResult?.(
			{ ...fail(), toolCallId: "c", current: "", fullOutputPath: null, status: null },
			signal,
		);
		expect(rewrite).toBeUndefined();
		expect(t.records.map((r) => r.data)).toEqual([{ action: "scope_unknown" }]);
		expect(memory.status?.()).toContain("repo unknown: not learning");
	});
});
