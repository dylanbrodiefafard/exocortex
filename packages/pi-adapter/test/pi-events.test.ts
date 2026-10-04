import { describe, expect, expectTypeOf, it } from "vitest";
import { PI_EVENT_NAMES, type UnlistedPiEvent } from "../src/pi-events.ts";

describe("PI_EVENT_NAMES", () => {
	it("covers every pi extension event (compile-time)", () => {
		expectTypeOf<UnlistedPiEvent>().toEqualTypeOf<never>();
	});

	it("has no duplicates", () => {
		expect(new Set(PI_EVENT_NAMES).size).toBe(PI_EVENT_NAMES.length);
	});
});
