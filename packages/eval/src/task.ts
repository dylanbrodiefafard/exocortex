import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/**
 * Files that decide what the check runs, put back before it (D-079): the build and test-runner
 * configuration of the four toolchains. A name without `/` matches in any directory.
 */
const DEFAULT_PROTECT: readonly string[] = [
	"Makefile",
	"GNUmakefile",
	"makefile",
	"CMakeLists.txt",
	"Cargo.toml",
	"go.mod",
	"go.work",
	"conftest.py",
	"pytest.ini",
	"pyproject.toml",
	"setup.cfg",
	"tox.ini",
];

const TaskSpecSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
		language: Type.Union([
			Type.Literal("python"),
			Type.Literal("go"),
			Type.Literal("rust"),
			Type.Literal("cpp"),
			Type.Literal("other"),
		]),
		/** What the user would type. */
		prompt: Type.String({ minLength: 1 }),
		/** Shell command run in the workspace after the agent settles; exit 0 = success. */
		check: Type.String({ minLength: 1 }),
		/** Optional shell command run once before the agent starts (e.g. warm a build cache). */
		setup: Type.Optional(Type.String()),
		/** Abort the agent after this many turns. */
		maxTurns: Type.Number({ minimum: 1, default: 40 }),
		/** Abort the agent after this much wall-clock time. */
		timeoutSec: Type.Number({ minimum: 1, default: 900 }),
		checkTimeoutSec: Type.Number({ minimum: 1, default: 300 }),
		tags: Type.Array(Type.String(), { default: [] }),
		/**
		 * Restore the fixture's test files before the check (tamper guard, D-048). Turn off only for
		 * tasks that ask the agent to change existing tests.
		 */
		protectTests: Type.Boolean({ default: true }),
		/**
		 * Build and runner files restored before the check like the tests are (D-079): a name
		 * (`Makefile`, any directory) or a repo-relative path (`sub/Makefile`). A file the reference
		 * solution changes is never restored. `[]` turns it off.
		 */
		protect: Type.Array(Type.String({ minLength: 1 }), { default: [...DEFAULT_PROTECT] }),
		/**
		 * Tests the check must run and pass. A check that exits 0 after fewer is a failure: something
		 * stopped the tests from running. Written by `--validate --record-tests` from the reference
		 * solution; lower it by hand when a correct solution may remove tests the fixture ships.
		 */
		minTests: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

type TaskSpec = Static<typeof TaskSpecSchema>;

export interface Task {
	readonly spec: TaskSpec;
	/** Directory containing `task.json`, `repo/` and optionally `solution.patch`. */
	readonly dir: string;
	readonly repoDir: string;
	readonly solutionPatch: string | undefined;
	/**
	 * Optional `hidden/` overlay: copied over the workspace after the agent finishes and before
	 * the check runs, so acceptance tests the agent never saw can score the result.
	 */
	readonly hiddenDir: string | undefined;
	/** Repo-relative paths `solution.patch` adds, changes, removes or renames: the check guard leaves them alone. */
	readonly solutionPaths: ReadonlySet<string>;
}

/**
 * Loads every task under `tasksDir` (one subdirectory per task) whose id matches one of the
 * glob-ish `filters` (`*` wildcard) and that carries at least one of `tags`. Empty lists match
 * everything.
 */
export function loadTasks(tasksDir: string, filters: readonly string[] = [], tags: readonly string[] = []): Task[] {
	const patterns = filters.map(globToRegExp);
	const tasks: Task[] = [];
	for (const entry of readdirSync(tasksDir).sort()) {
		const dir = join(tasksDir, entry);
		if (!statSync(dir).isDirectory()) continue;
		// Directory name == task id (enforced below), so filter before reading anything: a
		// half-written task elsewhere in tasks/ must not break a filtered run.
		if (patterns.length > 0 && !patterns.some((p) => p.test(entry))) continue;
		// Not a task (yet): a directory being authored has no task.json until it is ready.
		if (!existsSync(join(dir, "task.json"))) continue;
		const task = loadTask(dir);
		if (task.spec.id !== entry) throw new Error(`${dir}: task id "${task.spec.id}" must match its directory name`);
		const idMatches = patterns.length === 0 || patterns.some((p) => p.test(task.spec.id));
		const tagMatches = tags.length === 0 || tags.some((tag) => task.spec.tags.includes(tag));
		if (idMatches && tagMatches) tasks.push(task);
	}
	return tasks;
}

export function loadTask(dir: string): Task {
	const specPath = join(dir, "task.json");
	const raw: unknown = JSON.parse(readFileSync(specPath, "utf8"));
	const spec = Value.Default(TaskSpecSchema, raw);
	if (!Value.Check(TaskSpecSchema, spec)) {
		const errors = [...Value.Errors(TaskSpecSchema, spec)].map((e) => `${e.instancePath || "/"} ${e.message}`);
		throw new Error(`${specPath}: invalid task spec: ${errors.join("; ")}`);
	}
	const repoDir = join(dir, "repo");
	if (!existsSync(repoDir)) throw new Error(`${dir}: missing repo/ directory`);
	const patchPath = join(dir, "solution.patch");
	const hiddenDir = join(dir, "hidden");
	return {
		spec,
		dir,
		repoDir,
		solutionPatch: existsSync(patchPath) ? patchPath : undefined,
		hiddenDir: existsSync(hiddenDir) ? hiddenDir : undefined,
		solutionPaths: existsSync(patchPath) ? patchedPaths(readFileSync(patchPath, "utf8")) : new Set(),
	};
}

/** The paths a unified diff touches, from its `--- a/…` and `+++ b/…` headers and rename lines. */
function patchedPaths(patch: string): Set<string> {
	const paths = new Set<string>();
	for (const match of patch.matchAll(/^(?:--- a\/|\+\+\+ b\/|rename from |rename to )(.+?)\t?$/gm)) {
		if (match[1]) paths.add(match[1]);
	}
	return paths;
}

/**
 * Writes `minTests` into the task's `task.json` by editing the text, so the rest of the file,
 * its formatting included, stays exactly as its author left it.
 */
export function recordMinTests(task: Task, minTests: number): void {
	const path = join(task.dir, "task.json");
	const text = readFileSync(path, "utf8");
	const existing = /("minTests"\s*:\s*)\d+/;
	const updated = existing.test(text)
		? text.replace(existing, `$1${minTests}`)
		: text.replace(/\s*\}\s*$/, `,\n\t"minTests": ${minTests}\n}\n`);
	writeFileSync(path, updated);
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}
