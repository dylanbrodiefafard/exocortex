import type { ModuleContext } from "@exocortex/core";
import { parseDiff } from "./signals.ts";

/** Symbols whose other uses are looked up; the rest of a large change is left to the diff. */
const MAX_SYMBOLS = 6;
/** Uses shown per symbol. */
const MAX_USES = 8;
const USE_LINE_CHARS = 200;
/** A name this short matches too much to be worth a search. */
const MIN_NAME_CHARS = 3;
const GREP_TIMEOUT_MS = 10_000;
const GREP_OUTPUT_CHARS = 64 * 1024;

/** Lines that declare a function or method, and the name they declare, by language family. */
const DECLARATIONS: readonly RegExp[] = [
	// JS/TS `function name(`, `function* name(`
	/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/,
	// Python `def`, Rust `fn`, Go `func` (with a receiver)
	/\b(?:def|fn|func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[(<[]/,
	// JS/TS `const name = (…) =>` and `const name = async x =>`
	/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/,
	// A method: `name(…) {`, with modifiers, in a class or object
	/^\s*(?:(?:public|private|protected|static|async|override|readonly|export|virtual|inline)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{\s*$/,
];
const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor", "else"]);

/** The name a line declares as a function or method, or undefined. */
export function declaredName(line: string): string | undefined {
	for (const pattern of DECLARATIONS) {
		const name = pattern.exec(line)?.[1];
		if (name !== undefined && !NOT_NAMES.has(name)) return name;
	}
	return undefined;
}

/**
 * Functions whose declaration the change rewrote or removed: a caller written against the old one
 * may now be wrong, and the diff does not show it. A declaration whose line is unchanged elsewhere
 * in the diff only moved.
 */
export function changedSignatures(diff: string): string[] {
	const names = new Set<string>();
	for (const file of parseDiff(diff)) {
		const added = new Set(file.added.map((line) => line.trim()));
		for (const line of file.removed) {
			const name = declaredName(line);
			if (name !== undefined && name.length >= MIN_NAME_CHARS && !added.has(line.trim())) names.add(name);
		}
	}
	return [...names].slice(0, MAX_SYMBOLS);
}

/**
 * Where each name is used in the workspace now, outside the lines the change added: what a
 * reviewer needs to see that a caller was left behind. `git grep`, whole words, tracked and
 * untracked files that are not ignored. Undefined when nothing was found or git is unavailable.
 */
export async function usesOf(
	ctx: ModuleContext,
	names: readonly string[],
	diff: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (names.length === 0) return undefined;
	const added = new Set(parseDiff(diff).flatMap((file) => file.added.map((line) => line.trim())));
	const sections: string[] = [];
	for (const name of names) {
		if (signal?.aborted) break;
		// `name` is a word (`declaredName`): safe in a shell command as it is.
		const out = await ctx.runCommand(`git -c core.quotePath=false grep --untracked -n -I -w -F -e ${name} -- .`, {
			timeoutMs: GREP_TIMEOUT_MS,
			tailChars: GREP_OUTPUT_CHARS,
			...(signal ? { signal } : {}),
		});
		// `git grep` exits 1 when nothing matches.
		if (out.exitCode !== 0) continue;
		const uses = out.outputTail
			.split("\n")
			.filter((line) => line.trim() !== "")
			.filter((line) => {
				const text = line.replace(/^[^:]*:\d+:/, "").trim();
				return !added.has(text) && declaredName(text) !== name;
			});
		if (uses.length === 0) continue;
		const shown = uses.slice(0, MAX_USES).map((line) => clip(line, USE_LINE_CHARS));
		const more = uses.length > MAX_USES ? [`… (${uses.length - MAX_USES} more not shown)`] : [];
		sections.push([`\`${name}\`:`, ...shown, ...more].join("\n"));
	}
	return sections.length === 0 ? undefined : sections.join("\n\n");
}

function clip(text: string, chars: number): string {
	return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}
