/** Seeded generator (mulberry32) of uniform numbers in [0, 1), so runs and reports can be replayed. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** A Fisher–Yates shuffled copy of `items`, drawn from `random`. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const held = out[i] as T;
		out[i] = out[j] as T;
		out[j] = held;
	}
	return out;
}

/** A stable 32-bit seed from a base seed and any strings (FNV-1a), e.g. one per (task, repeat). */
export function deriveSeed(seed: number, ...parts: readonly string[]): number {
	let hash = (0x811c9dc5 ^ seed) >>> 0;
	for (const char of parts.join("\u0000")) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}
