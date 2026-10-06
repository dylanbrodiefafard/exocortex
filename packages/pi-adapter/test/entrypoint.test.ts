import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import exocortex from "../src/index.ts";
import { createFakePi } from "./fake-pi.ts";

let dir: string;
let debugFile: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-entry-"));
	debugFile = join(dir, "debug.log");
	const configPath = join(dir, "config.jsonc");
	writeFileSync(configPath, JSON.stringify({ trace: { enabled: false } }));
	vi.stubEnv("EXO_CONFIG", configPath);
	vi.stubEnv("EXO_DEBUG_FILE", debugFile);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

const debugLines = () => {
	try {
		return readFileSync(debugFile, "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
};

describe("extension entrypoint", () => {
	it("registers the flag, the /exo command and hooks without tracing by default", async () => {
		vi.stubEnv("EXO_DEBUG", "");
		const pi = createFakePi({ cwd: dir });
		exocortex(pi.api);
		expect(pi.commands.has("exo")).toBe(true);
		await pi.emit("session_start", { reason: "startup" });
		await pi.emit("agent_start");
		expect(debugLines()).toEqual([]);
	});

	it("logs one line per event with EXO_DEBUG=1, skipping high-frequency events", async () => {
		vi.stubEnv("EXO_DEBUG", "1");
		const pi = createFakePi({ cwd: dir });
		exocortex(pi.api);
		await pi.emit("agent_start");
		await pi.emit("message_update", { message: { role: "assistant" } });
		const lines = debugLines();
		expect(lines.some((l) => l.includes("agent_start"))).toBe(true);
		expect(lines.some((l) => l.includes("message_update"))).toBe(false);
	});

	it("verbose adds high-frequency events; the flag alone enables event logging", async () => {
		vi.stubEnv("EXO_DEBUG", "verbose");
		const verbose = createFakePi({ cwd: dir });
		exocortex(verbose.api);
		await verbose.emit("message_update", { message: { role: "assistant" } });
		expect(debugLines().some((l) => l.includes("message_update"))).toBe(true);

		vi.stubEnv("EXO_DEBUG", "");
		rmSync(debugFile);
		const flagged = createFakePi({ cwd: dir, flags: { "exo-debug": true } });
		exocortex(flagged.api);
		await flagged.emit("agent_start");
		expect(debugLines().some((l) => l.includes("agent_start"))).toBe(true);
	});

	it("keeps working once pi is stale: logging uses the last level and nothing throws (B1)", async () => {
		vi.stubEnv("EXO_DEBUG", "");
		const pi = createFakePi({ cwd: dir, flags: { "exo-debug": true } });
		exocortex(pi.api);
		await pi.emit("session_start", { reason: "startup" });
		// A session replacement or reload: from here `pi.getFlag` throws (PI_API_NOTES §14).
		pi.invalidate();
		// A hook error reported after that, as background work from the old session would.
		await pi.emit("turn_end", { turnIndex: 0, message: {}, toolResults: undefined });
		await pi.emit("session_shutdown", { reason: "reload" });
		const lines = debugLines();
		expect(lines.filter((l) => l.includes("exo.error where=turn_end"))).toHaveLength(1);
		expect(lines.some((l) => l.includes("session_shutdown"))).toBe(true);
	});

	it("never throws when the debug log cannot be written (B1)", async () => {
		vi.stubEnv("EXO_DEBUG", "1");
		// A directory: every write fails.
		vi.stubEnv("EXO_DEBUG_FILE", dir);
		const pi = createFakePi({ cwd: dir });
		exocortex(pi.api);
		await pi.emit("session_start", { reason: "startup" });
		await pi.emit("turn_end", { turnIndex: 0, message: {}, toolResults: undefined });
		await pi.emit("session_shutdown", { reason: "quit" });
	});

	it("logs swallowed hook errors as exo.error", async () => {
		vi.stubEnv("EXO_DEBUG", "1");
		const pi = createFakePi({ cwd: dir });
		exocortex(pi.api);
		await pi.emit("session_start", { reason: "startup" });
		await pi.emit("turn_end", { turnIndex: 0, message: {}, toolResults: undefined });
		expect(debugLines().some((l) => l.includes("exo.error"))).toBe(true);
	});
});
