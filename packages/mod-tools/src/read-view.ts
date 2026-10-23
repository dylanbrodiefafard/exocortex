import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { JsonValue } from "@exocortex/core";
import { resolveToolPath, shownPath } from "./paths.ts";

/**
 * Pi's note at the end of a read that stopped early (`read.js:129-142`): "Showing lines …" when
 * its size limit stopped it, "N more lines in file" when the read's own `limit` did.
 */
const CONTINUE_NOTE =
	/\n\n\[(?:Showing lines (\d+)-(\d+) of (\d+)[^\]\n]*|(\d+) more lines in file)\. Use offset=(\d+) to continue\.\]$/;
const MAX_OUTLINE_LINE_CHARS = 160;

/** What a numbered read looks like. */
export interface ReadView {
	readonly text: string;
	readonly numbered: boolean;
	readonly outlined: number;
	/** The file and content the outline was of: one is shown once a session. */
	readonly outlineKey?: string;
}

export interface ReadViewOptions {
	readonly numbers: boolean;
	readonly outline: boolean;
	readonly outlineMaxEntries: number;
	/** Outlines already shown, by {@link ReadView.outlineKey}. */
	readonly outlined: ReadonlySet<string>;
}

/**
 * A text `read` result with each line numbered (`cat -n` style: the number, a tab, the line), and,
 * when pi's size limit stopped the read before the end of the file, the declarations in the rest
 * of it with their line numbers, quoted from the file. A read its own `limit` stopped gets no
 * outline: the model chose what to see. Each file's outline is shown once while the
 * file is unchanged (D-110). Undefined for anything that is not a plain text read: an
 * image, an error, the note pi gives for a line too long to show (D-094).
 */
export function readView(
	input: { readonly [key: string]: JsonValue },
	output: string,
	cwd: string,
	options: ReadViewOptions,
): ReadView | undefined {
	if (output.startsWith("Read image file") || /^\[Line \d+ is .* exceeds .* limit/.test(output)) return undefined;
	const offset = input["offset"];
	const first = typeof offset === "number" && offset >= 1 ? Math.floor(offset) : 1;
	const note = CONTINUE_NOTE.exec(output);
	const body = note ? output.slice(0, note.index) : output;
	if (body === "") return undefined;
	const numbered = options.numbers ? numberLines(body, first) : body;
	const nextOffset = note ? Number(note[5]) : undefined;
	const outline =
		options.outline && nextOffset !== undefined && note?.[1] !== undefined
			? outlineFrom(input, nextOffset, cwd, options.outlineMaxEntries, options.outlined)
			: undefined;
	if (!options.numbers && !outline) return undefined;
	const parts = [numbered, ...(note ? [note[0].replace(/^\n\n/, "")] : []), ...(outline ? [outline.text] : [])];
	return {
		text: parts.join("\n\n"),
		numbered: options.numbers,
		outlined: outline?.entries ?? 0,
		...(outline ? { outlineKey: outline.key } : {}),
	};
}

/** Numbers lines from `first`; a file's final newline does not get a number of its own. */
export function numberLines(text: string, first: number): string {
	const lines = text.split("\n");
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	const width = String(first + lines.length - 1).length;
	return lines.map((line, i) => `${String(first + i).padStart(width)}\t${line}`).join("\n");
}

function outlineFrom(
	input: { readonly [key: string]: JsonValue },
	from: number,
	cwd: string,
	max: number,
	outlined: ReadonlySet<string>,
): { readonly text: string; readonly entries: number; readonly key: string } | undefined {
	const path = input["path"];
	if (typeof path !== "string") return undefined;
	const pattern = DECLARATIONS[extname(path).toLowerCase()];
	if (!pattern) return undefined;
	const absolute = resolveToolPath(path, cwd);
	let content: string;
	try {
		content = readFileSync(absolute, "utf8");
	} catch {
		return undefined;
	}
	const key = `${absolute}\0${createHash("sha1").update(content).digest("hex")}`;
	if (outlined.has(key)) return undefined;
	const lines = content.split(/\r?\n/);
	const found: string[] = [];
	for (let i = from - 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (pattern.test(line))
			found.push(
				`${i + 1}\t${line.length > MAX_OUTLINE_LINE_CHARS ? `${line.slice(0, MAX_OUTLINE_LINE_CHARS)}…` : line}`,
			);
	}
	if (found.length === 0) return undefined;
	const shown = found.slice(0, max);
	const more = found.length > max ? `\n(${found.length - max} more)` : "";
	return {
		text: `[exo tools] Declarations in the rest of ${shownPath(absolute, cwd)} (from line ${from}), verbatim:\n${shown.join("\n")}${more}`,
		entries: shown.length,
		key,
	};
}

/**
 * Lines that start a declaration, per file type: a line's own text is what is shown, so a line
 * that matches but is not one costs a line of outline, not a wrong claim.
 */
const RUST =
	/^\s*(pub(\([^)]*\))?\s+)?((async|const|unsafe|extern( "[^"]*")?)\s+)*(fn|struct|enum|trait|impl|mod|type|union|macro_rules!)\b/;
const GO = /^(func|type)\b/;
const PYTHON = /^\s*(async\s+def|def|class)\s+\w/;
const C_FAMILY =
	/^(?!\s*(if|for|while|switch|return|else|do|case|default)\b)(template\s*<.*>\s*)?((class|struct|enum|namespace|union)\s+\w+|[A-Za-z_][\w:<>,*&\s]*[\s*&]\w[\w:~]*\s*\([^;]*$)/;
const JS =
	/^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+[\w$]/;
const MARKDOWN = /^#{1,6}\s/;

const DECLARATIONS: Readonly<Record<string, RegExp>> = {
	".rs": RUST,
	".go": GO,
	".py": PYTHON,
	".pyi": PYTHON,
	".c": C_FAMILY,
	".h": C_FAMILY,
	".cc": C_FAMILY,
	".cpp": C_FAMILY,
	".cxx": C_FAMILY,
	".hpp": C_FAMILY,
	".hh": C_FAMILY,
	".hxx": C_FAMILY,
	".ts": JS,
	".tsx": JS,
	".js": JS,
	".jsx": JS,
	".mjs": JS,
	".cjs": JS,
	".md": MARKDOWN,
};
