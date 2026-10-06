import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiRpcProcess } from "../src/pi-rpc.ts";
import { type FakePiBehavior, fakePiEnv, writeFakePi } from "./fake-pi.ts";

let tmp = "";
let pi: PiRpcProcess | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "exo-rpc-"));
});

afterEach(async () => {
	await pi?.close();
	pi = undefined;
	rmSync(tmp, { recursive: true, force: true });
});

function start(behavior: FakePiBehavior, graceMs = 200, closeGraceMs?: number): PiRpcProcess {
	pi = new PiRpcProcess({
		cliPath: writeFakePi(tmp),
		cwd: tmp,
		args: [],
		env: fakePiEnv(behavior),
		stderrPath: join(tmp, "stderr.log"),
		graceMs,
		...(closeGraceMs === undefined ? {} : { closeGraceMs }),
	});
	return pi;
}

describe("PiRpcProcess limits", () => {
	it("settles a run that ends on its last allowed turn, instead of calling it max_turns", async () => {
		const result = await start({ turns: 3 }).prompt("go", { maxTurns: 3, timeoutMs: 5_000 });
		expect(result).toMatchObject({ outcome: "settled", turns: 3 });
	});

	it("reports max_turns when the agent starts a turn past the limit", async () => {
		const result = await start({ turns: 3, thenAnotherTurn: true }).prompt("go", { maxTurns: 3, timeoutMs: 5_000 });
		expect(result).toMatchObject({ outcome: "max_turns", turns: 3 });
	});

	it("does not wait for ever on a pi that never answers the prompt", async () => {
		const started = performance.now();
		const result = await start({ silent: true }, 4_000).prompt("go", { maxTurns: 3, timeoutMs: 300 });
		expect(result.outcome).toBe("crashed");
		expect(result.error).toContain("did not answer the prompt");
		expect(performance.now() - started).toBeLessThan(3_000);
		// The stuck process was killed, so closing does not have to wait out its grace period.
		const closing = performance.now();
		await pi?.close();
		expect(performance.now() - closing).toBeLessThan(2_000);
	});

	it("does not wait for ever on a pi that ignores the abort after a timeout", async () => {
		const started = performance.now();
		const result = await start({ neverSettle: true, ignoreAbort: true }).prompt("go", {
			maxTurns: 9,
			timeoutMs: 200,
		});
		expect(result).toMatchObject({ outcome: "timeout", turns: 1 });
		// One time limit, then one grace period for the abort: not the two the old code could take,
		// and never unbounded.
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("aborts cleanly when pi answers the abort", async () => {
		const result = await start({ neverSettle: true }).prompt("go", { maxTurns: 9, timeoutMs: 200 });
		expect(result.outcome).toBe("timeout");
	});

	it("reports a rejected prompt and a pi that dies as crashes, without throwing on the dead pipe", async () => {
		expect(await start({ rejectPrompt: true }).prompt("go", { maxTurns: 3, timeoutMs: 2_000 })).toMatchObject({
			outcome: "crashed",
			error: "prompt rejected: no model",
		});
		await pi?.close();
		const dead = start({ exitOnPrompt: 7 });
		const result = await dead.prompt("go", { maxTurns: 3, timeoutMs: 2_000 });
		expect(result.outcome).toBe("crashed");
		expect(result.error).toContain("pi exited (code=7");
		// Writing to the dead process must be a no-op, not an EPIPE that takes the suite down.
		expect(await dead.prompt("again", { maxTurns: 3, timeoutMs: 2_000 })).toMatchObject({ outcome: "crashed" });
	});

	it("does not wait for a run when an extension handled the prompt itself", async () => {
		const started = performance.now();
		const result = await start({ handled: true }).prompt("/exo status", { maxTurns: 3, timeoutMs: 5_000 });
		expect(result).toMatchObject({ outcome: "settled", turns: 0 });
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("sends an accepted editor suggestion back as the next prompt, within the same limits", async () => {
		const result = await start({ suggestOnce: "also do the rest" }).prompt("go", {
			maxTurns: 5,
			timeoutMs: 5_000,
			acceptSuggestions: true,
		});
		expect(result).toMatchObject({ outcome: "settled", turns: 2, acceptedSuggestions: 1 });
	});
});

describe("PiRpcProcess close (E2, D-086)", () => {
	const shutDown = () => existsSync(join(tmp, "shutdown-done"));

	it("gives pi's shutdown its own, longer grace than an abort gets", async () => {
		// The abort grace is 100 ms; pi's shutdown (a drain of background sidecar calls) takes 400.
		const process = start({ shutdownMs: 400 }, 100, 5_000);
		await process.prompt("go", { maxTurns: 3, timeoutMs: 5_000 });
		const started = performance.now();
		expect(await process.close()).toEqual({ killed: false });
		expect(shutDown()).toBe(true);
		// It returns when pi exits, not when the grace is over.
		expect(performance.now() - started).toBeLessThan(3_000);
	});

	it("kills a pi that outlasts the close grace, and says so", async () => {
		const process = start({ shutdownMs: 10_000 }, 100, 150);
		await process.prompt("go", { maxTurns: 3, timeoutMs: 5_000 });
		const started = performance.now();
		expect(await process.close()).toEqual({ killed: true });
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(shutDown()).toBe(false);
	});

	it("closes with the abort grace when no other is given, and a pi already gone was not killed", async () => {
		const quick = start({ shutdownMs: 10_000 }, 100);
		expect(await quick.close()).toEqual({ killed: true });
		const dead = start({ exitOnPrompt: 3 });
		await dead.prompt("go", { maxTurns: 3, timeoutMs: 5_000 });
		expect(await dead.close()).toEqual({ killed: false });
		expect(await dead.close()).toEqual({ killed: false });
	});
});
