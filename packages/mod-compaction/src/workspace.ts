import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { ModuleContext } from "@exocortex/core";

/**
 * What git says of the working tree, and one spelling per file (D-085): every path is named as
 * the agent names it in a tool call, relative to the harness's working directory.
 */

const GIT_TIMEOUT_MS = 5_000;
/** `runCommand` keeps the end of the output: a listing this long may have lost its start, and is not used. */
const MAX_GIT_OUTPUT_CHARS = 400_000;
/** More paths than this dirty when the session starts, and the start is not recorded. */
const MAX_BASELINE_PATHS = 200;

interface Change {
	readonly state: "modified" | "new" | "deleted" | "renamed" | "unmerged";
	/** For a rename, the path it had. */
	readonly from?: string;
	/** `git diff --numstat` against HEAD: "+2 −0", or "binary". */
	readonly stat?: string;
	/** Changes when the file's state does: its status, size and modification time. */
	readonly print: string;
}

export interface Workspace {
	/** How many directories the repository's root is above the working directory. */
	readonly up: number;
	/** Every path git reports as changed or untracked, by its path from the working directory. */
	readonly changes: ReadonlyMap<string, Change>;
}

/** The dirty paths of a tree and each one's {@link Change.print}, as kept in the module's state. */
export type Baseline = { readonly [path: string]: string };

type Context = Pick<ModuleContext, "cwd" | "runCommand">;

/**
 * A path from a tool call or from the harness, as one spelling: relative to the working directory
 * when it is inside it (or inside the repository, `up` directories above), otherwise absolute.
 */
export function workspacePath(raw: string, cwd: string, up = 0): string {
	let path = raw.startsWith("@") ? raw.slice(1) : raw;
	if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
	if (!isAbsolute(path)) return normalize(path);
	for (const base of new Set([cwd, real(cwd)])) {
		const from = relative(base, path);
		const above = from.split("/").filter((part) => part === "..").length;
		if (from !== "" && !isAbsolute(from) && above <= up) return from;
	}
	return normalize(path);
}

/** The directory behind its symbolic links: a tool may report either spelling. */
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * The working tree against HEAD. Undefined when the directory is not in a git repository, git
 * failed or timed out, or the listing was too long to be whole. Never rejects.
 */
export async function readWorkspace(ctx: Context): Promise<Workspace | undefined> {
	const run = (command: string) =>
		ctx
			.runCommand(`git --no-optional-locks ${command} 2>/dev/null`, {
				timeoutMs: GIT_TIMEOUT_MS,
				tailChars: MAX_GIT_OUTPUT_CHARS,
			})
			.then(
				(out) => (out.exitCode === 0 && out.outputTail.length < MAX_GIT_OUTPUT_CHARS ? out.outputTail : undefined),
				() => undefined,
			);
	const [prefixLine, status, numstat] = await Promise.all([
		run("rev-parse --show-prefix"),
		run("status --porcelain=v1 -z --untracked-files=all"),
		// Without rename detection a renamed file is two entries, each with a plain path.
		run("diff --numstat -z --no-renames HEAD"),
	]);
	if (prefixLine === undefined || status === undefined) return undefined;
	const prefix = prefixLine.replace(/\n$/, "");
	const fromCwd = (path: string) => relative(prefix, path);
	const stats = parseNumstat(numstat ?? "", fromCwd);
	const changes = new Map<string, Change>();
	const records = status.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		const path = fromCwd(record.slice(3));
		// A rename or a copy is followed by the path it came from.
		const from = /[RC]/.test(code) ? fromCwd(records[++i] ?? "") : undefined;
		changes.set(path, changeOf(code, from, stats.get(path), resolve(ctx.cwd, path)));
	}
	return { up: prefix === "" ? 0 : prefix.replace(/\/$/, "").split("/").length, changes };
}

/** `git diff --numstat -z` as "+added −removed" per path. */
function parseNumstat(numstat: string, fromCwd: (path: string) => string): Map<string, string> {
	const stats = new Map<string, string>();
	for (const record of numstat.split("\0")) {
		const [added, removed, path] = record.split("\t");
		if (path && added !== undefined && removed !== undefined) {
			stats.set(fromCwd(path), added === "-" ? "binary" : `+${added} −${removed}`);
		}
	}
	return stats;
}

function changeOf(code: string, from: string | undefined, stat: string | undefined, file: string): Change {
	const state = stateOf(code);
	const renamed = state === "renamed";
	return {
		state,
		...(renamed && from !== undefined ? { from } : {}),
		// A rename's numbers are split over its two paths: none is shown.
		...(renamed || stat === undefined ? {} : { stat }),
		print: `${code}:${fileStamp(file)}`,
	};
}

/** A porcelain v1 status code (`XY`: index, then working tree) as what happened to the file. */
function stateOf(code: string): Change["state"] {
	if (code.includes("U") || code === "AA" || code === "DD") return "unmerged";
	if (code.includes("D")) return "deleted";
	if (code.includes("R")) return "renamed";
	return code === "??" || code.includes("A") || code.includes("C") ? "new" : "modified";
}

function fileStamp(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "gone";
	}
}

/**
 * The tree's dirty paths now, to tell the session's changes from what was there before it.
 * Undefined when that cannot be known: no repository, or more dirty paths than are worth keeping.
 */
export async function readBaseline(ctx: Context): Promise<Baseline | undefined> {
	const workspace = await readWorkspace(ctx);
	if (!workspace || workspace.changes.size > MAX_BASELINE_PATHS) return undefined;
	return Object.fromEntries([...workspace.changes].map(([path, change]) => [path, change.print]));
}

/** A baseline read back from saved state: undefined unless it is a map of paths to strings. */
export function parseBaseline(value: unknown): Baseline | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length <= 200,
	);
	return entries.length <= MAX_BASELINE_PATHS ? Object.fromEntries(entries) : undefined;
}
