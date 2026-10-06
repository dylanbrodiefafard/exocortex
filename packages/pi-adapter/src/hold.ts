import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The status-line slot Exocortex writes to. */
const STATUS_KEY = "exo";

/** What Exocortex shows the user while its hooks hold pi, and what stays on the status line after. */
export interface HoldUi {
	/**
	 * Runs a hook that holds pi. While it runs, {@link HoldUi.progress} messages go on the status
	 * line and next to pi's working spinner; both are restored when the last such hook returns.
	 */
	whileHolding<T>(ctx: ExtensionContext, hook: () => Promise<T>): Promise<T>;
	/** Says what the running hook is waiting on. Dropped when no hook is holding pi, or without a UI. */
	progress(message: string): void;
	/**
	 * Sets the status that stays once the hooks have returned (a settle's outcome); undefined
	 * clears it. Written at once, or when the holding hooks return if they have shown progress.
	 */
	settled(ctx: ExtensionContext, text: string | undefined): void;
}

export function createHoldUi(onError: (where: string, error: unknown) => void): HoldUi {
	/** The UI of the hooks now holding pi, how many there are, and whether one of them reported progress. */
	let holding: { ui: ExtensionContext["ui"]; hooks: number; shown: boolean } | undefined;
	/** The status the last settle left on the status line: progress replaces it only for a while. */
	let settledStatus: string | undefined;

	return {
		async whileHolding(ctx, hook) {
			if (!ctx.hasUI) return hook();
			holding = holding ?? { ui: ctx.ui, hooks: 0, shown: false };
			const held = holding;
			held.hooks += 1;
			try {
				return await hook();
			} finally {
				held.hooks -= 1;
				if (held.hooks === 0) {
					if (holding === held) holding = undefined;
					if (held.shown) {
						try {
							held.ui.setStatus(STATUS_KEY, settledStatus);
							held.ui.setWorkingMessage();
						} catch (error) {
							// A UI that went stale under the hook must not replace the hook's result.
							onError("modules.status", error);
						}
					}
				}
			}
		},

		progress(message) {
			if (!holding) return;
			holding.shown = true;
			holding.ui.setStatus(STATUS_KEY, `exo: ${message}`);
			holding.ui.setWorkingMessage(message);
		},

		settled(ctx, text) {
			settledStatus = text;
			if (holding?.shown) return;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
		},
	};
}
