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

/** Replaces every `{{name}}`; a placeholder without a value is a programming error. */
export function renderPrompt(template: string, vars: Readonly<Record<string, string>>, name = "prompt"): string {
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
		const value = vars[key];
		if (value === undefined) throw new Error(`${name}: no value for {{${key}}}`);
		return value;
	});
}
