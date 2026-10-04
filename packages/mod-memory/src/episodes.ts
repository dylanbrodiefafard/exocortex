import { errorSignature, firstErrorLine, type ToolOutcome } from "@exocortex/core";

/** A verified error→fix pair (research R5.1/R5.2): a command failed, files changed, the same command passed. */
export interface FixEpisode {
	readonly command: string;
	readonly signature: string;
	readonly errorLine: string;
	/** The failing output around the first error. */
	readonly excerpt: string;
	readonly edits: readonly Edit[];
}

export interface Edit {
	readonly path: string;
	readonly before: string;
	readonly after: string;
}

interface OpenFailure {
	readonly signature: string;
	readonly errorLine: string;
	readonly excerpt: string;
	readonly edits: Edit[];
}

/** Commands whose success is external evidence that a fix worked: builds, tests, runs. */
const VERIFYING_COMMAND =
	/\b(pytest|unittest|python3?|cargo|go (test|build|vet|run)|ctest|make\b|cmake|g\+\+|clang\+\+|gcc|npm|npx|node|tsc|tox|\.\/\S+)/;
const MAX_EDITS = 8;
const EDIT_TEXT_CHARS = 400;
const EXCERPT_LINES = 8;

/**
 * Watches tool results for error→fix pairs. Only a failure followed by edits and then a success
 * of the *same* command counts: the success is the external signal (never the model's opinion).
 * If the error changes before the command passes, the episode restarts from the new error.
 */
export function createEpisodeTracker(): { observe(tool: ToolOutcome): FixEpisode | undefined; reset(): void } {
	const open = new Map<string, OpenFailure>();

	function onFailure(command: string, tool: ToolOutcome): void {
		const signature = errorSignature(tool.toolName, tool.exitCode, tool.output);
		if (open.get(command)?.signature === signature) return; // same error again: keep collecting edits
		const first = firstErrorLine(tool.output);
		if (first)
			open.set(command, {
				signature,
				errorLine: first.line,
				excerpt: excerptAround(tool.output, first.index),
				edits: [],
			});
		else open.delete(command);
	}

	function onSuccess(command: string): FixEpisode | undefined {
		const failure = open.get(command);
		open.delete(command);
		return failure && failure.edits.length > 0 ? { command, ...failure } : undefined;
	}

	return {
		observe(tool) {
			const edits = editOf(tool);
			if (edits) {
				for (const failure of open.values()) if (failure.edits.length < MAX_EDITS) failure.edits.push(...edits);
				return undefined;
			}
			const command = commandKey(tool);
			if (!command || !VERIFYING_COMMAND.test(command)) return undefined;
			if (tool.isError || (tool.exitCode !== null && tool.exitCode !== 0)) {
				onFailure(command, tool);
				return undefined;
			}
			return onSuccess(command);
		},
		reset() {
			open.clear();
		},
	};
}

function commandKey(tool: ToolOutcome): string | undefined {
	const command = tool.input["command"];
	return typeof command === "string" ? command.replace(/\s+/g, " ").trim().slice(0, 300) : undefined;
}

/** pi's `edit` ({path, edits: [{oldText, newText}]}) and `write` ({path, content}). */
function editOf(tool: ToolOutcome): Edit[] | undefined {
	if (tool.isError) return undefined;
	const path = tool.input["path"];
	if (typeof path !== "string") return undefined;
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

function excerptAround(output: string, index: number): string {
	const lines = output.split("\n");
	return lines
		.slice(Math.max(0, index - 1), index - 1 + EXCERPT_LINES)
		.map((l) => l.slice(0, 300))
		.join("\n");
}

function clip(text: string): string {
	return text.length > EDIT_TEXT_CHARS ? `${text.slice(0, EDIT_TEXT_CHARS)}…` : text;
}
