import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { clampTimeoutMs } from "../config.ts";

export interface CommandOutput {
	/** The process's exit code; null when it was killed (timeout, abort, a signal) or never started. */
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly durationMs: number;
	/** Last `tailChars` characters of combined stdout + stderr. */
	readonly outputTail: string;
}

interface RunOptions {
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly env?: Readonly<Record<string, string>>;
	readonly tailChars?: number;
	readonly signal?: AbortSignal;
}

const DEFAULT_TAIL_CHARS = 4096;
/**
 * After the process exits, how long its output pipes get to deliver what is still in them. A
 * child it left running in the background can hold them open for as long as it lives.
 */
const DRAIN_GRACE_MS = 200;
/** After a kill, how long to wait for the exit before answering without it. */
const KILL_GRACE_MS = 1_000;

/**
 * Runs `command` with bash in `cwd`, in its own process group so a timeout kills build tools'
 * grandchildren too. Never rejects.
 */
export function runShellCommand(command: string, options: RunOptions): Promise<CommandOutput> {
	return runProcess("bash", ["-c", command], options);
}

/**
 * Runs `file` in its own process group. Never rejects and never throws, and resolves no later
 * than about a second past `timeoutMs`, whatever the process does:
 * - The answer comes when the process **exits**, not when its output pipes close: a daemonised
 *   child that inherited them does not hold the caller. Output written before the exit is kept.
 * - On timeout or abort the whole process group is killed. A process that left the group
 *   survives that, and is not waited for.
 */
export function runProcess(file: string, args: readonly string[], options: RunOptions): Promise<CommandOutput> {
	const tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS;
	const started = performance.now();
	return new Promise((resolve) => {
		let tail = "";
		let timedOut = false;
		let settled = false;
		let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
		let timer: NodeJS.Timeout | undefined;
		let grace: NodeJS.Timeout | undefined;
		const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")] as const;

		const append = (text: string) => {
			tail = (tail + text).slice(-tailChars);
			// The cut may have landed inside a surrogate pair.
			const first = tail.charCodeAt(0);
			if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
		};
		const kill = () => {
			killGroup(child?.pid);
			// The exit normally follows at once; if it never comes, answer anyway.
			grace ??= setTimeout(() => finish(null), KILL_GRACE_MS);
		};
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			options.signal?.removeEventListener("abort", kill);
			for (const decoder of decoders) append(decoder.end());
			// Let go of the pipes and the process, so a survivor cannot keep this one alive.
			child?.stdout.destroy();
			child?.stderr.destroy();
			child?.unref();
			resolve({ exitCode, timedOut, durationMs: Math.round(performance.now() - started), outputTail: tail });
		};

		if (options.signal?.aborted) {
			append("aborted before start");
			finish(null);
			return;
		}
		try {
			child = spawn(file, args, {
				cwd: options.cwd,
				env: { ...process.env, ...options.env },
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
		} catch (error) {
			append(String(error));
			finish(null);
			return;
		}
		timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, clampTimeoutMs(options.timeoutMs));
		options.signal?.addEventListener("abort", kill, { once: true });
		child.stdout.on("data", (chunk: Buffer) => append(decoders[0].write(chunk)));
		child.stderr.on("data", (chunk: Buffer) => append(decoders[1].write(chunk)));
		// A destroyed or broken pipe must not surface as an unhandled 'error' event.
		child.stdout.on("error", () => {});
		child.stderr.on("error", () => {});
		child.on("error", (error) => {
			append(String(error));
			finish(null);
		});
		let exit: { code: number | null } | undefined;
		child.on("exit", (code) => {
			exit = { code: timedOut || options.signal?.aborted ? null : code };
			clearTimeout(timer);
			clearTimeout(grace);
			const result = exit.code;
			grace = setTimeout(() => finish(result), DRAIN_GRACE_MS);
		});
		// Both pipes closed: everything written has been read.
		child.on("close", (code) => finish(exit ? exit.code : timedOut ? null : code));
	});
}

/** Kills a detached child's whole process group. */
export function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}
