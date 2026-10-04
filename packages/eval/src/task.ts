import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

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
	};
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}
