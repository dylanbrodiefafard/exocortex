/** `setTimeout` fires at once for a longer delay. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Runs `fn` under a deadline, so that nothing it does can hold the caller (AGENTS.md: an
 * Exocortex bug must never stall a pi session).
 *
 * - `fn` gets a signal that aborts after `ms`, or as soon as `parent` aborts.
 * - The result is `fn`'s value, or `undefined` from the moment that signal aborts, whether or not
 *   `fn` honours it. With `parent` already aborted, or no time to give, `fn` is not called.
 * - Never rejects: a throw or rejection from `fn` goes to `onError`, also when it comes after the
 *   deadline, so no promise is left to reject unhandled.
 */
export function withBudget<T>(
	ms: number,
	parent: AbortSignal | undefined,
	fn: (signal: AbortSignal) => T | undefined | Promise<T | undefined>,
	onError: (error: unknown) => void,
): Promise<T | undefined> {
	return new Promise((resolve) => {
		if (parent?.aborted || !(ms > 0)) {
			resolve(undefined);
			return;
		}
		const controller = new AbortController();
		const finish = (value: T | undefined): void => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", stop);
			resolve(value);
		};
		const stop = (): void => {
			controller.abort();
			finish(undefined);
		};
		const fail = (error: unknown): void => {
			try {
				onError(error);
			} catch {
				// The error reporter failed: there is nobody left to tell.
			}
			finish(undefined);
		};
		const timer = setTimeout(stop, Math.min(ms, MAX_TIMER_MS));
		parent?.addEventListener("abort", stop, { once: true });
		try {
			Promise.resolve(fn(controller.signal)).then(finish, fail);
		} catch (error) {
			fail(error);
		}
	});
}

/** The time left until `deadline` (epoch ms), never negative. */
export function remainingMs(deadline: number): number {
	return Math.max(0, deadline - Date.now());
}
