import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** A place in a workspace file that a failing output points at. */
export interface ErrorSite {
	/** Relative to the workspace. */
	readonly path: string;
	readonly line: number;
}

/** `File "x.py", line 12` (Python) or `path/file.ext:12` (Rust, Go, C and C++, TypeScript). */
const SITE = /File "([^"\n]+)", line (\d+)|((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w-]+\.[A-Za-z]{1,5}):(\d+)/g;
/** Lines shown on each side of a site (D-108): enough to hold the function around it, mostly. */
const CONTEXT_LINES = 40;
const MAX_FILE_BYTES = 512_000;
const MAX_LINE_CHARS = 300;

/**
 * The first places in workspace files that the text points at, in the order it names them
 * (D-073, after aider's lint report, which finds `file:line` in the output and shows the code
 * there). A place outside the workspace (a library frame), or one already taken, is skipped.
 */
export function errorSites(text: string, cwd: string, max: number): ErrorSite[] {
	const sites: ErrorSite[] = [];
	for (const match of text.matchAll(SITE)) {
		if (sites.length >= max) break;
		const named = match[1] ?? match[3] ?? "";
		const line = Number(match[2] ?? match[4]);
		const path = relative(cwd, isAbsolute(named) ? named : join(cwd, named));
		if (path === "" || path.startsWith("..") || !isSmallFile(join(cwd, path))) continue;
		if (sites.some((s) => s.path === path && s.line === line)) continue;
		sites.push({ path, line });
	}
	return sites;
}

/**
 * The code around each site as it is now, numbered, with the lines the output named marked: the
 * sites in one file share one excerpt where their windows meet. Within `maxChars`, the first
 * sites first.
 */
export function renderSites(sites: readonly ErrorSite[], cwd: string, maxChars: number): string {
	const byFile = new Map<string, number[]>();
	for (const site of sites) byFile.set(site.path, [...(byFile.get(site.path) ?? []), site.line]);
	const parts: string[] = [];
	let left = maxChars;
	for (const [path, marked] of byFile) {
		const lines = read(join(cwd, path))?.split("\n");
		if (!lines) continue;
		for (const [from, to] of windows(marked, lines.length)) {
			const shown = lines.slice(from - 1, to).map((text, i) => {
				const n = from + i;
				return `${marked.includes(n) ? ">" : " "} ${String(n).padStart(4)} | ${text.slice(0, MAX_LINE_CHARS)}`;
			});
			const part = `${path} (lines ${from}-${to}):\n${shown.join("\n")}`;
			if (part.length > left)
				return [...parts, `(code at ${path}:${from}-${to} and after left out for length)`].join("\n\n");
			parts.push(part);
			left -= part.length;
		}
	}
	return parts.join("\n\n");
}

/** The line ranges shown around the marked lines of one file, merged where they meet. */
function windows(marked: readonly number[], length: number): [number, number][] {
	const out: [number, number][] = [];
	for (const line of [...marked].filter((n) => n >= 1 && n <= length).sort((a, b) => a - b)) {
		const from = Math.max(1, line - CONTEXT_LINES);
		const to = Math.min(length, line + CONTEXT_LINES);
		const previous = out.at(-1);
		if (previous && from <= previous[1] + 1) previous[1] = Math.max(previous[1], to);
		else out.push([from, to]);
	}
	return out;
}

function isSmallFile(path: string): boolean {
	try {
		const stat = statSync(path);
		return stat.isFile() && stat.size <= MAX_FILE_BYTES;
	} catch {
		return false;
	}
}

function read(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}
