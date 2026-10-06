import type { ModuleContext } from "@exocortex/core";

const GIT_TIMEOUT_MS = 5_000;

/** Which repo a session is in (D-018). */
export interface RepoScope {
	/** `remote:host/owner/repo`, else `tree:<root commit's tree>`, else `path:<cwd>`. */
	readonly id: string;
	/**
	 * False when git did not answer in time: the repo may well have a remote, so the path would be
	 * a second name for it. Nothing is learned or recalled under a name that is a guess.
	 */
	readonly known: boolean;
}

/**
 * Repo identity (D-018): the origin remote in its normal form, else the root commit's tree (stable
 * across copies), else the path. A git that fails says "no remote" or "no commits"; one that
 * times out or cannot be run says nothing, and the scope is then unknown for the session.
 */
export async function repoScope(ctx: ModuleContext): Promise<RepoScope> {
	const unknown = { id: `path:${ctx.cwd}`, known: false };
	/** The command's output, "" when it failed, undefined when it did not answer. */
	const run = async (command: string): Promise<string | undefined> => {
		const out = await ctx.runCommand(command, { timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined);
		if (!out || out.timedOut || out.exitCode === null) return undefined;
		return out.exitCode === 0 ? out.outputTail.trim() : "";
	};
	const remote = await run("git remote get-url origin 2>/dev/null");
	if (remote === undefined) return unknown;
	if (remote) return { id: `remote:${normalizeRemote(remote)}`, known: true };
	const tree = await run('git rev-parse "$(git rev-list --max-parents=0 HEAD | tail -n 1)^{tree}" 2>/dev/null');
	if (tree === undefined) return unknown;
	return { id: tree ? `tree:${tree}` : `path:${ctx.cwd}`, known: true };
}

/**
 * One name for a remote however it was cloned: `git@github.com:Owner/Repo.git`,
 * `https://token@github.com/owner/repo/` and `ssh://git@github.com:22/owner/repo` are all
 * `github.com/owner/repo`. User names, tokens, ports and the scheme are dropped; hosts and their
 * paths are lower-cased (the forges treat them so). A local path stays a path, as written.
 */
export function normalizeRemote(url: string): string {
	const trimmed = url.trim();
	const tidy = (path: string) =>
		path
			.replace(/\/+$/, "")
			.replace(/\.git$/i, "")
			.replace(/\/+$/, "");
	const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]*@)?([^/:]*)(?::\d+)?(\/.*)?$/i.exec(trimmed);
	if (withScheme) {
		const [, , host = "", path = ""] = withScheme;
		if (host === "") return tidy(path);
		return `${host}/${tidy(path).replace(/^\/+/, "")}`.toLowerCase();
	}
	// scp-like: [user@]host:path, where the host has no slash.
	const scp = /^(?:[^/@:]*@)?([^/:@]+):(?!\/\/)(.+)$/.exec(trimmed);
	if (scp) return `${scp[1] ?? ""}/${tidy(scp[2] ?? "").replace(/^\/+/, "")}`.toLowerCase();
	return tidy(trimmed);
}
