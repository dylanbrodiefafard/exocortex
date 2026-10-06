import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { SidecarCallRecord } from "../inference/pool.ts";
import { migrate } from "./schema.ts";
import { isTransientSqliteError, openDatabase, rollback, setBusyTimeout } from "./sqlite.ts";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Harness-agnostic event kinds. Adapters map their harness's events onto these; anything the
 * kind can't express goes in `data`.
 */
export const TRACE_EVENT_KINDS = [
	"session.start",
	"session.end",
	"user.input",
	"llm.request",
	"message",
	"tool.call",
	"tool.result",
	"turn.end",
	"agent.settled",
	"compaction",
	/** A compaction failed or was aborted; `reason: "overflow"` means the context window was exceeded. */
	"compaction.failed",
	"model.change",
	/** A module's extracted task goals (e.g. the supervisor's goal ledger). */
	"exo.ledger",
	/** A module's judgement of the agent's work: the labels memory learns from (brief §6.1). */
	"exo.verdict",
	/** A module acting on the session: suggestion, continuation, acceptance, or a deliberate skip. */
	"exo.action",
	/** A module rewrote a tool result; the original is the preceding `tool.result` event. */
	"exo.rewrite",
	/** A module supplied the compaction summary. */
	"exo.compaction",
	/** Memory learned, merged, recalled or retired a card. */
	"exo.memory",
	/** How a test run whose exit code a pipe hid was read: from its output, or by a sidecar (D-075). */
	"exo.run",
] as const;

export type TraceEventKind = (typeof TRACE_EVENT_KINDS)[number];

export interface TraceEventInput {
	readonly kind: TraceEventKind;
	readonly data: JsonValue;
	readonly turn?: number;
	/** True for content Exocortex produced (injections, rewrites), so it is never learned from as if the model or user produced it. */
	readonly synthetic?: boolean;
	/** Exocortex module responsible, for synthetic content. */
	readonly module?: string;
	/** Epoch ms; defaults to the store clock. */
	readonly ts?: number;
}

export interface StoredTraceEvent {
	readonly id: number;
	readonly sessionId: string;
	readonly seq: number;
	readonly ts: number;
	readonly kind: TraceEventKind;
	readonly turn: number | null;
	readonly synthetic: boolean;
	readonly module: string | null;
	readonly data: JsonValue;
}

export interface SessionInfo {
	readonly harness: string;
	readonly cwd: string;
	readonly harnessSessionId?: string;
	/** Free-form label, e.g. the eval run/task id. */
	readonly label?: string;
	readonly meta?: { readonly [key: string]: JsonValue };
}

export interface StoredSession {
	readonly id: string;
	readonly harness: string;
	readonly harnessSessionId: string | null;
	readonly cwd: string;
	readonly label: string | null;
	readonly startedAt: number;
	readonly endedAt: number | null;
	readonly meta: JsonValue;
}

export interface TraceSession {
	readonly id: string;
	/** Buffers the event; it is written on the next flush. Never throws. */
	append(event: TraceEventInput): void;
	/** Buffers one sidecar call record (brief §5.2 `sidecar_calls`). Never throws. */
	recordSidecarCall(record: SidecarCallRecord): void;
	end(): void;
}

export interface TraceStore {
	startSession(info: SessionInfo): TraceSession;
	sessions(filter?: { readonly label?: string }): StoredSession[];
	events(sessionId: string, filter?: { readonly kinds?: readonly TraceEventKind[] }): StoredTraceEvent[];
	sidecarCalls(sessionId: string): SidecarCallRecord[];
	/**
	 * Writes buffered operations in one transaction. Never throws. A row the database refuses is
	 * dropped by itself and reported to `onError`; when the database is locked the whole batch is
	 * kept and written by a later flush (D-080).
	 */
	flush(): void;
	/** Flushes and closes. Further appends are dropped. Never throws. */
	close(): void;
}

export interface TraceStoreOptions {
	/** SQLite file path, or `:memory:`. Parent directories are created. */
	readonly path: string;
	readonly now?: () => number;
	/** Delay before a buffered write is flushed. */
	readonly flushIntervalMs?: number;
	/** Flush immediately once this many operations are buffered. */
	readonly maxBuffered?: number;
	/** Called with every failure. It may be called from a timer; what it throws is ignored. */
	readonly onError?: (error: unknown) => void;
	/**
	 * How long a flush waits for another connection's write lock. Flushes run on the caller's
	 * event loop, so this is kept short and a locked flush is retried later instead. Default 20 ms.
	 */
	readonly busyTimeoutMs?: number;
	/** The longer wait `close()` allows its last flush. Default 500 ms. */
	readonly closeBusyTimeoutMs?: number;
	/**
	 * Most operations held while the database cannot be written. Past it new events and sidecar
	 * records are dropped (session rows are always kept) and the count is reported. Default 20,000.
	 */
	readonly maxPending?: number;
	/** Sessions that started longer ago than this are deleted when the store opens. Unset or 0: keep all. */
	readonly retentionMs?: number;
}

type PendingOp =
	| {
			readonly op: "session";
			readonly id: string;
			readonly info: SessionInfo;
			readonly meta: string;
			readonly ts: number;
	  }
	| {
			readonly op: "event";
			readonly sessionId: string;
			readonly seq: number;
			readonly event: TraceEventInput;
			/** `event.data` as JSON, made at `append` so a value that cannot be serialised costs only itself. */
			readonly data: string;
			readonly ts: number;
	  }
	| { readonly op: "end"; readonly id: string; readonly ts: number }
	| { readonly op: "sidecar"; readonly sessionId: string; readonly record: SidecarCallRecord };

const DEFAULT_FLUSH_INTERVAL_MS = 50;
const DEFAULT_MAX_BUFFERED = 256;
const DEFAULT_BUSY_TIMEOUT_MS = 20;
const DEFAULT_CLOSE_BUSY_TIMEOUT_MS = 500;
const DEFAULT_MAX_PENDING = 20_000;
/** A locked flush is retried after the flush interval, doubling up to this. */
const MAX_RETRY_DELAY_MS = 5_000;
/** Sessions pruned per open, so the first prune of a large file cannot hold up the harness's start. */
const PRUNE_SESSIONS_PER_OPEN = 500;

/**
 * Append-only SQLite trace store (brief §5.1). Appends are buffered in memory and written in
 * batched transactions off the caller's path, so harness event handlers pay only a JSON
 * serialisation and an array push.
 */
export function openTraceStore(options: TraceStoreOptions): TraceStore {
	if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
	// Opening and migrating may wait for another process doing the same; flushes may not.
	const db = openDatabase(options.path);
	try {
		migrate(db);
		setBusyTimeout(db, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
	} catch (error) {
		db.close();
		throw error;
	}

	const now = options.now ?? Date.now;
	const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
	const maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
	const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
	const statements = prepare(db);
	const eventsByKinds = new Map<number, StatementSync>();
	let buffer: PendingOp[] = [];
	let timer: NodeJS.Timeout | undefined;
	let closed = false;
	/** Flushes in a row that could not get the database. */
	let failedFlushes = 0;
	/** Operations refused because `maxPending` was reached. */
	let dropped = 0;

	function report(error: unknown): void {
		try {
			options.onError?.(error);
		} catch {
			// A broken error handler must not take the session down with it.
		}
	}

	function schedule(delayMs: number): void {
		if (timer || closed) return;
		timer = setTimeout(flush, delayMs);
		timer.unref();
	}

	function enqueue(op: PendingOp): void {
		if (closed) return;
		if (buffer.length >= maxPending && (op.op === "event" || op.op === "sidecar")) {
			dropped += 1;
			return;
		}
		buffer.push(op);
		// While the database is locked, the retry timer decides when to try again: a synchronous
		// attempt per append would block the caller for the busy timeout each time.
		if (buffer.length >= maxBuffered && failedFlushes === 0) flush();
		else schedule(flushIntervalMs);
	}

	function flush(): void {
		try {
			flushNow();
		} catch (error) {
			report(error);
		}
	}

	function flushNow(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (buffer.length === 0 || !db.isOpen) return;
		let refused: unknown[];
		try {
			refused = writeBatch(buffer);
		} catch (error) {
			// The batch stays buffered. Another writer holding the lock is ordinary; anything else
			// is worth one report.
			rollback(db);
			if (failedFlushes === 0 && !isBusy(error)) report(error);
			failedFlushes += 1;
			schedule(Math.min(flushIntervalMs * 2 ** Math.min(failedFlushes, 16), MAX_RETRY_DELAY_MS));
			return;
		}
		buffer = [];
		failedFlushes = 0;
		for (const error of refused) report(error);
		reportDropped();
	}

	/**
	 * Writes the operations in one transaction and returns the errors of the rows the database
	 * refused (each costs only itself). Throws, with the transaction still open, when the database
	 * cannot be written at all right now.
	 */
	function writeBatch(batch: readonly PendingOp[]): unknown[] {
		const refused: unknown[] = [];
		db.exec("BEGIN IMMEDIATE");
		for (const op of batch) {
			try {
				write(statements, op);
			} catch (error) {
				if (isTransientSqliteError(error)) throw error;
				refused.push(error);
			}
		}
		db.exec("COMMIT");
		return refused;
	}

	function reportDropped(): void {
		if (dropped === 0) return;
		report(new Error(`trace: dropped ${dropped} events while the database could not be written`));
		dropped = 0;
	}

	function serialise(value: unknown): string | undefined {
		try {
			const text = JSON.stringify(value);
			if (typeof text === "string") return text;
			report(new Error("trace: value has no JSON form"));
		} catch (error) {
			report(error);
		}
		return undefined;
	}

	if (options.retentionMs !== undefined && options.retentionMs > 0) {
		try {
			prune(db, now() - options.retentionMs);
		} catch (error) {
			// Locked by another session: the next open prunes.
			if (!isBusy(error)) report(error);
		}
	}

	return {
		startSession(info) {
			const id = randomUUID();
			let seq = 0;
			let ended = false;
			enqueue({ op: "session", id, info, meta: serialise(info.meta ?? {}) ?? "{}", ts: now() });
			return {
				id,
				append(event) {
					if (ended || closed) return;
					const data = serialise(event.data);
					if (data === undefined) return;
					seq += 1;
					enqueue({ op: "event", sessionId: id, seq, event, data, ts: event.ts ?? now() });
				},
				recordSidecarCall(record) {
					if (ended) return;
					enqueue({ op: "sidecar", sessionId: id, record });
				},
				end() {
					if (ended) return;
					ended = true;
					enqueue({ op: "end", id, ts: now() });
				},
			};
		},
		sessions(filter = {}) {
			flush();
			const rows =
				filter.label === undefined
					? statements.allSessions.all()
					: statements.sessionsByLabel.all({ label: filter.label });
			return (rows as unknown as SessionRow[]).map(toSession);
		},
		events(sessionId, filter = {}) {
			flush();
			if (!filter.kinds) {
				return (statements.eventsBySession.all({ session_id: sessionId }) as unknown as EventRow[]).map(toEvent);
			}
			const kinds = [...new Set<string>(filter.kinds)];
			if (kinds.length === 0) return [];
			let statement = eventsByKinds.get(kinds.length);
			if (!statement) {
				const marks = kinds.map(() => "?").join(", ");
				statement = db.prepare(`SELECT * FROM events WHERE session_id = ? AND kind IN (${marks}) ORDER BY seq`);
				eventsByKinds.set(kinds.length, statement);
			}
			return (statement.all(sessionId, ...kinds) as unknown as EventRow[]).map(toEvent);
		},
		sidecarCalls(sessionId) {
			flush();
			const rows = statements.sidecarCallsBySession.all({ session_id: sessionId }) as unknown as SidecarRow[];
			return rows.map(toSidecarCall);
		},
		flush,
		close() {
			if (closed) return;
			flush();
			try {
				if (buffer.length > 0 && db.isOpen) {
					// The last chance to write: wait a little longer for the other writer.
					setBusyTimeout(db, options.closeBusyTimeoutMs ?? DEFAULT_CLOSE_BUSY_TIMEOUT_MS);
					flush();
				}
			} catch (error) {
				report(error);
			}
			closed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			if (buffer.length > 0) report(new Error(`trace: closed with ${buffer.length} unwritten operations`));
			reportDropped();
			buffer = [];
			try {
				if (db.isOpen) db.close();
			} catch (error) {
				report(error);
			}
		},
	};
}

function isBusy(error: unknown): boolean {
	const code = (error as { errcode?: unknown } | null)?.errcode;
	return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

/** Deletes the oldest sessions that started before `cutoff`, with their events and sidecar calls. */
function prune(db: DatabaseSync, cutoff: number): void {
	const old = `SELECT id FROM sessions WHERE started_at < ${Math.floor(cutoff)} ORDER BY started_at LIMIT ${PRUNE_SESSIONS_PER_OPEN}`;
	const expired = db.prepare(`SELECT 1 FROM sessions WHERE started_at < ${Math.floor(cutoff)} LIMIT 1`).get();
	if (expired === undefined) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec("CREATE TEMP TABLE IF NOT EXISTS exo_prune (id TEXT PRIMARY KEY); DELETE FROM exo_prune;");
		db.exec(`INSERT INTO exo_prune ${old}`);
		db.exec("DELETE FROM events WHERE session_id IN (SELECT id FROM exo_prune)");
		db.exec("DELETE FROM sidecar_calls WHERE session_id IN (SELECT id FROM exo_prune)");
		db.exec("DELETE FROM sessions WHERE id IN (SELECT id FROM exo_prune)");
		db.exec("DELETE FROM exo_prune");
		db.exec("COMMIT");
	} catch (error) {
		rollback(db);
		throw error;
	}
}

function prepare(db: DatabaseSync) {
	return {
		insertSession: db.prepare(
			"INSERT INTO sessions (id, harness, harness_session_id, cwd, label, started_at, meta) VALUES (:id, :harness, :harness_session_id, :cwd, :label, :started_at, :meta)",
		),
		endSession: db.prepare("UPDATE sessions SET ended_at = :ended_at WHERE id = :id"),
		insertEvent: db.prepare(
			"INSERT INTO events (session_id, seq, ts, kind, turn, synthetic, module, data) VALUES (:session_id, :seq, :ts, :kind, :turn, :synthetic, :module, :data)",
		),
		allSessions: db.prepare("SELECT * FROM sessions ORDER BY started_at, rowid"),
		sessionsByLabel: db.prepare("SELECT * FROM sessions WHERE label = :label ORDER BY started_at, rowid"),
		eventsBySession: db.prepare("SELECT * FROM events WHERE session_id = :session_id ORDER BY seq"),
		insertSidecarCall: db.prepare(
			"INSERT INTO sidecar_calls (session_id, ts, module, priority, outcome, prompt_hash, queue_ms, latency_ms, attempts, max_tokens, prompt_tokens, cached_tokens, completion_tokens, error) VALUES (:session_id, :ts, :module, :priority, :outcome, :prompt_hash, :queue_ms, :latency_ms, :attempts, :max_tokens, :prompt_tokens, :cached_tokens, :completion_tokens, :error)",
		),
		sidecarCallsBySession: db.prepare("SELECT * FROM sidecar_calls WHERE session_id = :session_id ORDER BY id"),
	};
}

function write(statements: ReturnType<typeof prepare>, op: PendingOp): void {
	switch (op.op) {
		case "session":
			statements.insertSession.run({
				id: op.id,
				harness: op.info.harness,
				harness_session_id: op.info.harnessSessionId ?? null,
				cwd: op.info.cwd,
				label: op.info.label ?? null,
				started_at: op.ts,
				meta: op.meta,
			});
			return;
		case "event":
			statements.insertEvent.run({
				session_id: op.sessionId,
				seq: op.seq,
				ts: op.ts,
				kind: op.event.kind,
				turn: op.event.turn ?? null,
				synthetic: op.event.synthetic ? 1 : 0,
				module: op.event.module ?? null,
				data: op.data,
			});
			return;
		case "end":
			statements.endSession.run({ id: op.id, ended_at: op.ts });
			return;
		case "sidecar": {
			const r = op.record;
			statements.insertSidecarCall.run({
				session_id: op.sessionId,
				ts: r.startedAt,
				module: r.module,
				priority: r.priority,
				outcome: r.outcome,
				prompt_hash: r.promptHash,
				queue_ms: Math.round(r.queueMs),
				latency_ms: Math.round(r.latencyMs),
				attempts: r.attempts,
				max_tokens: r.maxTokens,
				prompt_tokens: r.usage.promptTokens,
				cached_tokens: r.usage.cachedTokens,
				completion_tokens: r.usage.completionTokens,
				error: r.error,
			});
			return;
		}
	}
}

interface SessionRow {
	id: string;
	harness: string;
	harness_session_id: string | null;
	cwd: string;
	label: string | null;
	started_at: number;
	ended_at: number | null;
	meta: string;
}

interface EventRow {
	id: number;
	session_id: string;
	seq: number;
	ts: number;
	kind: TraceEventKind;
	turn: number | null;
	synthetic: number;
	module: string | null;
	data: string;
}

function toSession(row: SessionRow): StoredSession {
	return {
		id: row.id,
		harness: row.harness,
		harnessSessionId: row.harness_session_id,
		cwd: row.cwd,
		label: row.label,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		meta: JSON.parse(row.meta) as JsonValue,
	};
}

function toEvent(row: EventRow): StoredTraceEvent {
	return {
		id: row.id,
		sessionId: row.session_id,
		seq: row.seq,
		ts: row.ts,
		kind: row.kind,
		turn: row.turn,
		synthetic: row.synthetic === 1,
		module: row.module,
		data: JSON.parse(row.data) as JsonValue,
	};
}

interface SidecarRow {
	ts: number;
	module: string;
	priority: SidecarCallRecord["priority"];
	outcome: SidecarCallRecord["outcome"];
	prompt_hash: string;
	queue_ms: number;
	latency_ms: number;
	attempts: number;
	max_tokens: number;
	prompt_tokens: number;
	cached_tokens: number | null;
	completion_tokens: number;
	error: string | null;
}

function toSidecarCall(row: SidecarRow): SidecarCallRecord {
	return {
		module: row.module,
		priority: row.priority,
		outcome: row.outcome,
		promptHash: row.prompt_hash,
		startedAt: row.ts,
		queueMs: row.queue_ms,
		latencyMs: row.latency_ms,
		attempts: row.attempts,
		maxTokens: row.max_tokens,
		usage: {
			promptTokens: row.prompt_tokens,
			cachedTokens: row.cached_tokens,
			completionTokens: row.completion_tokens,
		},
		error: row.error,
	};
}
