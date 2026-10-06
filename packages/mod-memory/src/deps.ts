import type { ModuleContext } from "@exocortex/core";
import type { RepoScope } from "./scope.ts";
import type { MemorySettings } from "./settings.ts";
import type { MemoryStore } from "./store.ts";

export const MEMORY_ID = "memory";

/** What every part of the module works with: one store, one repo, one session. */
export interface MemoryDeps {
	readonly ctx: ModuleContext;
	readonly settings: MemorySettings;
	readonly store: MemoryStore;
	/** Repo identity (D-018), resolved once per instance. Never rejects. */
	readonly scope: Promise<RepoScope>;
	/** The scope once it is resolved, for the places that cannot wait (a command's reply). */
	readonly resolvedScope: () => RepoScope | undefined;
	/** A part's state changed in a way worth keeping across a rebuild of the module (M9). */
	readonly changed: () => void;
}
