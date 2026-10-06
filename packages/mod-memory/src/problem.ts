import { detailShare } from "./detail.ts";

/** What identifies a problem (D-072): the kind of failure, and the names it mentioned. */
export interface Problem {
	readonly signature: string;
	readonly detail: readonly string[];
}

/**
 * Whether `known`'s problem is in a failure: the same kind of failure, mentioning at least
 * `minDetail` of the names `known` was recorded with. The failure may mention more: it can hold
 * several problems.
 */
export function problemIn(
	known: Problem,
	signature: string | undefined,
	names: ReadonlySet<string>,
	minDetail: number,
): boolean {
	return known.signature === signature && detailShare(known.detail, names) >= minDetail;
}

/** Whether two recorded problems are one: each is in the other. */
export function sameProblem(a: Problem, b: Problem, minDetail: number): boolean {
	return (
		problemIn(a, b.signature, new Set(b.detail), minDetail) && problemIn(b, a.signature, new Set(a.detail), minDetail)
	);
}
