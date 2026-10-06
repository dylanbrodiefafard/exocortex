import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestModuleContext } from "@exocortex/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTrimmer } from "../src/trimmer.ts";

/**
 * Long, real-shaped outputs for the D-016 toolchains, each with one failure the agent needs
 * (D-083). Every scenario says which lines must survive: the failing test's name, where it
 * failed and what it said. `maxChars` is checked on each, at the default and at a tight setting.
 */

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "exo-trim-scn-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const DEFAULT_MAX_CHARS = 24_000;
const TIGHT_MAX_CHARS = 4_000;

/** Distinct letters per index, so generated lines differ in more than their numbers. */
function letters(n: number): string {
	let s = "";
	let i = n;
	do {
		s = String.fromCharCode(97 + (i % 26)) + s;
		i = Math.floor(i / 26) - 1;
	} while (i >= 0);
	return s;
}
const word = (n: number) => `${letters(n)}${letters(n * 7 + 3)}${letters(n * 13 + 5)}`;
const repeat = (n: number, line: (i: number) => string | readonly string[]) =>
	Array.from({ length: n }, (_, i) => line(i)).flat();

async function trim(log: string, command: string, settings: Record<string, unknown> = {}): Promise<string> {
	const { context } = createTestModuleContext({ cwd: dir });
	const trimmer = createTrimmer({ saveDir: join(dir, "saved"), ...settings }, context);
	const rewrite = await trimmer.rewriteToolResult?.(
		{
			toolName: "bash",
			toolCallId: "call-1",
			input: { command },
			isError: true,
			exitCode: 1,
			output: log,
			current: log,
			fullOutputPath: null,
			status: null,
		},
		signal,
	);
	if (!rewrite) throw new Error("expected a rewrite");
	return rewrite.text;
}

interface Scenario {
	readonly name: string;
	readonly command: string;
	readonly log: string;
	/** Lines (or parts of lines) that must be shown at the default settings. */
	readonly needed: readonly string[];
	/** What must still be shown when `maxChars` is tight: one failure's name, place and message. */
	readonly essential: readonly string[];
}

const goPassingTest = (i: number) => [
	`=== RUN   TestLedger_${word(i)}`,
	`    ledger_test.go:${20 + i}: posting the ${word(i + 1)} batch to account ${word(i + 2)}`,
	`    ledger_test.go:${21 + i}: balance of ${word(i + 3)} is ${i * 17} cents after ${word(i + 4)}`,
	`    ledger_test.go:${22 + i}: closed the ${word(i + 5)} period`,
	`--- PASS: TestLedger_${word(i)} (0.00s)`,
];

const GO_VERBOSE: Scenario = {
	name: "go test -v: one failing test between many passing tests that log",
	command: "go test -v ./...",
	log: [
		...repeat(35, goPassingTest),
		"=== RUN   TestSettleRounding",
		"    settle_test.go:84: settling 1050 cents across 3 accounts",
		"    settle_test.go:88: Settle(1050, 3) = 349, want 350",
		"--- FAIL: TestSettleRounding (0.00s)",
		...repeat(35, (i) => goPassingTest(i + 35)),
		"FAIL",
		"exit status 1",
		"FAIL\texample.com/ledger\t0.412s",
	].join("\n"),
	needed: [
		"=== RUN   TestSettleRounding",
		"    settle_test.go:84: settling 1050 cents across 3 accounts",
		"    settle_test.go:88: Settle(1050, 3) = 349, want 350",
		"--- FAIL: TestSettleRounding (0.00s)",
		"FAIL\texample.com/ledger\t0.412s",
	],
	essential: ["--- FAIL: TestSettleRounding (0.00s)", "settle_test.go:88: Settle(1050, 3) = 349, want 350"],
};

const GO_POSITIONS = ["./book.go:41:9", "./book.go:57:12", "./book.go:88:9", "./settle.go:19:14", "./settle.go:63:9"];
const GO_BUILD: Scenario = {
	name: "go build: the same error at several positions",
	command: "go build ./...",
	log: [
		...repeat(220, (i) => `go: downloading github.com/${word(i)}/${word(i + 1)} v1.${i}.0`),
		"# example.com/ledger",
		...GO_POSITIONS.map((at) => `${at}: undefined: roundHalfEven`),
	].join("\n"),
	needed: GO_POSITIONS.map((at) => `${at}: undefined: roundHalfEven`),
	essential: ["./book.go:41:9: undefined: roundHalfEven"],
};

const CPP_POSITIONS = [
	"../src/net.cc:120:9",
	"../src/net.cc:188:9",
	"../src/net.cc:243:11",
	"../src/net.cc:301:9",
	"../src/route.cc:77:14",
];
const ninjaStep = (i: number) =>
	`[${i + 1}/460] Building CXX object src/CMakeFiles/netcalc.dir/${word(i)}_${word(i + 1)}.cc.o`;
const CPP_BUILD: Scenario = {
	name: "ninja with clang: errors that differ only in position, in the middle of a build that goes on",
	command: "ninja -C build -k 0",
	log: [
		...repeat(200, ninjaStep),
		"FAILED: src/CMakeFiles/netcalc.dir/net.cc.o",
		"/usr/bin/clang++ -I../include -std=c++20 -fno-caret-diagnostics -MD -MT src/CMakeFiles/netcalc.dir/net.cc.o -c ../src/net.cc",
		...CPP_POSITIONS.map((at) => `${at}: error: use of undeclared identifier 'checksum'`),
		"5 errors generated.",
		...repeat(240, (i) => ninjaStep(i + 201)),
		"ninja: build stopped: cannot make progress due to previous errors.",
	].join("\n"),
	needed: [
		"FAILED: src/CMakeFiles/netcalc.dir/net.cc.o",
		...CPP_POSITIONS.map((at) => `${at}: error: use of undeclared identifier 'checksum'`),
		"ninja: build stopped: cannot make progress due to previous errors.",
	],
	essential: ["../src/net.cc:120:9: error: use of undeclared identifier 'checksum'"],
};

const PYTEST_CASES = [
	{ id: "10-km-6.21", got: "6.2" },
	{ id: "25-km-15.53", got: "15.5" },
	{ id: "40-km-24.85", got: "24.9" },
	{ id: "55-km-34.18", got: "34.2" },
	{ id: "70-km-43.5", got: "43.4" },
	{ id: "85-km-52.82", got: "52.8" },
].map((c) => ({ ...c, want: c.id.split("-")[2] ?? "" }));
const PYTEST: Scenario = {
	name: "pytest: parametrised failures with captured logs",
	command: "python -m pytest -v",
	log: [
		"============================= test session starts ==============================",
		"platform linux -- Python 3.12.3, pytest-8.3.2, pluggy-1.5.0",
		"collected 186 items",
		"",
		...repeat(180, (i) => `tests/test_units.py::test_parse_${word(i)} PASSED [${Math.floor(i / 2)}%]`),
		...PYTEST_CASES.map((c) => `tests/test_units.py::test_convert[${c.id}] FAILED [ 99%]`),
		"",
		"=================================== FAILURES ===================================",
		...PYTEST_CASES.flatMap((c, n) => [
			`___________________________ test_convert[${c.id}] ___________________________`,
			"",
			`value = ${c.id.split("-")[0]}, unit = 'km', expected = ${c.want}`,
			"",
			'    @pytest.mark.parametrize("value,unit,expected", CASES)',
			"    def test_convert(value, unit, expected):",
			">       assert convert(value, unit) == expected",
			`E       assert ${c.got} == ${c.want}`,
			`E        +  where ${c.got} = convert(${c.id.split("-")[0]}, 'km')`,
			"",
			"tests/test_units.py:27: AssertionError",
			"------------------------------ Captured log call -------------------------------",
			...repeat(
				34,
				(i) => `INFO     units.tables:tables.py:${14 + i} loading the ${word(n * 40 + i)} table for ${word(i + n)}`,
			),
		]),
		"=========================== short test summary info ============================",
		...PYTEST_CASES.map((c) => `FAILED tests/test_units.py::test_convert[${c.id}] - assert ${c.got} == ${c.want}`),
		"======================== 6 failed, 180 passed in 1.42s =========================",
	].join("\n"),
	needed: [
		...PYTEST_CASES.flatMap((c) => [
			`___________________________ test_convert[${c.id}] ___________________________`,
			`E       assert ${c.got} == ${c.want}`,
			`FAILED tests/test_units.py::test_convert[${c.id}] - assert ${c.got} == ${c.want}`,
		]),
		">       assert convert(value, unit) == expected",
		"tests/test_units.py:27: AssertionError",
		"======================== 6 failed, 180 passed in 1.42s =========================",
	],
	essential: ["test_convert[10-km-6.21]", "E       assert 6.2 == 6.21", "tests/test_units.py:27: AssertionError"],
};

const TRACEBACK_FRAMES = repeat(17, (i) => [
	`  File "/srv/app/ingest/${word(i)}.py", line ${30 + i * 7}, in ${word(i + 1)}_step`,
	`    return self.${word(i + 2)}(batch, retries=${i})`,
]);
const PYTHON_TRACEBACK: Scenario = {
	name: "python: a deep traceback whose exception line is far from the end",
	command: "python -m ingest.run --all",
	log: [
		...repeat(
			150,
			(i) => `2026-10-05 12:00:${String(i % 60).padStart(2, "0")},123 INFO ingest: loaded shard ${word(i)}`,
		),
		"Traceback (most recent call last):",
		'  File "/srv/app/ingest/run.py", line 212, in <module>',
		"    main()",
		...TRACEBACK_FRAMES,
		'  File "/srv/app/ingest/db.py", line 41, in connect',
		'    engine = settings.DATABASES["default"]["ENGINE"]',
		"django.core.exceptions.ImproperlyConfigured: Requested setting DATABASES, but settings are not configured.",
		...repeat(
			150,
			(i) => `2026-10-05 12:01:${String(i % 60).padStart(2, "0")},456 INFO shutdown: flushed ${word(i + 9)}`,
		),
	].join("\n"),
	needed: [
		"Traceback (most recent call last):",
		'  File "/srv/app/ingest/run.py", line 212, in <module>',
		'  File "/srv/app/ingest/db.py", line 41, in connect',
		'    engine = settings.DATABASES["default"]["ENGINE"]',
		"django.core.exceptions.ImproperlyConfigured: Requested setting DATABASES, but settings are not configured.",
	],
	essential: [
		"Traceback (most recent call last):",
		'  File "/srv/app/ingest/db.py", line 41, in connect',
		"django.core.exceptions.ImproperlyConfigured: Requested setting DATABASES, but settings are not configured.",
	],
};

const GO_PANIC: Scenario = {
	name: "go: a panic with goroutine frames, then a wrapper script's output",
	command: "./scripts/settle-all.sh",
	log: [
		...repeat(160, (i) => `2026/10/05 12:00:01 settle: processed the ${word(i)} batch for ${word(i + 1)}`),
		"panic: runtime error: index out of range [5] with length 3",
		"",
		"goroutine 1 [running]:",
		"example.com/ledger.(*Book).Entry(...)",
		"\t/home/dev/ledger/book.go:73",
		"example.com/ledger.Settle(0xc000010000, 0x5)",
		"\t/home/dev/ledger/settle.go:41 +0x1d",
		"main.main()",
		"\t/home/dev/ledger/cmd/settle/main.go:22 +0x85",
		"",
		"goroutine 18 [chan receive]:",
		"example.com/ledger.(*Journal).flushLoop(0xc00007e000)",
		"\t/home/dev/ledger/journal.go:102 +0x4c",
		"created by example.com/ledger.NewJournal in goroutine 1",
		"\t/home/dev/ledger/journal.go:58 +0xd6",
		"exit status 2",
		...repeat(140, (i) => `cleanup: removing ${word(i)}.tmp from the ${word(i + 2)} spool`),
	].join("\n"),
	needed: [
		"panic: runtime error: index out of range [5] with length 3",
		"goroutine 1 [running]:",
		"\t/home/dev/ledger/book.go:73",
		"\t/home/dev/ledger/settle.go:41 +0x1d",
		"\t/home/dev/ledger/cmd/settle/main.go:22 +0x85",
		"goroutine 18 [chan receive]:",
	],
	essential: [
		"panic: runtime error: index out of range [5] with length 3",
		"goroutine 1 [running]:",
		"\t/home/dev/ledger/book.go:73",
	],
};

const RACE_REPORT = [
	"==================",
	"WARNING: DATA RACE",
	"Write at 0x00c00012c0a8 by goroutine 9:",
	"  example.com/ledger.(*Book).Post()",
	"      /home/dev/ledger/book.go:57 +0x64",
	"  example.com/ledger.TestConcurrentPost.func1()",
	"      /home/dev/ledger/book_test.go:112 +0x44",
	"",
	"Previous read at 0x00c00012c0a8 by goroutine 8:",
	"  example.com/ledger.(*Book).Balance()",
	"      /home/dev/ledger/book.go:41 +0x3c",
	"  example.com/ledger.TestConcurrentPost.func2()",
	"      /home/dev/ledger/book_test.go:116 +0x38",
	"",
	"Goroutine 9 (running) created at:",
	"  example.com/ledger.TestConcurrentPost()",
	"      /home/dev/ledger/book_test.go:110 +0x1a4",
	"  testing.tRunner()",
	"      /usr/local/go/src/testing/testing.go:1690 +0x226",
	"",
	"Goroutine 8 (running) created at:",
	"  example.com/ledger.TestConcurrentPost()",
	"      /home/dev/ledger/book_test.go:114 +0x2b0",
	"  testing.tRunner()",
	"      /usr/local/go/src/testing/testing.go:1690 +0x226",
	"==================",
];
const GO_RACE: Scenario = {
	name: "go test -race: a data-race report in the middle",
	command: "go test -race -v ./...",
	log: [
		...repeat(40, goPassingTest),
		"=== RUN   TestConcurrentPost",
		...RACE_REPORT,
		"    testing.go:1399: race detected during execution of test",
		"--- FAIL: TestConcurrentPost (0.01s)",
		...repeat(40, (i) => goPassingTest(i + 40)),
		"FAIL",
		"FAIL\texample.com/ledger\t1.108s",
	].join("\n"),
	needed: [...RACE_REPORT.filter((line) => line !== ""), "--- FAIL: TestConcurrentPost (0.01s)"],
	essential: [
		"WARNING: DATA RACE",
		"Write at 0x00c00012c0a8 by goroutine 9:",
		"      /home/dev/ledger/book.go:57 +0x64",
		"Previous read at 0x00c00012c0a8 by goroutine 8:",
		"--- FAIL: TestConcurrentPost (0.01s)",
	],
};

const flakyLog = (i: number) => `[sync] attempt ${i} failed for peer ${word(i)}: connection reset by ${word(i + 1)}`;
const RUST_TEST: Scenario = {
	name: "cargo test --no-fail-fast: one panic between crates whose tests log failures they handle",
	command: "cargo test --workspace --no-fail-fast -- --nocapture",
	log: [
		"     Running unittests src/lib.rs (target/debug/deps/sync-1f0e)",
		"running 60 tests",
		...repeat(60, (i) => [flakyLog(i), `test peers::tests::retries_${word(i)} ... ok`]),
		"test result: ok. 60 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s",
		"     Running unittests src/lib.rs (target/debug/deps/ledger-9c2d)",
		"running 3 tests",
		"test book::tests::posts_in_order ... ok",
		"test settle::tests::rounds_half_even ... FAILED",
		"test settle::tests::splits_evenly ... ok",
		"",
		"failures:",
		"",
		"---- settle::tests::rounds_half_even stdout ----",
		"",
		"thread 'settle::tests::rounds_half_even' (48213) panicked at crates/ledger/src/settle.rs:88:9:",
		"assertion `left == right` failed: settle(1050, 3)",
		"  left: 349",
		" right: 350",
		"note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
		"",
		"",
		"failures:",
		"    settle::tests::rounds_half_even",
		"",
		"test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s",
		"",
		"error: test failed, to rerun pass `-p ledger --lib`",
		"     Running unittests src/lib.rs (target/debug/deps/gateway-77ab)",
		"running 70 tests",
		...repeat(70, (i) => [flakyLog(i + 60), `test relay::tests::backoff_${word(i)} ... ok`]),
		"test result: ok. 70 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.44s",
		"error: 1 target failed:",
		"    `-p ledger --lib`",
	].join("\n"),
	needed: [
		"test settle::tests::rounds_half_even ... FAILED",
		"---- settle::tests::rounds_half_even stdout ----",
		"thread 'settle::tests::rounds_half_even' (48213) panicked at crates/ledger/src/settle.rs:88:9:",
		"assertion `left == right` failed: settle(1050, 3)",
		"  left: 349",
		" right: 350",
		"test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s",
	],
	essential: [
		"settle::tests::rounds_half_even",
		"panicked at crates/ledger/src/settle.rs:88:9:",
		"assertion `left == right` failed: settle(1050, 3)",
	],
};

const ASAN: Scenario = {
	name: "c++: an AddressSanitizer report with its second stack and summary",
	command: "ctest --test-dir build --output-on-failure",
	log: [
		...repeat(150, (i) => `[netcalc] parsed route ${word(i)}/24 via ${word(i + 1)} on ${word(i + 2)}`),
		"=================================================================",
		"==48213==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000014 at pc 0x55d0c2a1b3f1 bp 0x7ffd3b2c1a90 sp 0x7ffd3b2c1a88",
		"READ of size 4 at 0x602000000014 thread T0",
		"    #0 0x55d0c2a1b3f0 in Buffer::append(char const*, unsigned long) /home/dev/netcalc/src/buffer.cc:48:12",
		"    #1 0x55d0c2a1c7aa in RouteTable::flush() /home/dev/netcalc/src/route_table.cc:131:5",
		"    #2 0x55d0c2a1d102 in main /home/dev/netcalc/src/main.cc:27:9",
		"",
		"0x602000000014 is located 4 bytes inside of 16-byte region [0x602000000010,0x602000000020)",
		"freed by thread T0 here:",
		"    #0 0x7f3a5c4b6537 in operator delete(void*) (/lib/x86_64-linux-gnu/libasan.so.8+0xb6537)",
		"    #1 0x55d0c2a1b1c4 in Buffer::reset() /home/dev/netcalc/src/buffer.cc:31:3",
		"",
		"previously allocated by thread T0 here:",
		"    #0 0x7f3a5c4b5af8 in operator new(unsigned long) (/lib/x86_64-linux-gnu/libasan.so.8+0xb5af8)",
		"    #1 0x55d0c2a1b0d2 in Buffer::Buffer(unsigned long) /home/dev/netcalc/src/buffer.cc:12:11",
		"",
		"SUMMARY: AddressSanitizer: heap-use-after-free /home/dev/netcalc/src/buffer.cc:48:12 in Buffer::append(char const*, unsigned long)",
		"Shadow bytes around the buggy address:",
		...repeat(12, (i) => `  0x6020000000${i}0: fa fa fd fd fa fa 00 00 fa fa fd fa fa fa 00 0${i}`),
		"==48213==ABORTING",
		...repeat(140, (i) => `[netcalc] replayed capture ${word(i + 3)} against ${word(i + 5)}`),
	].join("\n"),
	needed: [
		"==48213==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000014",
		"    #0 0x55d0c2a1b3f0 in Buffer::append(char const*, unsigned long) /home/dev/netcalc/src/buffer.cc:48:12",
		"freed by thread T0 here:",
		"    #1 0x55d0c2a1b1c4 in Buffer::reset() /home/dev/netcalc/src/buffer.cc:31:3",
		"previously allocated by thread T0 here:",
		"SUMMARY: AddressSanitizer: heap-use-after-free /home/dev/netcalc/src/buffer.cc:48:12",
	],
	essential: [
		"==48213==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000014",
		"/home/dev/netcalc/src/buffer.cc:48:12",
		"SUMMARY: AddressSanitizer: heap-use-after-free",
	],
};

const SCENARIOS = [GO_VERBOSE, GO_BUILD, CPP_BUILD, PYTEST, PYTHON_TRACEBACK, GO_PANIC, GO_RACE, RUST_TEST, ASAN];

describe("what a trimmed output must still show", () => {
	for (const scenario of SCENARIOS) {
		it(`${scenario.name}`, async () => {
			expect(scenario.log.length).toBeGreaterThan(8_000);
			const text = await trim(scenario.log, scenario.command);
			for (const line of scenario.needed) expect(text, line).toContain(line);
			expect(text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
			expect(text.length).toBeLessThan(scenario.log.length);
		});

		it(`${scenario.name}, within a tight maxChars`, async () => {
			const text = await trim(scenario.log, scenario.command, { maxChars: TIGHT_MAX_CHARS });
			expect(text.length).toBeLessThanOrEqual(TIGHT_MAX_CHARS);
			for (const line of scenario.essential) expect(text, line).toContain(line);
		});
	}

	it("does not show a passing Go test's log in place of the failing one's", async () => {
		// Without the head, the tail and the lines around an error, what is left is what counted as one.
		const text = await trim(GO_VERBOSE.log, GO_VERBOSE.command, { headLines: 0, tailLines: 0, contextLines: 0 });
		const logs = text.split("\n").filter((line) => /_test\.go:\d+: /.test(line));
		expect(logs).toEqual([
			"    settle_test.go:84: settling 1050 cents across 3 accounts",
			"    settle_test.go:88: Settle(1050, 3) = 349, want 350",
		]);
	});
});
