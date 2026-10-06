import { cleanTerminalOutput, lineVerdicts } from "@exocortex/core";

/**
 * Names that say nothing about which problem it was: what every failure of a kind prints, and
 * the pieces of common file names and library paths.
 */
const FILLER = new Set([
	...["error", "errors", "fail", "failed", "failure", "test", "tests", "main", "self", "none", "true", "false"],
	...["left", "right", "expected", "actual", "got", "want", "src", "lib", "mod", "std", "cpp", "hpp", "com"],
	...["assertionerror", "nil", "null", "usr", "bin", "the", "and", "not"],
]);

/** Text in quotes or backticks: compilers and test runners quote the names they talk about. */
const QUOTED = /["'`‘]([^"'`‘’\n]{1,120})["'`’]/g;
/** Looks like an identifier, not a word of a message: `snake_case`, `camelCase`, `E0502`, `ipv4`. */
const IDENTIFIER = /_|[a-z][A-Z]|[A-Za-z]\d/;

/** Error lines read for a card's detail: the start of the failure, where its first problem is. */
const CARD_DETAIL_LINES = 8;
/** Error lines read when asking whether a card's problem is in a failure: it may not come first. */
export const FAILURE_DETAIL_LINES = 80;
const MAX_CARD_WORDS = 24;

/**
 * The names a failing output mentions in its first `maxLines` failure lines (D-072): quoted text,
 * dotted or `::` paths (`tests.test_cli.DueDateTest`, `render.rs`) and identifier-like tokens.
 * An error signature normalizes most of these away so that one failure matches across attempts;
 * they are what tells two failures of the same kind apart. Plain words of the message are left
 * out: they are the same for every problem of the kind, and the signature already holds them.
 */
export function failureDetail(output: string, maxLines: number): string[] {
	const lines = cleanTerminalOutput(output).split("\n");
	// The lines that say the run failed (D-077), which are the ones the signature is read from. A
	// line a toolchain prints beside an error (a log line, a linker note) names things the problem
	// is not about.
	const kinds = lineVerdicts(lines).map((verdict) => (verdict === "mention" ? "generic" : verdict && "specific"));
	const wanted = kinds.includes("specific") ? "specific" : "generic";
	const names = new Set<string>();
	const add = (text: string) => {
		for (const word of text.toLowerCase().split(/[^a-z0-9_]+/)) {
			if (word.length >= 3 && !/^\d/.test(word) && !FILLER.has(word)) names.add(word);
		}
	};
	let taken = 0;
	for (const [index, line] of lines.entries()) {
		if (kinds[index] !== wanted) continue;
		if (++taken > maxLines) break;
		for (const match of line.matchAll(QUOTED)) add(match[1] ?? "");
		for (const chunk of line.split(/[^A-Za-z0-9_.:]+/)) {
			if (/\w(\.|::)\w/.test(chunk) || IDENTIFIER.test(chunk)) add(chunk);
		}
	}
	return [...names];
}

/** A card's detail: the first names of the failure it was learned from. */
export function cardDetail(output: string): string[] {
	return failureDetail(output, CARD_DETAIL_LINES).slice(0, MAX_CARD_WORDS);
}

/**
 * How much of a card's problem is in a failure: the share of the card's names the failure also
 * mentions. A card with no names (learned before D-072, or from an error that names nothing)
 * can only be matched by its signature, so it counts as present.
 */
export function detailShare(card: readonly string[], failure: ReadonlySet<string>): number {
	if (card.length === 0) return 1;
	return card.filter((word) => failure.has(word)).length / card.length;
}
