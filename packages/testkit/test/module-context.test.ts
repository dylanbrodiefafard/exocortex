import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createTestModuleContext } from "../src/module-context.ts";

describe("test module context: persisted state (D-078)", () => {
	it("captures what a module saves and hands it to the next instance", () => {
		const first = createTestModuleContext({ cwd: tmpdir() });
		expect(first.context.sessionId).toBe("test-session");
		expect(first.context.savedState).toBeUndefined();
		const counts = { failures: 1 };
		first.context.saveState(counts);
		counts.failures = 2;
		first.context.saveState(counts);
		// A copy is kept each time, as a session file would: later changes to the object do not reach it.
		expect(first.states).toEqual([{ failures: 1 }, { failures: 2 }]);

		const savedState = first.states.at(-1);
		const next = createTestModuleContext({
			cwd: tmpdir(),
			sessionId: "resumed",
			...(savedState === undefined ? {} : { savedState }),
		});
		expect(next.context.sessionId).toBe("resumed");
		expect(next.context.savedState).toEqual({ failures: 2 });
		expect(next.states).toEqual([]);
	});
});
