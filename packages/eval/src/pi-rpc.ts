import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { killGroup } from "@exocortex/core";

export type RunOutcome = "settled" | "max_turns" | "timeout" | "crashed";

export interface PiRpcOptions {
	/** Node script for pi's CLI (`dist/bundle/cli.js`). */
	readonly cliPath: string;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	/** pi's stderr is appended here. */
	readonly stderrPath: string;
}

export interface UiRequest {
	readonly method: string;
	readonly payload: Readonly<Record<string, unknown>>;
}

export interface PromptResult {
	readonly outcome: RunOutcome;
	readonly turns: number;
	readonly durationMs: number;
	/** Fire-and-forget UI requests (notify, set_editor_text, ...) seen during the run. */
	readonly uiRequests: readonly UiRequest[];
	readonly error?: string;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const ABORT_GRACE_MS = 5_000;

/**
 * Minimal driver for `pi --mode rpc`: strict LF-delimited JSONL (not `readline`, see pi's
 * docs/rpc.md), auto-cancels extension dialogs, enforces turn and wall-clock limits, and kills
 * the whole process group on close.
 */
export class PiRpcProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly stderr: WriteStream;
	private readonly listeners = new Set<(record: Record<string, unknown>) => void>();
	private readonly pending = new Map<string, (record: Record<string, unknown>) => void>();
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	private nextId = 0;
	private exited: string | undefined;

	constructor(options: PiRpcOptions) {
		this.stderr = createWriteStream(options.stderrPath, { flags: "a" });
		this.child = spawn(process.execPath, [options.cliPath, "--mode", "rpc", ...options.args], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		this.child.stderr.pipe(this.stderr);
		this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
		this.child.on("exit", (code, signal) => {
			this.exited = `pi exited (code=${code} signal=${signal})`;
			for (const resolve of this.pending.values()) resolve({ type: "response", success: false, error: this.exited });
			this.pending.clear();
			for (const listener of [...this.listeners]) listener({ type: "process_exit", error: this.exited });
		});
		this.child.on("error", (error) => {
			this.exited = `pi failed to start: ${error.message}`;
		});
	}

	/** Sends a prompt and waits for `agent_settled` (or a limit). */
	async prompt(
		message: string,
		limits: { readonly maxTurns: number; readonly timeoutMs: number },
	): Promise<PromptResult> {
		const started = performance.now();
		const uiRequests: UiRequest[] = [];
		let turns = 0;

		const done = new Promise<{ outcome: RunOutcome; error?: string }>((resolve) => {
			const timer = setTimeout(() => resolve({ outcome: "timeout" }), limits.timeoutMs);
			const listener = (record: Record<string, unknown>) => {
				const type = record["type"];
				if (type === "turn_end") {
					turns += 1;
					if (turns >= limits.maxTurns) finish({ outcome: "max_turns" });
				} else if (type === "agent_settled") {
					finish({ outcome: "settled" });
				} else if (type === "process_exit") {
					finish({ outcome: "crashed", error: String(record["error"]) });
				} else if (type === "extension_ui_request") {
					this.handleUiRequest(record, uiRequests);
				}
			};
			const finish = (result: { outcome: RunOutcome; error?: string }) => {
				clearTimeout(timer);
				this.listeners.delete(listener);
				resolve(result);
			};
			this.listeners.add(listener);
		});

		const response = await this.send({ type: "prompt", message });
		const result =
			response["success"] === true
				? await done
				: { outcome: "crashed" as const, error: `prompt rejected: ${String(response["error"])}` };
		if (result.outcome === "max_turns" || result.outcome === "timeout") await this.abort();
		return {
			outcome: result.outcome,
			turns,
			durationMs: Math.round(performance.now() - started),
			uiRequests,
			...(result.error === undefined ? {} : { error: result.error }),
		};
	}

	/** Closes stdin (pi's documented shutdown), then kills the process group if it lingers. */
	async close(): Promise<void> {
		if (!this.exited) {
			const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
			this.child.stdin.end();
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, ABORT_GRACE_MS).unref());
			await Promise.race([exited, timeout]);
		}
		killGroup(this.child.pid);
		await new Promise<void>((resolve) => this.stderr.end(resolve));
	}

	private async abort(): Promise<void> {
		const settled = new Promise<void>((resolve) => {
			const listener = (record: Record<string, unknown>) => {
				if (record["type"] === "agent_settled" || record["type"] === "process_exit") {
					this.listeners.delete(listener);
					resolve();
				}
			};
			this.listeners.add(listener);
			setTimeout(() => {
				this.listeners.delete(listener);
				resolve();
			}, ABORT_GRACE_MS).unref();
		});
		await this.send({ type: "abort" });
		await settled;
	}

	private handleUiRequest(record: Record<string, unknown>, sink: UiRequest[]): void {
		const method = String(record["method"]);
		if (DIALOG_METHODS.has(method)) {
			// Headless eval has no user: dismiss every dialog so nothing blocks.
			this.write({ type: "extension_ui_response", id: record["id"], cancelled: true });
		}
		sink.push({ method, payload: record });
	}

	private send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (this.exited) return Promise.resolve({ type: "response", success: false, error: this.exited });
		const id = `eval-${++this.nextId}`;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.write({ ...command, id });
		});
	}

	private write(record: Record<string, unknown>): void {
		if (!this.exited) this.child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	private onStdout(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim() !== "") this.dispatch(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	private dispatch(line: string): void {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		const id = record["id"];
		if (record["type"] === "response" && typeof id === "string") {
			const resolve = this.pending.get(id);
			this.pending.delete(id);
			resolve?.(record);
			return;
		}
		for (const listener of [...this.listeners]) listener(record);
	}
}
