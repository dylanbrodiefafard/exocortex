/**
 * What went wrong this session, where the user can see it (D-106). Errors caught in hooks and the
 * notes modules log about what they could not do used to reach only the debug stream, which is
 * off unless `EXO_DEBUG` is set: a summary that failed, a check that timed out or a lesson that
 * was never written looked the same as nothing to do. `/exo status` lists the latest.
 */
interface Problem {
	readonly at: number;
	/** The hook or module, e.g. `supervisor` or `modules.rewrite`. */
	readonly where: string;
	readonly message: string;
	/** An error caught in a hook, rather than a module's note on something it did not do. */
	readonly error: boolean;
}

export interface Problems {
	add(where: string, message: string, error: boolean): void;
	/** The latest, newest last. */
	recent(count: number): readonly Problem[];
	/** Everything added since the session began, not only what is kept. */
	counts(): { readonly errors: number; readonly notes: number };
	/** A new session: start over. */
	clear(): void;
}

/** How many are kept; the counts go on past it. */
const KEPT = 50;
/** A message longer than this is cut: a stack or a whole reply belongs in the debug stream. */
const MESSAGE_CHARS = 300;

export function createProblems(now: () => number = Date.now): Problems {
	let kept: Problem[] = [];
	let errors = 0;
	let notes = 0;
	return {
		add(where, message, error) {
			if (error) errors += 1;
			else notes += 1;
			const text = message.length > MESSAGE_CHARS ? `${message.slice(0, MESSAGE_CHARS)}…` : message;
			kept = [...kept.slice(-(KEPT - 1)), { at: now(), where, message: text, error }];
		},
		recent: (count) => kept.slice(-count),
		counts: () => ({ errors, notes }),
		clear() {
			kept = [];
			errors = 0;
			notes = 0;
		},
	};
}

/** The status lines for `/exo status`: counts, then the latest few, each with how long ago. */
export function problemLines(problems: Problems, now: number, count = 6): string[] {
	const { errors, notes } = problems.counts();
	if (errors + notes === 0) return ["problems: none this session"];
	const lines = [`problems: ${errors} error(s), ${notes} note(s) this session; latest:`];
	for (const p of problems.recent(count)) {
		lines.push(`  ${p.error ? "error" : "note"} · ${p.where} · ${ago(now - p.at)}: ${p.message}`);
	}
	return lines;
}

function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}
