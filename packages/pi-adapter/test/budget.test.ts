import { describe, expect, it } from "vitest";
import { remainingMs, withBudget } from "../src/budget.ts";

const never = <T>() => new Promise<T>(() => {});
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function reporter() {
	const errors: unknown[] = [];
	return { errors, onError: (error: unknown) => void errors.push(error) };
}

describe("withBudget", () => {
	it("returns the value of a function that finishes in time, sync or async", async () => {
		const { errors, onError } = reporter();
		expect(await withBudget(1_000, undefined, () => 1, onError)).toBe(1);
		expect(await withBudget(1_000, undefined, async () => "a", onError)).toBe("a");
		expect(await withBudget(1_000, undefined, () => undefined, onError)).toBeUndefined();
		expect(errors).toEqual([]);
	});

	it("gives up at the deadline and aborts the function's signal, whether or not it listens", async () => {
		const { errors, onError } = reporter();
		let signal: AbortSignal | undefined;
		const started = Date.now();
		const result = await withBudget(
			20,
			undefined,
			(s) => {
				signal = s;
				return never<string>();
			},
			onError,
		);
		expect(result).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(signal?.aborted).toBe(true);
		expect(errors).toEqual([]);
	});

	it("gives up as soon as the parent aborts, and does not start under an aborted parent or with no time", async () => {
		const { onError } = reporter();
		const parent = new AbortController();
		let signal: AbortSignal | undefined;
		const pending = withBudget(
			60_000,
			parent.signal,
			(s) => {
				signal = s;
				return never<string>();
			},
			onError,
		);
		await tick();
		expect(signal?.aborted).toBe(false);
		parent.abort();
		expect(await pending).toBeUndefined();
		expect(signal?.aborted).toBe(true);

		let calls = 0;
		const count = () => {
			calls += 1;
			return 1;
		};
		expect(await withBudget(60_000, parent.signal, count, onError)).toBeUndefined();
		expect(await withBudget(0, undefined, count, onError)).toBeUndefined();
		expect(await withBudget(Number.NaN, undefined, count, onError)).toBeUndefined();
		expect(calls).toBe(0);
	});

	it("never rejects: throws and rejections are reported, also after the deadline", async () => {
		const { errors, onError } = reporter();
		const boom = new Error("boom");
		expect(
			await withBudget(
				1_000,
				undefined,
				() => {
					throw boom;
				},
				onError,
			),
		).toBeUndefined();
		expect(await withBudget(1_000, undefined, () => Promise.reject(boom), onError)).toBeUndefined();
		expect(errors).toEqual([boom, boom]);

		// A rejection that arrives after the caller has moved on must not go unhandled.
		const late = new Error("late");
		expect(
			await withBudget(
				5,
				undefined,
				async () => {
					await tick(30);
					throw late;
				},
				onError,
			),
		).toBeUndefined();
		await tick(60);
		expect(errors).toEqual([boom, boom, late]);
	});

	it("survives an error reporter that throws", async () => {
		const result = await withBudget(
			1_000,
			undefined,
			() => Promise.reject(new Error("x")),
			() => {
				throw new Error("reporter");
			},
		);
		expect(result).toBeUndefined();
	});

	it("does not abort the signal of a function that finished, and takes delays past setTimeout's range", async () => {
		const { onError } = reporter();
		const parent = new AbortController();
		let signal: AbortSignal | undefined;
		// Without a cap, setTimeout would fire at once for a delay this long.
		const result = await withBudget(
			2 ** 40,
			parent.signal,
			async (s) => {
				signal = s;
				await tick();
				return "done";
			},
			onError,
		);
		expect(result).toBe("done");
		parent.abort();
		expect(signal?.aborted).toBe(false);
	});
});

describe("remainingMs", () => {
	it("is the time to the deadline, never negative", () => {
		expect(remainingMs(Date.now() - 50)).toBe(0);
		const left = remainingMs(Date.now() + 1_000);
		expect(left).toBeGreaterThan(900);
		expect(left).toBeLessThanOrEqual(1_000);
	});
});
