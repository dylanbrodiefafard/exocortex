import { isAbsolute, relative, resolve } from "node:path";

/**
 * A tool's path as a path inside the repo (`src/lib.rs` for `/work/repo/src/lib.rs` or
 * `./src/lib.rs`), or undefined when it points outside the working directory: a scratch file in
 * `/tmp` or another checkout is not part of what was fixed here.
 */
export function repoPath(cwd: string, path: string): string | undefined {
	const inside = relative(cwd, resolve(cwd, path));
	return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? undefined : inside;
}
