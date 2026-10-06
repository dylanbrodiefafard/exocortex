import type { ToolOutcome } from "./types.ts";

/** One change a file tool made: what was there and what replaced it, each cut to a length. */
export interface FileEdit {
	readonly path: string;
	readonly before: string;
	readonly after: string;
}

/**
 * The changes a successful file-tool call made: pi's `edit` ({path, edits: [{oldText, newText}]})
 * and `write` ({path, content}). Undefined for any other call, and for one that failed.
 */
export function fileEdits(tool: ToolOutcome, maxChars: number): FileEdit[] | undefined {
	if (tool.isError) return undefined;
	const path = tool.input["path"];
	if (typeof path !== "string") return undefined;
	const clip = (text: string) => (text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);
	const edits = tool.input["edits"];
	if (tool.toolName === "edit" && Array.isArray(edits)) {
		return edits.flatMap((e) => {
			if (typeof e !== "object" || e === null || Array.isArray(e)) return [];
			const { oldText, newText } = e as { oldText?: unknown; newText?: unknown };
			return typeof oldText === "string" && typeof newText === "string"
				? [{ path, before: clip(oldText), after: clip(newText) }]
				: [];
		});
	}
	if (tool.toolName === "write" && typeof tool.input["content"] === "string") {
		return [{ path, before: "(file rewritten)", after: clip(tool.input["content"]) }];
	}
	return undefined;
}
