import { detailShare, type Failure } from "./detail.ts";

/** What identifies a problem (D-072, D-109): the key of its error line, and the names it mentioned. */
export interface Problem {
	readonly signature: string;
	readonly detail: readonly string[];
}

/**
 * Whether `known`'s problem is in a failure: one of the failure's lines has its key, and the
 * failure mentions at least `minDetail` of the names `known` was recorded with. The failure may
 * mention more: it can hold several problems. A problem recorded with no names is matched only
 * by the failure's own first error (D-109): its key alone, anywhere in a long output, says too little.
 */
export function problemIn(known: Problem, failure: Failure, minDetail: number): boolean {
	if (!failure.keys.has(known.signature)) return false;
	if (known.detail.length === 0) return failure.anchor === known.signature;
	return detailShare(known.detail, failure.names) >= minDetail;
}

/** Whether two recorded problems are one: the same key, and each has most of the other's names. */
export function sameProblem(a: Problem, b: Problem, minDetail: number): boolean {
	return (
		a.signature === b.signature &&
		detailShare(a.detail, new Set(b.detail)) >= minDetail &&
		detailShare(b.detail, new Set(a.detail)) >= minDetail
	);
}
