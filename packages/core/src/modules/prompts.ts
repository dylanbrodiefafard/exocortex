import { readFileSync } from "node:fs";

/**
 * A versioned sidecar prompt (brief §9: prompts live in files, not inline strings).
 * Files are Markdown with `{{name}}` placeholders; the version is part of the file name
 * (`verdict.v1.md`) so A/B runs can pin one.
 */
export interface PromptTemplate {
	readonly name: string;
	readonly text: string;
	render(vars: Readonly<Record<string, string>>): string;
}

export function loadPrompt(url: URL): PromptTemplate {
	const text = readFileSync(url, "utf8");
	const name = url.pathname.split("/").at(-1) ?? url.pathname;
	return { name, text, render: (vars) => renderPrompt(text, vars, name) };
}

/** A `<<<` … `>>>` block of a template: what a prompt quotes from the session goes between the two lines. */
const BLOCK = /^<<<\n([\s\S]*?)\n>>>$/gm;
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
/** A line that is nothing but a run of `<` or of `>`: what opens or closes a block. */
const FENCE_LINE = /^([ \t]*)(<{3,}|>{3,})([ \t]*)$/gm;

/**
 * Text quoted inside a `<<<` … `>>>` block of a sidecar prompt, made unable to close the block or
 * open another (D-081 M8, D-092): a line that is only `<<<` or `>>>` is written with look-alike
 * marks. Such a run inside a line is left as it is (`vector<vector<vector<int>>>`, `>>> x = 1`):
 * it closes nothing, and code a sidecar is asked about should reach it as written.
 */
export function fenced(text: string): string {
	return text.replace(
		FENCE_LINE,
		(_line, before: string, run: string, after: string) =>
			`${before}${(run.startsWith("<") ? "‹" : "›").repeat(run.length)}${after}`,
	);
}

/**
 * Replaces every `{{name}}`; a placeholder without a value is a programming error. A value that
 * goes inside a `<<<` … `>>>` block of the template is {@link fenced} here (D-092), so no caller
 * has to remember that the text it passes came from a user, an agent or a tool.
 */
export function renderPrompt(template: string, vars: Readonly<Record<string, string>>, name = "prompt"): string {
	const fill = (text: string, quoted: boolean) =>
		text.replace(PLACEHOLDER, (_match, key: string) => {
			const value = vars[key];
			if (value === undefined) throw new Error(`${name}: no value for {{${key}}}`);
			return quoted ? fenced(value) : value;
		});
	let rendered = "";
	let from = 0;
	for (const block of template.matchAll(BLOCK)) {
		rendered += `${fill(template.slice(from, block.index), false)}<<<\n${fill(block[1] ?? "", true)}\n>>>`;
		from = block.index + block[0].length;
	}
	return rendered + fill(template.slice(from), false);
}
