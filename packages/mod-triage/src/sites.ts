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
const CONTEXT_LINES = 5;
const MAX_FILE_BYTES = 512_000;
const MAX_LINE_CHARS = 200;

/**
 * The first places in workspace files that the text points at, in the order it names them
 * (D-073, after aider's lint report, which finds `file:line` in the output and shows the code
 * there). A place outside the workspace (a library frame) or within a few lines of one already
 * taken is skipped.
 */
export function errorSites(text: string, cwd: string, max: number): ErrorSite[] {
	const sites: ErrorSite[] = [];
	for (const match of text.matchAll(SITE)) {
		if (sites.length >= max) break;
		const named = match[1] ?? match[3] ?? "";
		const line = Number(match[2] ?? match[4]);
		const path = relative(cwd, isAbsolute(named) ? named : join(cwd, named));
		if (path === "" || path.startsWith("..") || !isSmallFile(join(cwd, path))) continue;
		if (sites.some((s) => s.path === path && Math.abs(s.line - line) <= CONTEXT_LINES)) continue;
		sites.push({ path, line });
	}
	return sites;
}

/** The code around each site as it is now, numbered, with the line the output named marked. */
export function renderSites(sites: readonly ErrorSite[], cwd: string): string {
	return sites
		.flatMap((site) => {
			const lines = read(join(cwd, site.path))?.split("\n");
			if (!lines || site.line < 1 || site.line > lines.length) return [];
			const from = Math.max(1, site.line - CONTEXT_LINES);
			const to = Math.min(lines.length, site.line + CONTEXT_LINES);
			const shown = lines.slice(from - 1, to).map((text, i) => {
				const n = from + i;
				return `${n === site.line ? ">" : " "} ${String(n).padStart(4)} | ${text.slice(0, MAX_LINE_CHARS)}`;
			});
			return [`${site.path} (line ${site.line}):\n${shown.join("\n")}`];
		})
		.join("\n\n");
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
