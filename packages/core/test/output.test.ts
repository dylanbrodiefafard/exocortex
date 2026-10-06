import { describe, expect, it } from "vitest";
import {
	classifyErrorLine,
	cleanTerminalOutput,
	errorLineIndices,
	errorSignature,
	firstErrorLine,
	isRoutineLine,
	lineVerdicts,
	normalizeErrorLine,
	ungroundedReferences,
} from "../src/modules/output.ts";

describe("cleanTerminalOutput", () => {
	it("strips ANSI escapes and keeps the final state of redrawn lines", () => {
		expect(cleanTerminalOutput("\u001b[31merror\u001b[0m: x")).toBe("error: x");
		expect(cleanTerminalOutput("10%\r50%\r100% done\r\nnext")).toBe("100% done\nnext");
		expect(cleanTerminalOutput("\u001b]0;title\u0007plain")).toBe("plain");
	});

	it("removes each OSC sequence on its own, not what lies between two of them", () => {
		const link = (url: string, text: string) => `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`;
		const output = `${link("file:///a.rs", "a.rs")}: error here\nmiddle line\n${link("file:///b.rs", "b.rs")}: fine`;
		expect(cleanTerminalOutput(output)).toBe("a.rs: error here\nmiddle line\nb.rs: fine");
		expect(cleanTerminalOutput("\u001b]0;one\u0007kept\u001b]0;two\u0007")).toBe("kept");
		// An unterminated sequence does not swallow the lines after it.
		expect(cleanTerminalOutput("\u001b]0;title\nnext line\u0007")).toContain("next line");
	});
});

describe("classifyErrorLine", () => {
	it.each([
		["error[E0502]: cannot borrow `x` as mutable", "specific"],
		["error: could not compile `forth`", "specific"],
		["thread 'main' panicked at src/main.rs:3:5:", "specific"],
		["thread 'simple_table' (207059) panicked at tests/render.rs:8:5:", "specific"],
		["test tests::parse ... FAILED", "specific"],
		["./limiter.go:42:7: undefined: Limit", "specific"],
		["    --- FAIL: TestBurst (0.00s)", "specific"],
		["FAIL\texample.com/rl\t0.004s", "specific"],
		["src/ring.hpp:17:3: error: no matching function for call to 'push'", "specific"],
		["/usr/bin/ld: main.o: undefined reference to `foo'", "specific"],
		["make[2]: *** [CMakeFiles/x.dir/build.make:76: x] Error 1", "specific"],
		["Traceback (most recent call last):", "specific"],
		["E   AssertionError: assert 3 == 4", "specific"],
		["FAILED tests/test_page.py::test_last - assert 1 == 2", "specific"],
		["FAIL: test_tags (tests.test_catalog.ProductTest.test_tags)", "specific"],
		["ERROR: test_load (tests.test_io.LoadTest.test_load)", "specific"],
		["AssertionError", "specific"],
		["not ok 4311 - ipv6 format: rejects '::ffff:01.2.3.4'", "specific"],
		["[  FAILED  ] RingTest.Wraps (0 ms)", "specific"],
		["    holiday_test.go:41: Easter(1981) = 1981-04-26, want 1981-04-19", "specific"],
		["UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff", "specific"],
		["src/a.ts(3,1): error TS2322: Type 'x' is not assignable", "specific"],
		["Something failed badly", "generic"],
		["Segmentation fault (core dumped)", "generic"],
	])("%s → %s", (line, kind) => {
		expect(classifyErrorLine(line)).toBe(kind);
	});

	it.each([
		"test result: ok. 12 passed; 0 failed; 0 ignored",
		"compiling with -Werror",
		"ok  \texample.com/errors_pkg\t0.01s",
		"handled by error_handler.go",
		"Finished: no errors",
		"Compiling forth v0.1.0",
	])("%s → not an error", (line) => {
		expect(classifyErrorLine(line)).toBeUndefined();
	});
});

describe("classifyErrorLine and lineVerdicts (D-077)", () => {
	const verdict = (line: string) => lineVerdicts([line])[0];

	it.each([
		// Python exceptions with a module path; Rust doctest names with spaces.
		["json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)", "error"],
		["subprocess.CalledProcessError: Command '['make']' returned non-zero exit status 2.", "error"],
		["KeyboardInterrupt", "error"],
		["SystemExit: 2", "error"],
		["test src/lib.rs - add (line 5) ... FAILED", "failed"],
		["test result: FAILED. 0 passed; 1 failed; 0 ignored", "failed"],
		["FAILED (failures=1, errors=2)", "failed"],
		["FAIL", "failed"],
		["50% tests passed, 1 tests failed out of 2", "failed"],
		["FAIL [   0.004s] forth eval::words", "failed"],
		["ninja: build stopped: subcommand failed.", "failed"],
		["gmake[1]: *** [Makefile:12: all] Error 2", "failed"],
		["/usr/bin/ld: cannot find -lfoo: No such file or directory", "failed"],
		["ld: symbol(s) not found for architecture arm64", "failed"],
		["a.o: multiple definition of `main'", "failed"],
		["2 failed, 1 passed, 3 errors in 1.20s", "failed"],
		["Something failed badly", "mention"],
		["ERROR    root:fetch.py:12 could not connect", "mention"],
	] as const)("%s → %s", (line, expected) => {
		expect(verdict(line)).toBe(expected);
		expect(classifyErrorLine(line)).toBe(expected === "mention" ? "generic" : "specific");
	});

	it("keeps pip's resolver note without taking it for a failed test", () => {
		const note = "ERROR: pip's dependency resolver does not currently take into account all the packages";
		expect(classifyErrorLine(note)).toBe("specific");
		expect(verdict(note)).toBe("mention");
	});

	it.each([
		// Worth keeping when trimming, but a green run prints them too.
		"    limiter_test.go:41: burst of 5 took 12ms",
		"server.go:88: listening on :8080",
		"/usr/bin/ld: warning: libfoo.so.1, needed by libbar.so, not found (try using -rpath or -rpath-link)",
		"/usr/bin/ld: skipping incompatible /usr/lib/libz.so when searching for -lz",
		"100% tests passed, 0 tests failed out of 12",
		"SystemExit: 0",
	])("kept, not a verdict: %s", (line) => {
		expect(classifyErrorLine(line)).toBe("specific");
		expect(verdict(line)).toBeUndefined();
	});

	it.each([
		// The generic pattern used to fire on names.
		"[ 25%] Building CXX object CMakeFiles/netcalc.dir/src/error.cpp.o",
		"ok  \texample.com/app/internal/errors\t0.01s",
		"   Compiling error-chain v0.12.4",
		"test parse::error::tests::roundtrip ... ok",
		"warning: unused variable: `error`",
		"warning: unused variable 'error' [-Wunused-variable]",
		"3 |     let error = 1;",
		"   17 |   throw fatal(error);",
		"  |         ^^^^^ help: prefix it with an underscore: `_error`",
		"g++ -Wl,--fatal-warnings -o app main.o",
		"Downloading https://example.com/errors/failed.tar.gz",
		"Ran 4 tests, failures=0, errors: 0",
		"running errors.go through gofmt",
		"cargo test --no-fail-fast",
		"use std::error::Error;",
	])("names no error: %s", (line) => {
		expect(classifyErrorLine(line)).toBeUndefined();
		expect(verdict(line)).toBeUndefined();
	});

	it.each([
		"cc1plus: all warnings being treated as errors",
		"Loading...failed",
		"build failed.",
		"I/O error on device",
		"3 failures",
		"fatal: not a git repository",
	])("still a mention: %s", (line) => {
		expect(verdict(line)).toBe("mention");
	});

	it("counts a Go test's log lines only when a test failed", () => {
		const log = "    holiday_test.go:41: Easter(1981) = 1981-04-26, want 1981-04-19";
		expect(lineVerdicts(["=== RUN   TestEaster", log, "--- PASS: TestEaster (0.00s)", "PASS"])).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		expect(lineVerdicts(["--- FAIL: TestEaster (0.00s)", log, "FAIL"])).toEqual(["failed", "error", "failed"]);
		// A log line that mentions an error is at most a mention.
		expect(lineVerdicts(["    api_test.go:9: got error as expected", "PASS"])).toEqual(["mention", undefined]);
		expect(lineVerdicts(["  server.go:88: bind failed"])).toEqual(["mention"]);
	});

	it("reads an indented line with and without its indentation", () => {
		expect(lineVerdicts(["    error[E0308]: mismatched types", "  E   assert 1 == 2"])).toEqual(["failed", "failed"]);
	});
});

describe("ungroundedReferences (D-077)", () => {
	const cwd = "/nonexistent-exo-workspace";

	it("does not take prose for paths", () => {
		const prose = "Use Node.js or Vue.js here, e.g. a map (i.e. a dict), v1.2 and/or etc. See the U.S. docs.";
		expect(ungroundedReferences(prose, "", cwd)).toEqual([]);
	});

	it("still flags an invented file, with a directory or a source extension", () => {
		expect(ungroundedReferences("Edit src/nope and src/nope.xyz, then parser.rs and index.js.", "", cwd)).toEqual([
			"src/nope.xyz",
			"parser.rs",
			"index.js",
		]);
	});

	it("looks a name up without its call parentheses, position or type arguments", () => {
		const evidence = "fn parse_config(path: &str) in src/lib.rs, struct Stack, mod eval";
		const hint = "Call `parse_config()`, see `src/lib.rs:42:9`, `Stack<T>` and `eval::`.";
		expect(ungroundedReferences(hint, evidence, cwd)).toEqual([]);
		expect(ungroundedReferences("Call `parse_cfg()` on `Heap<T>`.", evidence, cwd)).toEqual(["parse_cfg()", "Heap<T>"]);
	});
});

describe("firstErrorLine", () => {
	it("prefers a toolchain-specific line over an earlier generic mention", () => {
		const text =
			"Running 3 tests\nwarning: something failed to cache\n\u001b[1merror[E0382]\u001b[0m: use of moved value\n";
		expect(firstErrorLine(text)).toEqual({ line: "error[E0382]: use of moved value", index: 2 });
	});
	it("falls back to generic and then to nothing", () => {
		expect(firstErrorLine("all good\nit failed somehow")).toEqual({ line: "it failed somehow", index: 1 });
		expect(firstErrorLine("all good")).toBeUndefined();
	});
	it("finds indented go test failures", () => {
		expect(errorLineIndices(["=== RUN TestA", "    --- FAIL: TestA (0.00s)", "ok"])).toEqual([1]);
	});
});

describe("isRoutineLine", () => {
	it.each([
		"   Compiling forth v0.1.0 (/tmp/forth)",
		"  Downloaded serde v1.0.0",
		"running 12 tests",
		"test parse::words ... ok",
		"=== RUN   TestEaster/1981",
		"    --- PASS: TestEaster/1980 (0.00s)",
		"PASS",
		"make[1]: Entering directory '/tmp/x'",
		"[ 50%] Building CXX object CMakeFiles/x.dir/a.cpp.o",
		"[ RUN      ] RingTest.Wraps",
		"[       OK ] RingTest.Wraps (0 ms)",
		" 3/12 Test  #3: ring_wraps ...............   Passed    0.01 sec",
		"ok 3701 - prefix4 matrix: first_host(1.1.1.1/0)",
		"tests/test_page.py ....s..                                   [ 40%]",
		"tests/test_page.py::test_last PASSED                         [100%]",
		"test_tags (tests.test_catalog.ProductTest.test_tags) ... ok",
	])("%s", (line) => expect(isRoutineLine(line)).toBe(true));
	it.each([
		"test eval::stack ... FAILED",
		"test result: ok. 15 passed; 0 failed; 0 ignored",
		"    --- FAIL: TestEaster/1981 (0.00s)",
		"ok  \texample.com/workdays/bizday\t0.040s",
		"not ok 13 - rejects ::1.2.3",
		"warning: unused variable: `x`",
		"Downloading 100%",
		"     Running tests/conversions.rs (target/debug/deps/conversions-5ac3)",
		"test_tags (tests.test_catalog.ProductTest.test_tags) ... FAIL",
		"DEBUG   storefront.tax: tax_for(9.99, DE, None) = 1.9",
		"ok",
	])("not: %s", (line) => expect(isRoutineLine(line)).toBe(false));
});

describe("errorSignature", () => {
	it("matches the same failure across attempts and runs", () => {
		const a = errorSignature("bash", 101, "Compiling\nerror[E0502]: cannot borrow `self.items` at src/lib.rs:42:9");
		const b = errorSignature("bash", 101, "Compiling\nerror[E0502]: cannot borrow `self.list` at src/main.rs:7:1");
		expect(a).toBe(b);
		expect(a).toBe("bash|101|error[E<n>]: cannot borrow <str> at <path>:<n>:<n>");
	});
	it("distinguishes exit codes and falls back to the first non-empty line", () => {
		expect(errorSignature("bash", 1, "\nboom 12")).toBe("bash|1|boom <n>");
		expect(errorSignature("bash", 1, "x")).not.toBe(errorSignature("bash", 2, "x"));
		expect(errorSignature("read", null, "")).toBe("read||");
	});
	it("normalizes hex ids", () => {
		expect(normalizeErrorLine("fault at 0xdeadbeef")).toBe("fault at <hex>");
	});
});
