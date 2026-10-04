import { spawn } from "node:child_process";

export interface CommandOutput {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly durationMs: number;
	/** Last `tailChars` characters of combined stdout + stderr. */
	readonly outputTail: string;
}

const DEFAULT_TAIL_CHARS = 4096;

/**
 * Runs `command` with bash in `cwd`, in its own process group so a timeout kills build tools'
 * grandchildren too. Never rejects.
 */
export function runShellCommand(
	command: string,
	options: {
		readonly cwd: string;
		readonly timeoutMs: number;
		readonly env?: Readonly<Record<string, string>>;
		readonly tailChars?: number;
		readonly signal?: AbortSignal;
	},
): Promise<CommandOutput> {
	return runProcess("bash", ["-c", command], options);
}

export function runProcess(
	file: string,
	args: readonly string[],
	options: {
		readonly cwd: string;
		readonly timeoutMs: number;
		readonly env?: Readonly<Record<string, string>>;
		readonly tailChars?: number;
		readonly signal?: AbortSignal;
	},
): Promise<CommandOutput> {
	const tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS;
	const started = performance.now();
	return new Promise((resolve) => {
		let tail = "";
		let timedOut = false;
		let settled = false;
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const append = (chunk: Buffer) => {
			tail = (tail + chunk.toString()).slice(-tailChars);
		};
		const kill = () => killGroup(child.pid);
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", kill, { once: true });
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", kill);
			resolve({ exitCode, timedOut, durationMs: Math.round(performance.now() - started), outputTail: tail });
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", (error) => {
			append(Buffer.from(String(error)));
			finish(null);
		});
		child.on("close", (code) => finish(timedOut ? null : code));
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
