import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultDraft } from "@exocortex/core";
import { createTestModuleContext, type SidecarReply } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSettings } from "../src/settings.ts";
import { createTriage, errorExcerpt, isBenign, ungroundedReferences } from "../src/triage.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-triage-"));
	writeFileSync(join(dir, "lib.rs"), "fn main() {}\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const RUST_ERROR =
	"   Compiling forth\nerror[E0502]: cannot borrow `self.stack` as mutable\n  --> src/lib.rs:42:9\nerror: could not compile";

function draft(output: string, extra: Partial<ToolResultDraft> = {}): ToolResultDraft {
	return {
		toolName: "bash",
		toolCallId: "c1",
		input: { command: "cargo build" },
		isError: true,
		exitCode: 101,
		output,
		current: output,
		fullOutputPath: null,
		...extra,
	};
}

function setup(settings: Record<string, unknown> = {}, reply?: (prompt: string) => SidecarReply) {
	const t = createTestModuleContext({
		cwd: dir,
		...(reply ? { reply: (request) => reply(String(request.messages[0]?.["content"])) } : {}),
	});
	return { t, triage: createTriage(settings, t.context) };
}

async function fail(triage: ReturnType<typeof createTriage>, d: ToolResultDraft) {
	triage.onToolResult?.(d);
	return triage.rewriteToolResult?.(d, signal);
}

describe("triage", () => {
	it("ignores successes and leaves a first failure alone when its error is near the top", async () => {
		const { triage, t } = setup({}, () => ({ diagnosis: "x", next_action: "y" }));
		expect(await fail(triage, draft("ok", { isError: false, exitCode: 0 }))).toBeUndefined();
		expect(await fail(triage, draft(RUST_ERROR))).toBeUndefined();
		expect(t.requests).toEqual([]);
	});

	it("surfaces a buried first error at the top on the first failure", async () => {
		const { triage } = setup();
		const noisy = `${Array.from({ length: 30 }, (_, i) => `note ${i}`).join("\n")}\n${RUST_ERROR}`;
		const rewrite = await fail(triage, draft(noisy));
		expect(rewrite?.text.split("\n")[0]).toBe(
			"[exo triage: first error (line 32): error[E0502]: cannot borrow `self.stack` as mutable]",
		);
		expect(rewrite?.note).toBe("surfaced the first error");
	});

	it("on a repeat, appends a runtime notice and a grounded hint", async () => {
		const prompts: string[] = [];
		const { triage } = setup({}, (prompt) => {
			prompts.push(prompt);
			return {
				diagnosis: "The borrow of `self.stack` outlives the push in lib.rs.",
				next_action: "Clone the value before mutating.",
			};
		});
		triage.onUserTurn?.({ text: "implement forth", origin: "user" });
		await fail(triage, draft(RUST_ERROR));
		const second = draft(RUST_ERROR.replace("42:9", "57:3"));
		const rewrite = await fail(triage, second);
		expect(rewrite?.text.startsWith(RUST_ERROR.replace("42:9", "57:3"))).toBe(true);
		expect(rewrite?.text).toContain(
			"[exo triage: this failed again with the same error (error[E0502]: cannot borrow `self.stack` as mutable); it is the 2nd time this task.",
		);
		expect(rewrite?.text).toContain(
			"[exo triage hint: The borrow of `self.stack` outlives the push in lib.rs. Clone the value before mutating.]",
		);
		expect(rewrite?.note).toBe("repeat 2 + hint");
		expect(prompts[0]).toContain("implement forth");
		expect(prompts[0]).toContain("- cargo build → exit 101");
		expect(prompts[0]).toContain("happened 2 times");
		expect(triage.status?.()).toBe("triage (1 repeats, 1 hints)");
	});

	it("escalates at the loop threshold and caps hints per signature", async () => {
		let calls = 0;
		const { triage } = setup({ maxHintsPerSignature: 1 }, () => {
			calls += 1;
			return { diagnosis: "Still the borrow.", next_action: "Restructure it." };
		});
		await fail(triage, draft(RUST_ERROR));
		await fail(triage, draft(RUST_ERROR));
		const third = await fail(triage, draft(RUST_ERROR));
		expect(third?.text).toContain("this has now failed 3 times");
		expect(third?.text).toContain("stop retrying it");
		expect(third?.text).not.toContain("hint:");
		expect(calls).toBe(1);
	});

	it("drops hints naming files or symbols absent from the evidence and workspace", async () => {
		const { triage, t } = setup({}, () => ({
			diagnosis: "The bug is in `parser_state` of src/parser.rs.",
			next_action: "Fix it.",
		}));
		await fail(triage, draft(RUST_ERROR));
		const rewrite = await fail(triage, draft(RUST_ERROR));
		expect(rewrite?.text).not.toContain("hint:");
		expect(rewrite?.note).toBe("repeat 2");
		expect(t.logs.some((l) => l.includes("parser_state") && l.includes("src/parser.rs"))).toBe(true);
	});

	it("degrades to the notice when the sidecar fails, is empty, is disabled or has no engine", async () => {
		for (const [settings, reply] of [
			[{}, new Error("down")],
			[{}, { diagnosis: "", next_action: "" }],
			[{ sidecar: false }, { diagnosis: "a", next_action: "b" }],
		] as const) {
			const { triage } = setup(settings, () => reply);
			await fail(triage, draft(RUST_ERROR));
			expect((await fail(triage, draft(RUST_ERROR)))?.note).toBe("repeat 2");
		}
		const { triage } = setup();
		await fail(triage, draft(RUST_ERROR));
		expect((await fail(triage, draft(RUST_ERROR)))?.note).toBe("repeat 2");
	});

	it("counts per task: a new user request resets, an extension continuation does not", async () => {
		const { triage } = setup({ sidecar: false });
		await fail(triage, draft(RUST_ERROR));
		triage.onUserTurn?.({ text: "keep going", origin: "extension" });
		expect((await fail(triage, draft(RUST_ERROR)))?.note).toBe("repeat 2");
		triage.onUserTurn?.({ text: "something else", origin: "user" });
		expect(await fail(triage, draft(RUST_ERROR))).toBeUndefined();
	});

	it("treats a different error as a new failure", async () => {
		const { triage } = setup({ sidecar: false });
		await fail(triage, draft(RUST_ERROR));
		expect(await fail(triage, draft("error[E0308]: mismatched types"))).toBeUndefined();
	});

	it("skips benign exit codes (no grep match) and counts non-error failures with no error line", async () => {
		const { triage } = setup({ sidecar: false });
		const grep = draft("", { input: { command: "cd src && grep -rn foo ." }, exitCode: 1 });
		expect(await fail(triage, grep)).toBeUndefined();
		expect(await fail(triage, grep)).toBeUndefined();
		const silent = draft("nothing useful", { input: { command: "./run.sh" }, exitCode: 3, isError: false });
		await fail(triage, silent);
		const rewrite = await fail(triage, silent);
		expect(rewrite?.text).toContain("this failed again the same way");
	});

	it("reports invalid settings", () => {
		const { t } = setup({ loopThreshold: 1 });
		expect(t.logs.some((l) => l.startsWith("triage /loopThreshold"))).toBe(true);
	});
});

describe("isBenign", () => {
	const settings = parseSettings({}).settings;
	const of = (command: string, exitCode: number | null = 1) =>
		isBenign({ exitCode, input: { command }, toolName: "bash" }, settings);
	it("matches the last step's command word only for exit code 1", () => {
		expect(of("grep -q x file")).toBe(true);
		expect(of("LC_ALL=C rg foo")).toBe(true);
		expect(of("make && git diff --exit-code")).toBe(true);
		expect(of("grep x file", 2)).toBe(false);
		expect(of("grepx file")).toBe(false);
		expect(of("grep x file && make")).toBe(false);
		expect(isBenign({ exitCode: 1, input: {}, toolName: "read" }, settings)).toBe(false);
	});
});

describe("errorExcerpt", () => {
	it("keeps the first error with context and the tail, marking gaps", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
		lines[30] = "error: boom";
		const excerpt = errorExcerpt(lines.join("\n")).split("\n");
		expect(excerpt[0]).toBe("line 28");
		expect(excerpt).toContain("error: boom");
		expect(excerpt).toContain("[…]");
		expect(excerpt.at(-1)).toBe("line 59");
	});
	it("starts at the top when there is no error line", () => {
		expect(errorExcerpt("a\nb")).toBe("a\nb");
	});
});

describe("ungroundedReferences", () => {
	it("accepts references found in the evidence or the workspace", () => {
		expect(
			ungroundedReferences("Fix `self.stack` in src/lib.rs:42 and lib.rs.", "src/lib.rs:42:9 `self.stack`", dir),
		).toEqual([]);
	});
	it("flags invented paths and identifiers, but not commands", () => {
		expect(ungroundedReferences("Edit src/nope.rs and `ghost_fn`, then run `cargo test`.", "", dir)).toEqual([
			"ghost_fn",
			"src/nope.rs",
		]);
	});
});
