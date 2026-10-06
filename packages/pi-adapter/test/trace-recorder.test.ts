import { describe, expect, it } from "vitest";
import { exitCodeOf, exoModuleOf } from "../src/pi-shapes.ts";

describe("exoModuleOf", () => {
	it("identifies Exocortex-injected custom messages by customType prefix", () => {
		expect(exoModuleOf({ role: "custom", customType: "exo.supervisor" })).toBe("supervisor");
		expect(exoModuleOf({ role: "custom", customType: "exo.memory.card" })).toBe("memory");
	});

	it("ignores everything else", () => {
		expect(exoModuleOf({ role: "custom", customType: "other.thing" })).toBeUndefined();
		expect(exoModuleOf({ role: "user", customType: "exo.supervisor" })).toBeUndefined();
		expect(exoModuleOf({ role: "custom", customType: "exo." })).toBeUndefined();
		expect(exoModuleOf(null)).toBeUndefined();
	});
});

describe("exitCodeOf", () => {
	it("reads exit_code or exitCode", () => {
		expect(exitCodeOf({ exit_code: 2 })).toBe(2);
		expect(exitCodeOf({ exitCode: 0 })).toBe(0);
		expect(exitCodeOf({ exit_code: "2" })).toBeNull();
		expect(exitCodeOf(undefined)).toBeNull();
	});
});
