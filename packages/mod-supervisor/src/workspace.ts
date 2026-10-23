import { createHash } from "node:crypto";
import { lstat, open, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModuleContext } from "@exocortex/core";

/**
 * Reading the working tree for the supervisor's evidence (D-071, D-084): which files git does not
 * track yet and what is in them, and a fingerprint of everything the task has changed. File names
 * come from git NUL-separated and files are read here, not through a shell, so a name with a
 * quote, a space or a non-ASCII letter is the same as any other.
 */

/**
 * A limit on git while the agent works or the user waits (a message's start, a snapshot after a
 * test run). In a background job git has none: the job's signal stops it (D-107).
 */
const GIT_TIMEOUT_MS = 10_000;
/** The longest a timer runs: a git command in a background job, which its signal stops. */
const NO_TIME_LIMIT_MS = 2 ** 31 - 1;
/** Room for some twenty thousand paths; a longer list loses its start. */
const LIST_CHARS = 1024 * 1024;
/**
 * What a fingerprint reads: this many files and bytes by content. For a larger file, and for the
 * rest once either runs out, size and modification time stand in. A tree of generated files git
 * was never told to ignore must not cost a read of all of it after every test run.
 */
const MAX_HASHED_FILES = 2_000;
const MAX_HASHED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_HASHED_BYTES = 64 * 1024 * 1024;
/** New files looked at when choosing which to show. */
const MAX_NEW_FILES_SIZED = 1_000;

/** A commit id as `git rev-parse` prints it. Anything else must never reach a command line. */
export function isCommitId(ref: unknown): ref is string {
	return typeof ref === "string" && /^[0-9a-f]{7,64}$/.test(ref);
}

/** What a git command printed, or why it failed: a failure is never taken for "no changes" (D-107). */
export type GitResult = { readonly ok: true; readonly out: string } | { readonly ok: false; readonly error: string };

/**
 * Runs `git <args>` in the working directory, with names printed as they are. With a `signal` (a
 * background job) it has no time limit: the signal stops it.
 */
export async function git(
	ctx: ModuleContext,
	args: string,
	options: { readonly signal?: AbortSignal; readonly tailChars?: number } = {},
): Promise<GitResult> {
	try {
		const out = await ctx.runCommand(`git -c core.quotePath=false ${args}`, {
			timeoutMs: options.signal ? NO_TIME_LIMIT_MS : GIT_TIMEOUT_MS,
			...(options.tailChars === undefined ? {} : { tailChars: options.tailChars }),
			...(options.signal ? { signal: options.signal } : {}),
		});
		if (out.exitCode === 0 && !out.timedOut) return { ok: true, out: out.outputTail };
		const why = out.timedOut
			? `timed out after ${Math.round(out.durationMs / 1000)} s`
			: out.exitCode === null
				? "stopped"
				: `exit ${out.exitCode}: ${lastLine(out.outputTail)}`;
		return { ok: false, error: `git ${args.split(" ")[0]} ${why}` };
	} catch (error) {
		return { ok: false, error: `git ${args.split(" ")[0]}: ${String(error)}` };
	}
}

/** Whether a git failure means only that there is no repository here: nothing to report then. */
export function notARepository(result: { readonly ok: boolean; readonly error?: string }): boolean {
	return !result.ok && /not a git repository/i.test(result.error ?? "");
}

function lastLine(text: string): string {
	return text.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
}

/** A NUL-separated list of paths from git, or undefined when the command failed (not a repository). */
async function gitPaths(ctx: ModuleContext, args: string, signal?: AbortSignal): Promise<string[] | undefined> {
	const out = await git(ctx, args, { tailChars: LIST_CHARS, ...(signal ? { signal } : {}) });
	if (!out.ok) return undefined;
	const paths = out.out.split("\0").filter(Boolean);
	// Only the end of a longer output is kept: its first entry may be half a name.
	return out.out.length >= LIST_CHARS ? paths.slice(1) : paths;
}

/** Files git neither tracks nor ignores, relative to the working directory; undefined outside a repository or when git fails. */
function untrackedFiles(ctx: ModuleContext, signal?: AbortSignal): Promise<string[] | undefined> {
	return gitPaths(ctx, "ls-files -z --others --exclude-standard", signal);
}

/** Files git neither tracks nor ignores, or why git could not list them (D-107): a failure is not "no new files". */
export async function listUntracked(
	ctx: ModuleContext,
	signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly files: string[] } | { readonly ok: false; readonly error: string }> {
	const out = await git(ctx, "ls-files -z --others --exclude-standard", {
		tailChars: LIST_CHARS,
		...(signal ? { signal } : {}),
	});
	if (!out.ok) return out;
	const paths = out.out.split("\0").filter(Boolean);
	return { ok: true, files: out.out.length >= LIST_CHARS ? paths.slice(1) : paths };
}

/** Directories that test and build runs fill, whatever the project's `.gitignore` says. */
const BYPRODUCT_DIRS = new Set([
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".hypothesis",
	".tox",
	".nox",
	"node_modules",
	".gradle",
	".next",
	".turbo",
	".parcel-cache",
	".zig-cache",
	"zig-cache",
	"zig-out",
]);
const BYPRODUCT_FILE = /\.(pyc|pyo|o|obj|class)$|^\.coverage(\..*)?$|\.egg-info$/;

/**
 * Whether a new file is what test and build runs leave behind (D-107): Python's bytecode and test
 * caches, `node_modules`, Cargo's `target/`, object files. The judge took `__pycache__/` files a
 * test run made for changes the agent should not have made, and their bytes change on every run.
 */
export function isByproduct(path: string): boolean {
	const parts = path.split("/");
	const name = parts.at(-1) ?? "";
	if (BYPRODUCT_FILE.test(name)) return true;
	if (parts.slice(0, -1).some((dir) => BYPRODUCT_DIRS.has(dir) || dir.endsWith(".egg-info"))) return true;
	// Cargo's build directory: at the top, or with the profile directories it always has.
	return parts[0] === "target" || /(^|\/)target\/(debug|release)\//.test(path);
}

/** A budget that hashes nothing: size and modification time stand for content. */
const statOnly = () => ({ files: 0, bytes: 0 });

/**
 * The working tree as a task starts, as a commit to diff against (D-102): `git stash create`
 * records the tracked files with the developer's uncommitted edits, and makes no stash entry and
 * changes no file. With no such edits it prints nothing, and `HEAD` is the start. Undefined
 * outside a repository or before its first commit. Files git does not track are recorded apart
 * ({@link untrackedStates}).
 */
export async function taskStart(ctx: ModuleContext): Promise<string | undefined> {
	const snapshot = await git(ctx, "stash create");
	const id = snapshot.ok ? snapshot.out.trim() : "";
	if (isCommitId(id)) return id;
	const head = await git(ctx, "rev-parse --verify HEAD");
	const headId = head.ok ? head.out.trim() : "";
	if (!isCommitId(headId)) return undefined;
	// Said only when it matters: the developer's uncommitted edits will read as the task's (D-107).
	if (!snapshot.ok) {
		ctx.log(
			`could not record the uncommitted edits as the task began (${snapshot.error}): its changes are taken from HEAD, and may include edits made before it`,
		);
	}
	return headId;
}

/** Whether `ref` names a commit this repository still has: a start snapshot is pruned with time. */
export async function commitExists(ctx: ModuleContext, ref: string): Promise<boolean> {
	if (!isCommitId(ref)) return false;
	return (await git(ctx, `cat-file -e ${ref}^{commit}`)).ok;
}

/** Each file git does not track, with its size and time: which new files were there before the task (D-102). */
export async function untrackedStates(ctx: ModuleContext): Promise<ReadonlyMap<string, string>> {
	const listed = await listUntracked(ctx);
	// Outside a repository there is nothing to list; any other failure makes the developer's new files read as the task's.
	if (!listed.ok && !notARepository(listed)) ctx.log(`could not list the new files as the task began: ${listed.error}`);
	const files = (listed.ok ? listed.files : []).filter((file) => !isByproduct(file));
	const states = await Promise.all(
		files.map(async (file) => [file, await fileState(resolve(ctx.cwd, file), statOnly())] as const),
	);
	return new Map(states);
}

/** The new files that are not as they were when the task started: the task's, not the developer's. */
export async function newSinceStart(
	ctx: ModuleContext,
	files: readonly string[],
	atStart: ReadonlyMap<string, string>,
): Promise<string[]> {
	const kept = await Promise.all(
		files.map(async (file) => {
			const before = atStart.get(file);
			return before === undefined || before !== (await fileState(resolve(ctx.cwd, file), statOnly()));
		}),
	);
	return files.filter((_, index) => kept[index]);
}

/** What a file is now, in a few bytes: its content's hash, or that it is gone, a link, a directory or too big to read. */
async function fileState(path: string, budget: { files: number; bytes: number }): Promise<string> {
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink()) return `link:${await readlink(path)}`;
		if (!stat.isFile()) return "other";
		if (budget.files <= 0 || stat.size > Math.min(MAX_HASHED_FILE_BYTES, budget.bytes)) {
			return `stat:${stat.size}:${stat.mtimeMs}`;
		}
		budget.files -= 1;
		budget.bytes -= stat.size;
		return createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	} catch {
		return "absent";
	}
}

/**
 * A fingerprint of what the working tree holds that the commit `ref` did not: every file that
 * differs from `ref`, and every file git does not track or ignore, each by its content.
 *
 * It does not change when the agent commits (the old one hashed `git diff HEAD`, which a commit
 * empties, so every test run before a commit looked stale), and a new file counts the same before
 * and after it is added. It does change when any such file's content does, shown to the judge or
 * not. Without `ref` (a repository with no commit yet) every tracked file is hashed.
 *
 * What test and build runs leave behind ({@link isByproduct}) is left out: a test run is not progress.
 *
 * Undefined outside a git repository or when git fails. Never rejects. With a `signal` (a
 * background job) git has no time limit.
 */
export async function workspaceFingerprint(
	ctx: ModuleContext,
	ref: string | undefined,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const top = await git(ctx, "rev-parse --show-toplevel", signal ? { signal } : {});
		const root = top.ok ? top.out.trim() : "";
		if (root === "") return undefined;
		const [changed, untracked] = await Promise.all([
			// Paths from `git diff` are relative to the repository's root, those from `ls-files` to the directory.
			isCommitId(ref)
				? gitPaths(ctx, `diff --name-only -z --no-renames ${ref} --`, signal)
				: gitPaths(ctx, "ls-files -z --full-name", signal),
			untrackedFiles(ctx, signal),
		]);
		if (!changed || !untracked) return undefined;
		const made = untracked.filter((path) => !isByproduct(path));
		const paths = [
			...new Set([...changed.map((path) => join(root, path)), ...made.map((path) => resolve(ctx.cwd, path))]),
		].sort();
		const hash = createHash("sha256");
		const budget = { files: MAX_HASHED_FILES, bytes: MAX_HASHED_BYTES };
		for (const path of paths) hash.update(`${path}\0${await fileState(path, budget)}\0`);
		return hash.digest("hex").slice(0, 16);
	} catch {
		return undefined;
	}
}

export interface NewFiles {
	/** One "new file" diff per file shown, as `git diff` would print it once the file is added. */
	readonly diffs: readonly string[];
	/** New files whose content is not in `diffs`. */
	readonly notShown: number;
}

/** A path as a diff header can carry it on one line. */
const headerPath = (path: string) => [...path].map((char) => (char < " " || char === "\x7f" ? "?" : char)).join("");

async function sizeOf(path: string): Promise<number> {
	try {
		return (await lstat(path)).size;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

/** The first `maxBytes` of a file and its full size, or undefined when it is not a regular, readable file. */
async function readStart(path: string, maxBytes: number): Promise<{ bytes: Buffer; size: number } | undefined> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile()) return undefined;
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return { bytes: buffer.subarray(0, bytesRead), size: stat.size };
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

async function newFileDiff(cwd: string, file: string, maxBytes: number): Promise<string | undefined> {
	const read = await readStart(resolve(cwd, file), maxBytes);
	if (!read) return undefined;
	const name = headerPath(file);
	const header = `diff --git a/${name} b/${name}\nnew file mode 100644\n`;
	if (read.bytes.includes(0)) return `${header}Binary file, ${read.size} bytes`;
	const cut = read.size > read.bytes.length;
	const text = read.bytes.toString("utf8");
	// A cut may have landed inside a line (or a character): show whole lines only.
	const lastBreak = text.lastIndexOf("\n");
	const lines = (cut && lastBreak > 0 ? text.slice(0, lastBreak) : text.replace(/\n$/, "")).split("\n");
	const body = text === "" ? [] : lines.map((line) => `+${line}`);
	const note = cut
		? [`… (this new file is ${read.size} bytes; only its first ${lines.length} lines are shown, the rest is not shown)`]
		: [];
	return [`${header}--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${body.length} @@`, ...body, ...note].join("\n");
}

/**
 * Untracked files as "new file" diffs, so the verdict and the warning signals see their content.
 *
 * Which files: those the agent wrote with its file tools first (`touched`), then the smallest, up
 * to `maxFiles`; the caller says how many were left out. How much of each: up to `maxBytes`, with
 * a line saying so when the file is longer; the evidence's own per-file sharing (`fitDiff`) cuts
 * further and marks that too. The first twelve files in `ls-files` order, each cut silently at
 * 6,000 characters, was what the judge used to see.
 */
export async function newFileDiffs(
	cwd: string,
	files: readonly string[],
	options: { readonly touched: readonly string[]; readonly maxFiles: number; readonly maxBytes: number },
): Promise<NewFiles> {
	const touched = new Set(options.touched.map((path) => resolve(cwd, path)));
	const sized = await Promise.all(
		files.slice(0, MAX_NEW_FILES_SIZED).map(async (file) => {
			const path = resolve(cwd, file);
			return { file, touched: touched.has(path), size: await sizeOf(path) };
		}),
	);
	const chosen = sized
		.sort((x, y) => Number(y.touched) - Number(x.touched) || x.size - y.size)
		.slice(0, options.maxFiles);
	const diffs: string[] = [];
	for (const { file } of chosen) {
		const diff = await newFileDiff(cwd, file, options.maxBytes).catch(() => undefined);
		if (diff !== undefined) diffs.push(diff);
	}
	return { diffs, notShown: files.length - diffs.length };
}
