import { type Dirent, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A tool's `path` argument as pi resolves it: `@` dropped, `~` expanded, relative to the workspace. */
export function resolveToolPath(path: string, cwd: string): string {
	const bare = path.startsWith("@") ? path.slice(1) : path;
	if (bare === "~") return homedir();
	if (bare.startsWith("~/")) return join(homedir(), bare.slice(2));
	return isAbsolute(bare) ? bare : resolve(cwd, bare);
}

/** The path as the model should write it: from the workspace root when inside it. */
export function shownPath(absolute: string, cwd: string): string {
	const rel = relative(cwd, absolute);
	return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? absolute : rel;
}

/** A tool's input path, if it has one. */
export function inputPath(input: { readonly [key: string]: unknown }): string | undefined {
	const path = input["path"] ?? input["file_path"];
	return typeof path === "string" && path !== "" ? path : undefined;
}

const SKIPPED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", ".venv", "venv", "__pycache__"]);
/** Files looked at when searching for a missing one: enough for a large repo's sources, not a home directory. */
const MAX_FILES_SCANNED = 20_000;

/**
 * Existing files the model may have meant by a path that does not exist, closest first: the same
 * name elsewhere in the workspace, then names in the nearest existing directory that differ by a
 * few characters. Empty when nothing is close; never throws.
 */
export function nearestPaths(missing: string, cwd: string, max: number): string[] {
	const name = basename(missing);
	const found = new Map<string, number>();
	const consider = (path: string, distance: number) => {
		const shown = shownPath(path, cwd);
		const known = found.get(shown);
		if (known === undefined || distance < known) found.set(shown, distance);
	};
	// Siblings in the nearest directory that exists.
	let dir = dirname(missing);
	while (!isDirectory(dir) && dirname(dir) !== dir) dir = dirname(dir);
	for (const entry of listDir(dir)) {
		const distance = editDistance(entry.toLowerCase(), name.toLowerCase());
		if (distance <= Math.max(2, Math.floor(name.length / 4))) consider(join(dir, entry), distance);
	}
	// The same file name anywhere in the workspace, when the path is inside it.
	if (!relative(cwd, missing).startsWith("..")) {
		for (const path of walk(cwd)) if (basename(path) === name) consider(path, 1);
	}
	return [...found.entries()]
		.filter(([path]) => path !== shownPath(missing, cwd))
		.sort((a, b) => a[1] - b[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
		.slice(0, max)
		.map(([path]) => path);
}

function isDirectory(path: string): boolean {
	try {
		readdirSync(path);
		return true;
	} catch {
		return false;
	}
}

function listDir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

/** Files under `root`, breadth first, skipping build and dependency directories, up to a limit. */
function walk(root: string): string[] {
	const files: string[] = [];
	const queue = [root];
	while (queue.length > 0 && files.length < MAX_FILES_SCANNED) {
		const dir = queue.shift() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = dir.endsWith(sep) ? `${dir}${entry.name}` : `${dir}${sep}${entry.name}`;
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push(path);
			} else files.push(path);
		}
	}
	return files;
}

/** Levenshtein distance, for short names. */
export function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}
