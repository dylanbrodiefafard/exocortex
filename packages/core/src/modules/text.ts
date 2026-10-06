/** How {@link startAndEnd} splits its room, and what it writes where the middle was. */
export interface StartAndEndOptions {
	/** The line that stands for the middle. It must say that something is gone: the reader is a model. */
	readonly mark?: string;
	/** The share of `max` the start gets; the end gets the rest. */
	readonly startShare?: number;
}

/**
 * `text` within `max` characters for a sidecar to read: a long one keeps its start and its end,
 * with a line of its own between them that says the middle is gone (D-089). A request states the
 * task first and its constraints often last; a reply puts what it delivers first and what it asks
 * last. Never cut a text a sidecar judges without saying so: what it cannot see it reads as absent.
 */
export function startAndEnd(text: string, max: number, options: StartAndEndOptions = {}): string {
	if (text.length <= max) return text;
	const start = Math.floor(max * (options.startShare ?? 2 / 3));
	return `${text.slice(0, start)}\n${options.mark ?? "[…]"}\n${text.slice(text.length - (max - start))}`;
}
