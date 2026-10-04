import { describe, expect, it } from "vitest";
import { createDebugLog } from "../src/index.ts";

function capture(enabled = true, maxValueLength?: number) {
	const lines: string[] = [];
	let clock = 1000;
	const log = createDebugLog({
		enabled,
		write: (line) => lines.push(line),
		now: () => clock,
		...(maxValueLength === undefined ? {} : { maxValueLength }),
	});
	return { log, lines, advance: (ms: number) => (clock += ms) };
}

describe("createDebugLog", () => {
	it("writes one line per event with elapsed time and fields", () => {
		const { log, lines, advance } = capture();
		log.event("session_start", { reason: "startup" });
		advance(42);
		log.event("tool_result", { toolName: "bash", isError: false, chars: 120 });

		expect(lines).toEqual([
			"[exo +0ms] session_start reason=startup\n",
			"[exo +42ms] tool_result toolName=bash isError=false chars=120\n",
		]);
	});

	it("omits undefined fields and quotes values containing spaces, quotes or equals", () => {
		const { log, lines } = capture();
		log.event("input", { text: "fix the bug", source: undefined, eq: "a=b", empty: "", nul: null });
		expect(lines).toEqual(['[exo +0ms] input text="fix the bug" eq="a=b" empty="" nul=null\n']);
	});

	it("collapses whitespace and clips long strings", () => {
		const { log, lines } = capture(true, 10);
		log.event("x", { text: "line one\n\nline two and more" });
		expect(lines).toEqual(['[exo +0ms] x text="line one …"\n']);
	});

	it("is a no-op when disabled", () => {
		const { log, lines } = capture(false);
		log.event("anything", { a: 1 });
		expect(log.enabled).toBe(false);
		expect(lines).toEqual([]);
	});

	it("swallows writer errors", () => {
		const log = createDebugLog({
			enabled: true,
			write: () => {
				throw new Error("disk full");
			},
		});
		expect(() => log.event("x")).not.toThrow();
	});
});
