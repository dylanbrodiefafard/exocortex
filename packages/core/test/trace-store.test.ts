import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTraceStore, type TraceStore } from "../src/trace/store.ts";

let dir: string | undefined;
let store: TraceStore | undefined;

afterEach(() => {
	store?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
	store = undefined;
	dir = undefined;
});

function open(options: { flushIntervalMs?: number; maxBuffered?: number } = {}) {
	dir = mkdtempSync(join(tmpdir(), "exo-trace-"));
	let clock = 1_000;
	const errors: unknown[] = [];
	const path = join(dir, "nested", "exo.db");
	store = openTraceStore({
		path,
		now: () => (clock += 1),
		flushIntervalMs: options.flushIntervalMs ?? 10_000,
		...(options.maxBuffered === undefined ? {} : { maxBuffered: options.maxBuffered }),
		onError: (e) => errors.push(e),
	});
	return { store, errors, path };
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
		expect(store.sessions({ label: "x" }).map((s) => s.id)).toEqual([a.id]);
		expect(store.events(a.id, { kinds: ["tool.result"] }).map((e) => e.kind)).toEqual(["tool.result"]);
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
	});

	it("reports write failures to onError instead of throwing, and rolls back the batch", () => {
		const { store, errors } = open();
		const session = store.startSession({ harness: "pi", cwd: "/" });
		const cyclic: Record<string, unknown> = {};
		cyclic["self"] = cyclic;
		session.append({ kind: "user.input", data: cyclic as never });
		expect(() => store.flush()).not.toThrow();
		expect(errors).toHaveLength(1);
		expect(store.sessions()).toEqual([]);
	});

	it("reopens an existing database without re-running migrations", () => {
		const { store, path } = open();
		const session = store.startSession({ harness: "pi", cwd: "/" });
		store.close();
		const again = openTraceStore({ path });
		expect(again.sessions().map((s) => s.id)).toEqual([session.id]);
		again.close();
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
});
