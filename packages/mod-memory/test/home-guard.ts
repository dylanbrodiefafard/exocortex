import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, expect } from "vitest";

/**
 * Keeps a test file away from the user's own memory store. Import it first in every test file of
 * this package. The default `dbPath` is `~/.exocortex/memory.db`; a test that reaches it (through
 * invalid settings, say) would open, migrate and write the user's real file.
 * - `HOME` points at a temp directory for the file's run, so the default path lands there.
 * - Reaching the default path at all is a failure: nothing may appear under the temp home.
 * - The real file, if there is one, must be as it was.
 */
const realStore = join(userInfo().homedir, ".exocortex", "memory.db");
const stamp = (): string => (existsSync(realStore) ? `${statSync(realStore).mtimeMs}:${statSync(realStore).size}` : "");
const before = stamp();
const fakeHome = mkdtempSync(join(tmpdir(), "exo-home-"));
const realHome = process.env["HOME"];
process.env["HOME"] = fakeHome;

afterAll(() => {
	const reached = existsSync(join(fakeHome, ".exocortex"));
	rmSync(fakeHome, { recursive: true, force: true });
	if (realHome === undefined) delete process.env["HOME"];
	else process.env["HOME"] = realHome;
	expect(reached, "a test opened the default memory store (~/.exocortex)").toBe(false);
	expect(stamp(), "a test changed the user's own memory store").toBe(before);
});
