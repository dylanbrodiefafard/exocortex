export function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function oneLine(text: string, max = 80): string {
	return clip(text.replace(/\s+/g, " ").trim(), max);
}

/**
 * Text that will be shown to the agent inside a memory note, made unable to pose as anything else
 * (M8): one line, so it cannot start a note or a header of its own; no `[exo …` opener, which is
 * how Exocortex's own messages begin; none of the `<<<` / `>>>` fences the sidecar prompts use.
 * Applied when a lesson is stored and again when it is shown, since the store may hold older text.
 */
export function inert(text: string): string {
	return text
		.replace(/<{3,}|>{3,}/g, " ")
		.replace(/\[(?=\s*exo\b)/gi, "(")
		.replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Text quoted inside a `<<<` … `>>>` block of a sidecar prompt: it cannot close the block. */
export function fenced(text: string): string {
	return text.replace(/<{3,}/g, (m) => "‹".repeat(m.length)).replace(/>{3,}/g, (m) => "›".repeat(m.length));
}
