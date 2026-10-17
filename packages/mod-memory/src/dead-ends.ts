import type { Card } from "./store.ts";

/** Dead ends named on one card. */
const MAX_DEAD_ENDS = 4;

/**
 * The files after whose edits a card's problem came back, read from its evidence: one JSON object
 * per fix, merged fixes joined by `---` (`store.ts`). Evidence is untrusted and may be from an
 * older version or cut short, so anything that does not parse is skipped.
 */
export function deadEndsIn(card: Pick<Card, "evidence">): string[] {
	const found = new Set<string>();
	for (const part of card.evidence.split("\n---\n")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(part);
		} catch {
			continue;
		}
		const list =
			typeof parsed === "object" && parsed !== null ? (parsed as { deadEnds?: unknown }).deadEnds : undefined;
		if (!Array.isArray(list)) continue;
		for (const path of list) if (typeof path === "string" && path !== "") found.add(path);
	}
	return [...found].slice(0, MAX_DEAD_ENDS);
}
