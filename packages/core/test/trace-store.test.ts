import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SidecarCallRecord } from "../src/inference/pool.ts";
import { openDatabase } from "../src/trace/sqlite.ts";
import { openTraceStore, type TraceStore, type TraceStoreOptions } from "../src/trace/store.ts";

let dir: string | undefined;
let store: TraceStore | undefined;

afterEach(() => {
	store?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
	store = undefined;
	dir = undefined;
});

function tempDir(): string {
	dir = mkdtempSync(join(tmpdir(), "exo-trace-"));
	return dir;
}

function open(options: Partial<TraceStoreOptions> = {}) {
	let clock = 1_000;
	const errors: unknown[] = [];
	const path = join(tempDir(), "nested", "exo.db");
	const opened = openTraceStore({
		path,
		now: () => (clock += 1),
		flushIntervalMs: 10_000,
		onError: (e) => errors.push(e),
		...options,
	});
	store = opened;
	return { store: opened, errors, path };
}

const RECORD: SidecarCallRecord = {
	module: "triage",
	priority: "interactive",
	outcome: "ok",
	promptHash: "abc",
	startedAt: 1_234,
	queueMs: 5,
	latencyMs: 120,
	attempts: 1,
	maxTokens: 256,
	usage: { promptTokens: 900, cachedTokens: 850, completionTokens: 40 },
	error: null,
};

function cyclic(): never {
	const value: Record<string, unknown> = {};
	value["self"] = value;
	return value as never;
}

describe("trace store", () => {
	it("records sessions and ordered events, round-tripping JSON and tags", () => {
		const { store, errors } = open();
		const session = store.startSession({ harness: "pi", cwd: "/repo", harnessSessionId: "abc", label: "run-1" });
		session.append({ kind: "user.input", data: { text: "fix it" } });
		session.append({
			kind: "message",
			turn: 0,
			synthetic: true,
			module: "supervisor",
			data: { role: "custom", content: [{ type: "text", text: "missing: tests" }] },
		});
		session.end();

		const [stored] = store.sessions();
		expect(stored).toMatchObject({
			id: session.id,
			harness: "pi",
			harnessSessionId: "abc",
			label: "run-1",
			cwd: "/repo",
		});
		expect(stored?.endedAt).toBeGreaterThan(stored?.startedAt ?? Number.POSITIVE_INFINITY);

		const events = store.events(session.id);
		expect(events.map((e) => [e.seq, e.kind, e.turn, e.synthetic, e.module])).toEqual([
			[1, "user.input", null, false, null],
			[2, "message", 0, true, "supervisor"],
		]);
		expect(events[1]?.data).toEqual({ role: "custom", content: [{ type: "text", text: "missing: tests" }] });
		expect(errors).toEqual([]);
	});

	it("buffers writes until flush, interval, or the batch limit", async () => {
		const { store, path } = open({ flushIntervalMs: 5, maxBuffered: 3 });
		const reader = () => openTraceStore({ path, flushIntervalMs: 10_000 });
		const session = store.startSession({ harness: "pi", cwd: "/" });
		session.append({ kind: "user.input", data: 1 });

		const before = reader();
		expect(before.sessions()).toEqual([]); // still buffered in the writer
		before.close();

		session.append({ kind: "user.input", data: 2 }); // third op hits maxBuffered
		const after = reader();
		expect(after.events(session.id)).toHaveLength(2);
		after.close();

		session.append({ kind: "user.input", data: 3 });
		await new Promise((resolve) => setTimeout(resolve, 30));
		const timed = reader();
		expect(timed.events(session.id)).toHaveLength(3);
		timed.close();
	});

	it("filters events by kind and sessions by label", () => {
		const { store } = open();
		const a = store.startSession({ harness: "pi", cwd: "/", label: "x" });
		store.startSession({ harness: "pi", cwd: "/", label: "y" });
		a.append({ kind: "tool.call", data: {} });
		a.append({ kind: "tool.result", data: {} });
		a.append({ kind: "turn.end", data: {} });
		expect(store.sessions({ label: "x" }).map((s) => s.id)).toEqual([a.id]);
		expect(store.events(a.id, { kinds: ["tool.result"] }).map((e) => e.kind)).toEqual(["tool.result"]);
		expect(store.events(a.id, { kinds: ["turn.end", "tool.call"] }).map((e) => e.kind)).toEqual([
			"tool.call",
			"turn.end",
		]);
		expect(store.events(a.id, { kinds: [] })).toEqual([]);
		expect(store.events(a.id)).toHaveLength(3);
	});

	it("drops appends after end or close without throwing", () => {
		const { store } = open();
		const session = store.startSession({ harness: "pi", cwd: "/" });
		session.end();
		session.append({ kind: "user.input", data: 1 });
		expect(store.events(session.id)).toEqual([]);
		store.close();
		expect(() => session.append({ kind: "user.input", data: 2 })).not.toThrow();
		expect(() => store.close()).not.toThrow();
		expect(() => store.flush()).not.toThrow();
	});

	it("drops only the event whose data cannot be serialised, and reports it (D1)", () => {
		const { store, errors } = open();
		const session = store.startSession({ harness: "pi", cwd: "/" });
		session.append({ kind: "user.input", data: "before" });
		expect(() => session.append({ kind: "user.input", data: cyclic() })).not.toThrow();
		session.append({ kind: "user.input", data: 10n as never });
		session.append({ kind: "user.input", data: undefined as never });
		session.append({ kind: "user.input", data: "after" });
		expect(() => store.flush()).not.toThrow();
		expect(errors).toHaveLength(3);
		expect(store.sessions().map((s) => s.id)).toEqual([session.id]);
		expect(store.events(session.id).map((e) => [e.seq, e.data])).toEqual([
			[1, "before"],
			[2, "after"],
		]);
	});

	it("keeps a session whose meta cannot be serialised, without the meta (D1)", () => {
		const { store, errors } = open();
		const session = store.startSession({ harness: "pi", cwd: "/", meta: { bad: cyclic() } });
		session.append({ kind: "user.input", data: 1 });
		expect(store.sessions().map((s) => [s.id, s.meta])).toEqual([[session.id, {}]]);
		expect(store.events(session.id)).toHaveLength(1);
		expect(errors).toHaveLength(1);
	});

	it("a row the database refuses drops only itself (D1)", () => {
		const { store, errors } = open();
		const session = store.startSession({ harness: "pi", cwd: "/" });
		session.append({ kind: "user.input", data: 1 });
		// A null binds where the column is NOT NULL.
		session.recordSidecarCall({ ...RECORD, module: null as never });
		session.recordSidecarCall(RECORD);
		session.append({ kind: "user.input", data: 2 });
		store.flush();
		expect(errors).toHaveLength(1);
		expect(store.events(session.id)).toHaveLength(2);
		expect(store.sidecarCalls(session.id)).toEqual([RECORD]);
	});

	it("never lets a throwing onError escape (D1)", () => {
		const { store } = open({
			onError: () => {
				throw new Error("the error handler is broken too");
			},
		});
		const session = store.startSession({ harness: "pi", cwd: "/" });
		expect(() => session.append({ kind: "user.input", data: cyclic() })).not.toThrow();
		session.recordSidecarCall({ ...RECORD, module: null as never });
		expect(() => store.flush()).not.toThrow();
		expect(store.sessions()).toHaveLength(1);
	});

	it("reopens an existing database without re-running migrations", () => {
		const { store, path } = open();
		const session = store.startSession({ harness: "pi", cwd: "/" });
		store.close();
		const again = openTraceStore({ path });
		expect(again.sessions().map((s) => s.id)).toEqual([session.id]);
		again.close();
	});

	it("refuses a database written by a newer Exocortex", () => {
		const path = join(tempDir(), "exo.db");
		const db = openDatabase(path);
		db.exec("PRAGMA user_version = 999");
		db.close();
		expect(() => openTraceStore({ path })).toThrow(/newer than this Exocortex/);
	});
});

describe("trace store under contention (two connections on one file)", () => {
	/** A second connection holding the write lock, as another pi session mid-flush would. */
	function lock(path: string) {
		const other = openDatabase(path);
		other.exec("BEGIN IMMEDIATE");
		return {
			other,
			release() {
				other.exec("COMMIT");
			},
		};
	}

	it("keeps the batch when the database is locked, without blocking for long (D1)", () => {
		const { store, errors, path } = open();
		const session = store.startSession({ harness: "pi", cwd: "/" });
		session.append({ kind: "user.input", data: "kept" });
		const held = lock(path);
		const started = performance.now();
		store.flush();
		expect(performance.now() - started).toBeLessThan(500);
		held.release();
		held.other.close();

		store.flush();
		expect(store.sessions().map((s) => s.id)).toEqual([session.id]);
		expect(store.events(session.id).map((e) => e.data)).toEqual(["kept"]);
		expect(errors).toEqual([]);
	});

	it("retries a locked flush by itself, later (D1)", async () => {
		const { store, path } = open({ flushIntervalMs: 5, busyTimeoutMs: 5 });
		const session = store.startSession({ harness: "pi", cwd: "/" });
		session.append({ kind: "user.input", data: "kept" });
		const held = lock(path);
		await new Promise((resolve) => setTimeout(resolve, 60));
		held.release();
		const count = () => (held.other.prepare("SELECT count(*) AS n FROM events").get() as { n: number } | undefined)?.n;
		expect(count()).toBe(0);
		await expect.poll(count, { timeout: 2_000, interval: 10 }).toBe(1);
		held.other.close();
	});

	it("caps what it holds while locked, keeping session rows, and reports the loss once (D1)", () => {
		const { store, errors, path } = open({ maxPending: 10, maxBuffered: 1_000, busyTimeoutMs: 1 });
		const first = store.startSession({ harness: "pi", cwd: "/" });
		const held = lock(path);
		for (let i = 0; i < 25; i++) first.append({ kind: "user.input", data: i });
		const second = store.startSession({ harness: "pi", cwd: "/" });
		store.flush();
		held.release();
		held.other.close();

		expect(store.sessions().map((s) => s.id)).toEqual([first.id, second.id]);
		// The session row and the nine oldest events fit the cap; later events were dropped.
		expect(store.events(first.id).map((e) => e.data)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(errors.map(String)).toEqual([expect.stringMatching(/dropped 16 /)]);
	});

	it("waits a little longer at close, then gives up and says what was lost (D1)", () => {
		const { store, errors, path } = open({ busyTimeoutMs: 1, closeBusyTimeoutMs: 20 });
		const session = store.startSession({ harness: "pi", cwd: "/" });
		session.append({ kind: "user.input", data: 1 });
		const held = lock(path);
		expect(() => store.close()).not.toThrow();
		held.release();
		expect(errors.map(String)).toEqual([expect.stringMatching(/2 unwritten/)]);
		expect(held.other.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
		held.other.close();
	});

	it("opens one fresh database from several processes at once (D11)", { timeout: 30_000 }, async () => {
		const path = join(tempDir(), "race.db");
		const module = join(import.meta.dirname, "..", "src", "trace", "store.ts");
		const startAt = Date.now() + 1_500;
		const script = `
			const { openTraceStore } = await import(${JSON.stringify(module)});
			while (Date.now() < ${startAt}) {}
			const store = openTraceStore({ path: ${JSON.stringify(path)} });
			store.startSession({ harness: "pi", cwd: "/" });
			store.close();
		`;
		const results = await Promise.all(
			Array.from(
				{ length: 8 },
				() =>
					new Promise<{ code: number | null; stderr: string }>((resolve) => {
						const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
						let stderr = "";
						child.stderr.on("data", (chunk: Buffer) => {
							stderr += chunk.toString();
						});
						child.on("close", (code) => resolve({ code, stderr }));
					}),
			),
		);
		expect(results.filter((r) => r.code !== 0).map((r) => r.stderr)).toEqual([]);
		const reader = openTraceStore({ path });
		expect(reader.sessions()).toHaveLength(8);
		reader.close();
	});
});

describe("trace retention (D11)", () => {
	const DAY = 86_400_000;

	function seed(path: string, clock: { now: number }) {
		const first = openTraceStore({ path, now: () => clock.now });
		const old = first.startSession({ harness: "pi", cwd: "/" });
		old.append({ kind: "user.input", data: "old" });
		old.recordSidecarCall(RECORD);
		clock.now += 20 * DAY;
		const recent = first.startSession({ harness: "pi", cwd: "/" });
		recent.append({ kind: "user.input", data: "recent" });
		first.close();
		clock.now += 15 * DAY;
		return { old, recent };
	}

	it("prunes sessions older than the retention period when the store opens", () => {
		const path = join(tempDir(), "exo.db");
		const clock = { now: 100 * DAY };
		const { old, recent } = seed(path, clock);

		const unlimited = openTraceStore({ path, now: () => clock.now });
		expect(unlimited.sessions()).toHaveLength(2);
		unlimited.close();

		store = openTraceStore({ path, now: () => clock.now, retentionMs: 30 * DAY });
		expect(store.sessions().map((s) => s.id)).toEqual([recent.id]);
		expect(store.events(old.id)).toEqual([]);
		expect(store.sidecarCalls(old.id)).toEqual([]);
		expect(store.events(recent.id)).toHaveLength(1);
	});

	it("skips pruning, and still opens quickly, while another connection holds the write lock", () => {
		const path = join(tempDir(), "exo.db");
		const clock = { now: 100 * DAY };
		seed(path, clock);
		const other = openDatabase(path);
		other.exec("BEGIN IMMEDIATE");
		const started = performance.now();
		store = openTraceStore({ path, now: () => clock.now, retentionMs: DAY });
		expect(performance.now() - started).toBeLessThan(500);
		other.exec("COMMIT");
		other.close();
		expect(store.sessions()).toHaveLength(2);
	});
});

describe("openDatabase", () => {
	it("does not print Node's SQLite ExperimentalWarning", () => {
		const module = join(import.meta.dirname, "..", "src", "trace", "sqlite.ts");
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const m = await import(${JSON.stringify(module)}); m.openDatabase(":memory:").close();`,
			],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		expect(result.stderr).not.toMatch(/ExperimentalWarning/);
	});

	it("sets the busy timeout it is asked for", () => {
		const db = openDatabase(":memory:", { busyTimeoutMs: 123 });
		expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 123 });
		db.close();
	});
});

describe("sidecar call records", () => {
	it("round-trips sidecar calls per session (schema v2)", () => {
		const { store } = open();
		const session = store.startSession({ harness: "pi", cwd: "/" });
		session.recordSidecarCall(RECORD);
		session.recordSidecarCall({
			...RECORD,
			outcome: "timeout",
			usage: { ...RECORD.usage, cachedTokens: null },
			error: "late",
		});
		const calls = store.sidecarCalls(session.id);
		expect(calls).toEqual([
			RECORD,
			{ ...RECORD, outcome: "timeout", usage: { ...RECORD.usage, cachedTokens: null }, error: "late" },
		]);
	});
});
