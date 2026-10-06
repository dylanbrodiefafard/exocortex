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

const GIT_TIMEOUT_MS = 10_000;
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

/** A NUL-separated list of paths from git, or undefined when the command failed (not a repository). */
async function gitPaths(ctx: ModuleContext, args: string): Promise<string[] | undefined> {
	const out = await ctx
		.runCommand(`git -c core.quotePath=false ${args}`, { timeoutMs: GIT_TIMEOUT_MS, tailChars: LIST_CHARS })
		.catch(() => undefined);
	if (out?.exitCode !== 0 || out.timedOut) return undefined;
	const paths = out.outputTail.split("\0").filter(Boolean);
	// Only the end of a longer output is kept: its first entry may be half a name.
	return out.outputTail.length >= LIST_CHARS ? paths.slice(1) : paths;
}

/** Files git neither tracks nor ignores, relative to the working directory; undefined outside a repository. */
export function untrackedFiles(ctx: ModuleContext): Promise<string[] | undefined> {
	return gitPaths(ctx, "ls-files -z --others --exclude-standard");
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
 * Undefined outside a git repository or when git fails. Never rejects.
 */
export async function workspaceFingerprint(ctx: ModuleContext, ref: string | undefined): Promise<string | undefined> {
	try {
		const top = await ctx.runCommand("git rev-parse --show-toplevel", { timeoutMs: GIT_TIMEOUT_MS });
		const root = top.outputTail.trim();
		if (top.exitCode !== 0 || root === "") return undefined;
		const [changed, untracked] = await Promise.all([
			// Paths from `git diff` are relative to the repository's root, those from `ls-files` to the directory.
			isCommitId(ref)
				? gitPaths(ctx, `diff --name-only -z --no-renames ${ref} --`)
				: gitPaths(ctx, "ls-files -z --full-name"),
			untrackedFiles(ctx),
		]);
		if (!changed || !untracked) return undefined;
		const paths = [
			...new Set([...changed.map((path) => join(root, path)), ...untracked.map((path) => resolve(ctx.cwd, path))]),
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
