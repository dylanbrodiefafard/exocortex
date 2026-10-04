/** Scalar summary values a debug line can show. Anything richer is summarized by the caller. */
export type DebugValue = string | number | boolean | null | undefined;

export type DebugFields = Readonly<Record<string, DebugValue>>;

export interface DebugLog {
	readonly enabled: boolean;
	/** Writes one line: `[exo +<ms>] <name> k=v ...`. No-op when disabled. Never throws. */
	event(name: string, fields?: DebugFields): void;
}

export interface DebugLogOptions {
	readonly enabled: boolean;
	readonly write: (line: string) => void;
	/** Monotonic milliseconds; defaults to `performance.now`. */
	readonly now?: () => number;
	/** Maximum characters shown per string value. */
	readonly maxValueLength?: number;
}

const DEFAULT_MAX_VALUE_LENGTH = 80;

export function createDebugLog(options: DebugLogOptions): DebugLog {
	const now = options.now ?? (() => performance.now());
	const maxValueLength = options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH;
	const start = now();

	if (!options.enabled) {
		return { enabled: false, event: () => {} };
	}

	return {
		enabled: true,
		event(name, fields = {}) {
			try {
				const elapsed = Math.round(now() - start);
				const parts = Object.entries(fields)
					.filter(([, value]) => value !== undefined)
					.map(([key, value]) => `${key}=${formatValue(value, maxValueLength)}`);
				options.write(`[exo +${elapsed}ms] ${[name, ...parts].join(" ")}\n`);
			} catch {
				// Debug output must never break the host.
			}
		},
	};
}

function formatValue(value: DebugValue, maxLength: number): string {
	if (typeof value !== "string") return String(value);
	const singleLine = value.replace(/\s+/g, " ");
	const clipped = singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
	return /[\s="]/.test(clipped) || clipped === "" ? JSON.stringify(clipped) : clipped;
}
