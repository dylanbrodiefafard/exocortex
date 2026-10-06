import { describe, expect, it } from "vitest";
import { type Block, findBlocks } from "../src/blocks.ts";

/** Each block as its rank and its lines, with `*` before the key lines. */
function shape(lines: readonly string[]): { rank: number; lines: string[] }[] {
	return findBlocks(lines).map((block: Block) => ({
		rank: block.rank,
		lines: lines
			.slice(block.start, block.end + 1)
			.map((line, i) => `${block.keys.includes(block.start + i) ? "*" : " "}${line}`),
	}));
}
const texts = (lines: readonly string[]) =>
	findBlocks(lines).map((block) => lines.slice(block.start, block.end + 1).join("\n"));

describe("findBlocks", () => {
	it("ranks a named failure over a message, a notable line and a mention", () => {
		const lines = [
			"src/lib.rs:4:2: error: boom",
			"plain",
			"E   assert 1 == 2",
			"plain",
			"ValueError: bad",
			"plain",
			"server.go:88: handling request",
			"plain",
			"the upload failed twice",
			"plain",
			"test retries::on_failed_send ... ok",
			"test parse::fails_on_error_reply ... ok",
		];
		expect(findBlocks(lines).map((b) => [b.start, b.rank])).toEqual([
			[0, 4],
			[2, 3],
			[4, 3],
			[6, 2],
			[8, 1],
		]);
	});

	it("follows a compiler diagnostic through its snippet, including two-digit line numbers", () => {
		const lines = [
			"error[E0308]: mismatched types",
			"  --> src/lib.rs:12:17",
			"   |",
			'12 |     let x: u8 = "a";',
			"   |                 ^^^ expected `u8`, found `&str`",
			"   |",
			"   = note: expected type `u8`",
			"",
			"error: aborting due to 1 previous error",
		];
		expect(texts(lines)).toEqual([lines.slice(0, 7).join("\n"), "error: aborting due to 1 previous error"]);
	});

	it("ends a traceback at its exception line, whatever the exception is called", () => {
		const lines = [
			"starting",
			"Traceback (most recent call last):",
			'  File "run.py", line 3, in <module>',
			"    main()",
			'  File "db.py", line 41, in connect',
			"    engine = settings.DATABASES",
			"django.core.exceptions.ImproperlyConfigured: no DATABASES",
			"shutting down",
		];
		expect(shape(lines)).toEqual([
			{
				rank: 4,
				lines: [
					"*Traceback (most recent call last):",
					'   File "run.py", line 3, in <module>',
					"     main()",
					'*  File "db.py", line 41, in connect',
					"*    engine = settings.DATABASES",
					"*django.core.exceptions.ImproperlyConfigured: no DATABASES",
				],
			},
		]);
	});

	it("keeps an indented traceback, a message that runs on, and a chained traceback together", () => {
		const lines = [
			"    Traceback (most recent call last):",
			'      File "a.py", line 1, in f',
			"        g()",
			"    KeyError: 'x'",
			"",
			"    During handling of the above exception, another exception occurred:",
			"",
			"    Traceback (most recent call last):",
			'      File "b.py", line 2, in h',
			"        raise Failure(x) from None",
			"    app.Failure: could not load",
			"      detail: x was missing",
			"",
			"    next",
			"Traceback (most recent call last):",
		];
		const blocks = findBlocks(lines);
		expect(blocks.map((b) => [b.start, b.end, b.rank])).toEqual([
			[0, 11, 4],
			[14, 14, 4],
		]);
		expect(blocks[0]?.keys).toEqual([0, 1, 2, 3, 7, 8, 9, 10]);
	});

	it("follows a unittest failure's header into its traceback", () => {
		const lines = [
			"FAIL: test_tags (tests.test_catalog.ProductTest.test_tags)",
			"----------------------------------------------------------------------",
			"Traceback (most recent call last):",
			'  File "tests/test_catalog.py", line 50, in test_tags',
			"    self.assertEqual(tags, [])",
			"AssertionError: Lists differ: ['a'] != []",
			"",
			"----------------------------------------------------------------------",
			"Ran 4 tests in 0.002s",
		];
		expect(shape(lines)[0]).toEqual({
			rank: 4,
			lines: [
				"*FAIL: test_tags (tests.test_catalog.ProductTest.test_tags)",
				" ----------------------------------------------------------------------",
				"*Traceback (most recent call last):",
				'*  File "tests/test_catalog.py", line 50, in test_tags',
				"*    self.assertEqual(tags, [])",
				"*AssertionError: Lists differ: ['a'] != []",
			],
		});
	});

	it("runs a Go panic through its stacks and stops at what the program printed next", () => {
		const lines = [
			"panic: runtime error: invalid memory address or nil pointer dereference [recovered]",
			"\tpanic: runtime error: invalid memory address or nil pointer dereference",
			"[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x4a1b2c]",
			"",
			"goroutine 7 [running]:",
			"testing.tRunner.func1.2({0x4f2b40, 0x61c1f0})",
			"\t/usr/local/go/src/testing/testing.go:1631 +0x24a",
			"example.com/ledger.(*Book).Post(0x0)",
			"\t/home/dev/ledger/book.go:57 +0x1c",
			"",
			"goroutine 1 [chan receive]:",
			"testing.(*T).Run(0xc000082b60)",
			"\t/usr/local/go/src/testing/testing.go:1750 +0x3ab",
			"created by testing.(*T).Run in goroutine 1",
			"\t/usr/local/go/src/testing/testing.go:1742 +0x390",
			"exit status 2",
			"FAIL\texample.com/ledger\t0.012s",
		];
		const [panic, ...rest] = findBlocks(lines);
		expect(panic).toMatchObject({ start: 0, end: 14, rank: 4, keys: [0, 1, 2, 4, 5, 6, 7, 8] });
		expect(rest.map((b) => lines[b.start])).toEqual(["FAIL\texample.com/ledger\t0.012s"]);
		// A fatal error with the runtime's own stack first; and one with nothing under it.
		const fatal = [
			"fatal error: all goroutines are asleep - deadlock!",
			"",
			"runtime stack:",
			"runtime.throw()",
			"\t/go/panic.go:1 +0x1",
			"",
			"done",
		];
		expect(findBlocks(fatal)[0]).toMatchObject({ start: 0, end: 4 });
		expect(findBlocks(["panic: boom", "next line"])[0]).toMatchObject({ start: 0, end: 0 });
	});

	it("keeps a race report from its rule to its rule, and a sanitizer's to its summary", () => {
		const race = [
			"==================",
			"WARNING: DATA RACE",
			"Write at 0x00c00012c0a8 by goroutine 9:",
			"  example.com/ledger.(*Book).Post()",
			"      /home/dev/ledger/book.go:57 +0x64",
			"",
			"Previous read at 0x00c00012c0a8 by goroutine 8:",
			"  example.com/ledger.(*Book).Balance()",
			"      /home/dev/ledger/book.go:41 +0x3c",
			"==================",
			"after",
		];
		expect(findBlocks(race)).toEqual([{ start: 0, end: 9, rank: 4, header: 1, keys: [1, 2, 3, 4, 6, 7, 8, 9] }]);
		// The report can start without its rule, and be cut off before its end.
		expect(findBlocks(race.slice(1, 5))).toEqual([{ start: 0, end: 3, rank: 4, header: 0, keys: [0, 1, 2, 3] }]);
		const tsan = [
			"WARNING: ThreadSanitizer: data race (pid=4242)",
			"  Write of size 4 at 0x7b0400000000 by thread T1:",
			"    #0 Counter::bump() /src/counter.cc:12:9",
			"",
			"SUMMARY: ThreadSanitizer: data race /src/counter.cc:12:9 in Counter::bump()",
			"==================",
		];
		expect(findBlocks(tsan)[0]).toMatchObject({ start: 0, end: 5, rank: 4 });
		const leak = [
			"==77==ERROR: LeakSanitizer: detected memory leaks",
			"",
			"Direct leak of 48 byte(s) in 1 object(s) allocated from:",
			"    #0 0x7f in operator new(unsigned long)",
			"    #1 0x55 in Table::grow() /src/table.cc:88:14",
			"",
			"SUMMARY: AddressSanitizer: 48 byte(s) leaked in 1 allocation(s).",
			"after",
		];
		expect(findBlocks(leak)).toEqual([{ start: 0, end: 6, rank: 4, header: 0, keys: [0, 1, 6] }]);
	});

	it("takes each failing case of a pytest report as a block, and nothing outside the report", () => {
		const lines = [
			"_________ not a report _________",
			"=================================== FAILURES ===================================",
			"___________________________ test_convert[10-km] ___________________________",
			"",
			"    def test_convert(value):",
			">       assert convert(value) == 6.21",
			"E       assert 6.2 == 6.21",
			"",
			"tests/test_units.py:27: AssertionError",
			"----------------------------- Captured log call -----------------------------",
			"INFO loading",
			"",
			"___________________________ test_convert[25-km] ___________________________",
			">       assert convert(value) == 15.53",
			"E       assert 15.5 == 15.53",
			"=========================== short test summary info ============================",
			"FAILED tests/test_units.py::test_convert[10-km] - assert 6.2 == 6.21",
			"_________ nor this _________",
		];
		expect(findBlocks(lines)).toEqual([
			// The banner only mentions failures.
			{ start: 1, end: 1, rank: 1, header: 1, keys: [1] },
			{ start: 2, end: 10, rank: 4, header: 2, keys: [2, 5, 6, 8] },
			{ start: 12, end: 14, rank: 4, header: 12, keys: [12, 13, 14] },
			{ start: 16, end: 16, rank: 4, header: 16, keys: [16] },
		]);
	});

	it("takes what a failing Rust test printed, its panic and libtest's list of names", () => {
		const lines = [
			"failures:",
			"",
			"---- settle::tests::rounds_half_even stdout ----",
			"settling 1050",
			"",
			"thread 'settle::tests::rounds_half_even' panicked at src/settle.rs:88:9:",
			"assertion `left == right` failed",
			"  left: 349",
			" right: 350",
			"note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
			"",
			"---- book::tests::returns_err stdout ----",
			"Error: ParseError { line: 3 }",
			"",
			"",
			"failures:",
			"    book::tests::returns_err",
			"    settle::tests::rounds_half_even",
			"",
			"test result: FAILED. 2 passed; 2 failed",
		];
		expect(findBlocks(lines)).toEqual([
			{ start: 0, end: 0, rank: 1, header: 0, keys: [0] },
			{ start: 2, end: 9, rank: 4, header: 2, keys: [2, 5, 6, 7, 8, 9] },
			{ start: 11, end: 12, rank: 4, header: 11, keys: [11, 12] },
			{ start: 15, end: 17, rank: 4, header: 15, keys: [15] },
			{ start: 19, end: 19, rank: 4, header: 19, keys: [19] },
		]);
		// A panic outside libtest's report: its message, a backtrace, and no further than the next test.
		const loose = [
			"thread 'main' (4242) panicked at src/main.rs:10:5:",
			"called `Option::unwrap()` on a `None` value",
			"stack backtrace:",
			"   0: rust_begin_unwind",
			"   1: core::panicking::panic_fmt",
			"   2: core::option::unwrap_failed",
			"   3: settle::main",
			"             at ./src/main.rs:10:5",
			"note: Some details are omitted, run with `RUST_BACKTRACE=full` for a verbose backtrace.",
			"the program's next line",
			"test settle::tests::a ... FAILED",
		];
		expect(findBlocks(loose).map((b) => [b.start, b.end])).toEqual([
			[0, 8],
			[10, 10],
		]);
		expect(findBlocks(["thread 'a' panicked at src/a.rs:1:1:", "boom", "test b ... ok"])[0]).toMatchObject({ end: 1 });
	});

	it("gives go test -v output to the test that printed it", () => {
		const lines = [
			"=== RUN   TestPass",
			"    a_test.go:10: the upload failed, retrying",
			"    a_test.go:11: fine now",
			"--- PASS: TestPass (0.00s)",
			"=== RUN   TestParallel",
			"=== PAUSE TestParallel",
			"=== RUN   TestEaster",
			"=== RUN   TestEaster/1981",
			"    holiday_test.go:41: Easter(1981) = 1981-04-26, want 1981-04-19",
			"=== CONT  TestParallel",
			"    b_test.go:20: got 1, want 2",
			"--- FAIL: TestEaster (0.00s)",
			"    --- FAIL: TestEaster/1981 (0.00s)",
			"--- FAIL: TestParallel (0.00s)",
			"=== RUN   TestSkipped",
			"    c_test.go:5: no database",
			"--- SKIP: TestSkipped (0.00s)",
			"=== RUN   TestCrashed",
			"    d_test.go:9: about to crash",
			"FAIL\texample.com/ledger\t0.4s",
		];
		expect(findBlocks(lines)).toEqual([
			// A passing test's log is an error only in its own words.
			{ start: 1, end: 1, rank: 1, header: 1, keys: [1] },
			{ start: 7, end: 8, rank: 4, header: 7, keys: [7, 8] },
			{ start: 9, end: 13, rank: 4, header: 9, keys: [9, 10, 11, 12] },
			// A test with no result (the binary died in it): its log reads as any Go test log does.
			{ start: 18, end: 18, rank: 3, header: 18, keys: [18] },
			{ start: 19, end: 19, rank: 4, header: 19, keys: [19] },
		]);
	});

	it("finds nothing in output without errors", () => {
		expect(findBlocks(["=== RUN   TestA", "--- PASS: TestA (0.00s)", "PASS", "ok  \texample.com/x\t0.1s"])).toEqual([]);
		expect(findBlocks([])).toEqual([]);
	});
});
