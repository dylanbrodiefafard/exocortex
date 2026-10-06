import { describe, expect, it } from "vitest";
import { failureKey, failureLines } from "../src/modules/loops.ts";
import { classifyErrorLine, firstErrorLine } from "../src/modules/output.ts";
import { outcomeOf, type RunVerdict, readHiddenRun, verifyingRun } from "../src/modules/runs.ts";

/**
 * Command lines and tool output as agents and toolchains really write them (D-077, plan item A13):
 * Rust, Go, C/C++ and Python (D-016), each read in both directions. A failing run must read as
 * failed and a passing one as passed, whatever the spelling.
 */

const lines = (...text: string[]) => text.join("\n");

// --- Output, as the toolchains print it --------------------------------------------------------

const CARGO_TEST_PASS = lines(
	"   Compiling error-chain v0.12.4",
	"   Compiling forth v0.1.0 (/home/u/forth)",
	"warning: unused variable: `error`",
	" --> src/lib.rs:3:9",
	"  |",
	"3 |     let error = 1;",
	"  |         ^^^^^ help: if this is intentional, prefix it with an underscore: `_error`",
	"  |",
	"  = note: `#[warn(unused_variables)]` on by default",
	"",
	"warning: `forth` (lib) generated 1 warning",
	"    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.52s",
	"     Running unittests src/lib.rs (target/debug/deps/forth-1a2b3c4d5e6f7a8b)",
	"",
	"running 3 tests",
	"test parse::error::tests::roundtrip ... ok",
	"test eval::stack ... ok",
	"test eval::words ... ok",
	"",
	"test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
	"",
	"   Doc-tests forth",
	"",
	"running 1 test",
	"test src/lib.rs - add (line 5) ... ok",
	"",
	"test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.21s",
);

const CARGO_TEST_FAIL = lines(
	"running 3 tests",
	"test eval::stack ... ok",
	"test eval::words ... FAILED",
	"test parse::error::tests::roundtrip ... ok",
	"",
	"failures:",
	"",
	"---- eval::words stdout ----",
	"",
	"thread 'eval::words' (207059) panicked at src/eval.rs:42:9:",
	"assertion `left == right` failed",
	"  left: 3",
	" right: 4",
	"note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
	"",
	"",
	"failures:",
	"    eval::words",
	"",
	"test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
	"",
	"error: test failed, to rerun pass `--lib`",
);

/** Unit tests pass, then a doctest fails: two summaries, the last one the failure. */
const CARGO_DOCTEST_FAIL = lines(
	"test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
	"",
	"   Doc-tests forth",
	"",
	"running 1 test",
	"test src/lib.rs - add (line 5) ... FAILED",
	"",
	"failures:",
	"",
	"---- src/lib.rs - add (line 5) stdout ----",
	"Test executable failed (exit status: 101).",
	"",
	"test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s",
);

const CARGO_BUILD_FAIL = lines(
	"   Compiling forth v0.1.0 (/home/u/forth)",
	"error[E0308]: mismatched types",
	" --> src/lib.rs:12:5",
	"   |",
	'12 |     "x"',
	"   |     ^^^ expected `i32`, found `&str`",
	"",
	"error: could not compile `forth` (lib) due to 1 previous error",
);

const CARGO_BUILD_OK = lines(
	"   Compiling error-chain v0.12.4",
	"   Compiling forth v0.1.0 (/home/u/forth)",
	"warning: unused variable: `error`",
	" --> src/lib.rs:3:9",
	"warning: `forth` (lib) generated 1 warning",
	"    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.02s",
);

const NEXTEST_PASS = lines(
	"    Starting 3 tests across 1 binary",
	"        PASS [   0.004s] forth eval::stack",
	"        PASS [   0.004s] forth eval::words",
	"        PASS [   0.005s] forth parse::error::tests::roundtrip",
	"------------",
	"     Summary [   0.006s] 3 tests run: 3 passed, 0 skipped",
);

const NEXTEST_FAIL = lines(
	"        PASS [   0.004s] forth eval::stack",
	"        FAIL [   0.004s] forth eval::words",
	"------------",
	"     Summary [   0.006s] 3 tests run: 2 passed, 1 failed, 0 skipped",
	"        FAIL [   0.004s] forth eval::words",
	"error: test run failed",
);

const GO_TEST_PASS = lines("ok  \texample.com/app/internal/errors\t0.012s", "ok  \texample.com/app/rl\t(cached)");

/** `go test -v`, green: a test logs with `t.Log`, the server under test with `log.Lshortfile`. */
const GO_TEST_VERBOSE_PASS = lines(
	"=== RUN   TestBurst",
	"    limiter_test.go:41: burst of 5 took 12ms",
	"--- PASS: TestBurst (0.01s)",
	"=== RUN   TestServer",
	"server.go:88: listening on 127.0.0.1:43211",
	"--- PASS: TestServer (0.00s)",
	"PASS",
	"ok  \texample.com/rl\t0.015s",
);

const GO_TEST_FAIL = lines(
	"--- FAIL: TestEaster (0.00s)",
	"    holiday_test.go:41: Easter(1981) = 1981-04-26, want 1981-04-19",
	"FAIL",
	"FAIL\texample.com/workdays/holiday\t0.004s",
	"ok  \texample.com/workdays/bizday\t0.040s",
	"FAIL",
);

const GO_BUILD_FAIL = lines("# example.com/rl", "./limiter.go:42:7: undefined: Limit");

const GO_VET_FAIL = lines("# example.com/rl", "./limiter.go:17:2: fmt.Printf format %d has arg s of wrong type string");

/** A CMake build that works: a source file named for errors, and a linker warning. */
const CMAKE_BUILD_OK = lines(
	"[ 25%] Building CXX object CMakeFiles/netcalc.dir/src/error.cpp.o",
	"[ 50%] Building CXX object CMakeFiles/netcalc.dir/src/parse.cpp.o",
	"[ 75%] Linking CXX executable netcalc",
	"/usr/bin/ld: warning: libfoo.so.1, needed by libbar.so, not found (try using -rpath or -rpath-link)",
	"[100%] Built target netcalc",
);

const CMAKE_BUILD_FAIL = lines(
	"[ 50%] Building CXX object CMakeFiles/netcalc.dir/src/ring.cpp.o",
	"/home/u/netcalc/src/ring.hpp:17:3: error: no matching function for call to 'push'",
	"   17 |   push(value);",
	"      |   ^~~~",
	"make[2]: *** [CMakeFiles/netcalc.dir/build.make:76: CMakeFiles/netcalc.dir/src/ring.cpp.o] Error 1",
	"make[1]: *** [CMakeFiles/Makefile2:83: CMakeFiles/netcalc.dir/all] Error 2",
	"make: *** [Makefile:91: all] Error 2",
);

const LINK_FAIL = lines(
	"/usr/bin/ld: CMakeFiles/netcalc.dir/main.cpp.o: in function `main':",
	"main.cpp:(.text+0x1f): undefined reference to `ring_push(int)'",
	"collect2: error: ld returned 1 exit status",
);

const CTEST_PASS = lines(
	"Test project /home/u/netcalc/build",
	"    Start 1: ring_wraps",
	"1/2 Test #1: ring_wraps .......................   Passed    0.01 sec",
	"    Start 2: parse_error",
	"2/2 Test #2: parse_error ......................   Passed    0.00 sec",
	"",
	"100% tests passed, 0 tests failed out of 2",
	"",
	"Total Test time (real) =   0.02 sec",
);

const CTEST_FAIL = lines(
	"1/2 Test #1: ring_wraps .......................***Failed    0.01 sec",
	"2/2 Test #2: parse_error ......................   Passed    0.00 sec",
	"",
	"50% tests passed, 1 tests failed out of 2",
	"",
	"The following tests FAILED:",
	"\t  1 - ring_wraps (Failed)",
	"Errors while running CTest",
);

const GTEST_PASS = lines(
	"[ RUN      ] RingTest.Wraps",
	"[       OK ] RingTest.Wraps (0 ms)",
	"[==========] 3 tests from 1 test suite ran. (0 ms total)",
	"[  PASSED  ] 3 tests.",
);

const GTEST_FAIL = lines(
	"/home/u/netcalc/test/ring_test.cpp:14: Failure",
	"Expected equality of these values:",
	"  ring.size()",
	"    Which is: 3",
	"  4",
	"[  FAILED  ] RingTest.Wraps (0 ms)",
	"[==========] 3 tests from 1 test suite ran. (0 ms total)",
	"[  PASSED  ] 2 tests.",
	"[  FAILED  ] 1 test, listed below:",
	"[  FAILED  ] RingTest.Wraps",
);

const PYTEST_PASS = lines(
	"============================= test session starts ==============================",
	"collected 12 items",
	"",
	"tests/test_errors.py ....                                                [ 33%]",
	"tests/test_page.py ........                                              [100%]",
	"",
	"============================== 12 passed in 0.41s ==============================",
);

const PYTEST_FAIL = lines(
	"    def test_last():",
	">       assert page(1) == 2",
	"E       assert 1 == 2",
	"E        +  where 1 = page(1)",
	"",
	"tests/test_page.py:8: AssertionError",
	"=========================== short test summary info ============================",
	"FAILED tests/test_page.py::test_last - assert 1 == 2",
	"========================= 1 failed, 11 passed in 0.52s =========================",
);

/** Green, though the code under test logged an exception it handled, and a CLI test exited 0. */
const UNITTEST_PASS_WITH_LOGGED_ERROR = lines(
	"ERROR:root:fetch failed",
	"Traceback (most recent call last):",
	'  File "/home/u/app/fetch.py", line 12, in fetch',
	'    raise ConnectionError("refused")',
	"ConnectionError: refused",
	"SystemExit: 0",
	"....",
	"----------------------------------------------------------------------",
	"Ran 4 tests in 0.366s",
	"",
	"OK",
);

const UNITTEST_FAIL = lines(
	"======================================================================",
	"FAIL: test_tags (tests.test_catalog.ProductTest.test_tags)",
	"----------------------------------------------------------------------",
	"Traceback (most recent call last):",
	'  File "/home/u/shop/tests/test_catalog.py", line 31, in test_tags',
	'    self.assertEqual(tags, ["a"])',
	"AssertionError: Lists differ: ['a', 'b'] != ['a']",
	"",
	"----------------------------------------------------------------------",
	"Ran 7 tests in 0.004s",
	"",
	"FAILED (failures=1)",
);

const PIP_RESOLVER_NOTE =
	"ERROR: pip's dependency resolver does not currently take into account all the packages that are installed.";

const tail = (output: string, count: number) => output.split("\n").slice(-count).join("\n");
const grep = (output: string, pattern: RegExp) =>
	output
		.split("\n")
		.filter((line) => pattern.test(line))
		.join("\n");

// --- Command lines -----------------------------------------------------------------------------

describe("verifyingRun: command lines as agents write them", () => {
	it.each<[string, "test" | "build", boolean]>([
		// The runner's own exit code is the line's.
		["cargo test", "test", false],
		["cd app && RUST_BACKTRACE=1 cargo test --offline 2>&1", "test", false],
		["go test -run 'TestA|TestB' ./...", "test", false],
		['pytest -k "parse or render" -q', "test", false],
		["cargo test -- --skip 'slow|net'", "test", false],
		["cargo build && cargo test", "test", false],
		["cargo test && git status", "test", false],
		["(cd crates/core && cargo test)", "test", false],
		["set -o pipefail; cargo test | tail", "test", false],
		["set -euo pipefail\ncargo test 2>&1 | tail -20\necho done", "test", false],
		["cargo test > /tmp/log.txt 2>&1", "test", false],
		["# run the suite\ncargo test", "test", false],
		["cat > /tmp/x.py <<'EOF'\nprint('a | b; c')\nEOF\npython3 -m pytest -q", "test", false],
		// Something else decides the exit code.
		["cargo test | tail -5", "test", true],
		["cargo test 2>&1 | tail -5", "test", true],
		["cargo test |& tail -5", "test", true],
		["cargo test; echo done", "test", true],
		["cargo test\necho done", "test", true],
		["cargo test || true", "test", true],
		["cargo test &", "test", true],
		["cargo test | tail && git status", "test", true],
		["(cd x && cargo test) | tail", "test", true],
		["{ cargo test; } 2>&1 | tail -20", "test", true],
		["cargo test 2>&1 | tee /tmp/log | grep -E 'test result|FAILED'", "test", true],
		["if cargo test; then echo ok; fi", "test", true],
		["cargo build 2>&1 | tail -3; cargo test", "test", true],
		["bash -lc 'cd app && cargo test | tail -5'", "test", true],
		["bash -c 'set -o pipefail; go test ./... | tail'", "test", false],
		// Builds.
		["make -s -j4", "build", false],
		["cargo clippy --all-targets -- -D warnings", "build", false],
		["cmake --build build -j 8 2>&1 | tail -20", "build", true],
		["go vet ./...", "build", false],
		["npx tsc --noEmit", "build", false],
	])("%s → %s, hidden: %s", (command, kind, hidden) => {
		expect(verifyingRun(command)).toMatchObject({ kind, hidden });
	});

	it.each([
		// Every spelling plan item A2 lists.
		"uv run pytest",
		"uv run --with hypothesis pytest -x",
		"poetry run pytest tests/",
		"python3.11 -m pytest",
		"python -W error -m unittest discover -s tests",
		".venv/bin/pytest -q",
		"./node_modules/.bin/vitest run",
		"cargo nextest run",
		"cargo +nightly test",
		"cargo --offline test",
		"env X=1 cargo test",
		"env -u RUSTFLAGS X=1 cargo test",
		"time go test ./...",
		"timeout -k 5 60 pytest",
		"timeout 60 go test ./...",
		"sudo -E nice -n 10 make check",
		"make -j 8 test",
		"make -C build test",
		"make -j8 -C build VERBOSE=1 check",
		"npm run check",
		"npm run test:unit -- --watch=false",
		"npm test",
		"pnpm test",
		"pnpm --filter core test",
		"pnpm exec vitest run",
		"yarn test",
		"bun test",
		"just test",
		"./run_tests.sh",
		"bash scripts/run-tests.sh --fast",
		"python tests/test_parser.py",
		"bash -lc 'cargo test'",
		'sh -c "cd build && ctest --output-on-failure"',
		'nix --extra-experimental-features "nix-command flakes" shell nixpkgs#nodejs_22 -c npm run check',
		"ninja -C build test",
		"go test ./... -count=1",
		"gotestsum ./...",
		"tox -e py312",
	])("%s is a test run", (command) => {
		expect(verifyingRun(command)).toMatchObject({ kind: "test", hidden: false });
		expect(verifyingRun(`${command} 2>&1 | tail -20`)).toMatchObject({ kind: "test", hidden: true });
	});

	it.each([
		"cat src/lib.rs | head",
		"git log | head",
		"cargo buildx",
		"cargo build-sbf",
		"cargo run -- test",
		"cargo fmt --check",
		"make clean",
		"makepkg -s",
		"echo cargo test",
		"grep -rn 'cargo test' docs/",
		"go testify",
		"pytest-watch",
		"npm install",
		"npm run dev",
		"uv sync",
		"python3 main.py",
		"./deploy.sh",
		"ls tests/",
		"echo 'unterminated",
		"",
	])("%s is not a run", (command) => {
		expect(verifyingRun(command)).toBeUndefined();
	});

	it("gives the run without its wrappers, and the line without what the run is piped into", () => {
		expect(verifyingRun("timeout 60 go test -run 'TestA|TestB' ./... 2>&1 | tail -20")).toEqual({
			kind: "test",
			bare: "go test -run TestA|TestB ./...",
			hidden: true,
			unpiped: "timeout 60 go test -run 'TestA|TestB' ./... 2>&1",
		});
		expect(verifyingRun("(cd x && cargo test | grep -v ok) | tail")?.unpiped).toBe("(cd x && cargo test)");
		expect(verifyingRun("cd app && uv run pytest -q | tail -3 && git status")?.unpiped).toBe(
			"cd app && uv run pytest -q && git status",
		);
		expect(verifyingRun("bash -lc 'cargo test | tail -3' | cat")?.unpiped).toBe("bash -lc 'cargo test | tail -3'");
	});

	it("takes the last test run on the line, else the last build", () => {
		expect(verifyingRun("cargo test -p core && cargo clippy")?.bare).toBe("cargo test -p core");
		expect(verifyingRun("cargo check && cargo build --release")?.bare).toBe("cargo build --release");
		expect(verifyingRun("pytest tests/unit && pytest tests/e2e")?.bare).toBe("pytest tests/e2e");
	});

	it("knows the commands a caller names as test runs", () => {
		const tests = ["./verify.sh", "mvn -q verify"];
		expect(verifyingRun("./verify.sh")).toBeUndefined();
		expect(verifyingRun("./verify.sh", { tests })).toMatchObject({ kind: "test", hidden: false });
		expect(verifyingRun("cd app && mvn -q verify -o | tail", { tests })).toMatchObject({ kind: "test", hidden: true });
		expect(verifyingRun("mvn -q package", { tests })).toBeUndefined();
	});
});

// --- Output behind a pipe ----------------------------------------------------------------------

describe("readHiddenRun: real output in both directions", () => {
	const read = (command: string, output: string) =>
		readHiddenRun({ input: { command }, isError: false, exitCode: 0, output });

	it.each<[string, string, string, RunVerdict]>([
		["cargo test, green", "cargo test 2>&1 | tail -40", CARGO_TEST_PASS, "passed"],
		["cargo test, green, summary only", "cargo test 2>&1 | tail -1", tail(CARGO_TEST_PASS, 1), "passed"],
		["cargo test, red", "cargo test 2>&1 | tail -40", CARGO_TEST_FAIL, "failed"],
		["cargo test, red, last lines", "cargo test 2>&1 | tail -3", tail(CARGO_TEST_FAIL, 3), "failed"],
		["cargo doctest, red", "cargo test 2>&1 | tail -20", CARGO_DOCTEST_FAIL, "failed"],
		[
			"cargo summaries, ok then FAILED",
			"cargo test 2>&1 | grep 'test result'",
			grep(CARGO_DOCTEST_FAIL, /^test result/),
			"failed",
		],
		[
			"cargo summaries, all ok",
			"cargo test 2>&1 | grep 'test result'",
			grep(CARGO_TEST_PASS, /^test result/),
			"passed",
		],
		["cargo failed tests only", "cargo test 2>&1 | grep FAILED", grep(CARGO_DOCTEST_FAIL, /FAILED/), "failed"],
		["cargo build, red", "cargo build 2>&1 | tail -20", CARGO_BUILD_FAIL, "failed"],
		["cargo build, green with warnings", "cargo build 2>&1 | tail -20", CARGO_BUILD_OK, "unknown"],
		["cargo nextest, green", "cargo nextest run 2>&1 | tail", NEXTEST_PASS, "passed"],
		["cargo nextest, red", "cargo nextest run 2>&1 | tail", NEXTEST_FAIL, "failed"],
		["go test, green", "go test ./... | tail", GO_TEST_PASS, "passed"],
		["go test -v, green with logs", "go test -v ./... 2>&1 | tail -50", GO_TEST_VERBOSE_PASS, "passed"],
		["go test, red", "go test ./... 2>&1 | tail -20", GO_TEST_FAIL, "failed"],
		["go test, red, last line", "go test ./... 2>&1 | tail -1", "FAIL", "failed"],
		["go test, does not compile", "go test ./... 2>&1 | head -20", GO_BUILD_FAIL, "failed"],
		["go vet, red", "go vet ./... 2>&1 | head", GO_VET_FAIL, "failed"],
		["cmake build, green with a linker warning", "cmake --build build 2>&1 | tail", CMAKE_BUILD_OK, "unknown"],
		["cmake build, red", "cmake --build build 2>&1 | tail", CMAKE_BUILD_FAIL, "failed"],
		["link, red", "make 2>&1 | tail -3", LINK_FAIL, "failed"],
		["ctest, green", "ctest --test-dir build | tail", CTEST_PASS, "passed"],
		["ctest, red", "ctest --test-dir build | tail", CTEST_FAIL, "failed"],
		["googletest, green", "make test 2>&1 | tail -4", GTEST_PASS, "passed"],
		["googletest, red", "make test 2>&1 | tail", GTEST_FAIL, "failed"],
		["pytest, green", "python3.11 -m pytest 2>&1 | tail", PYTEST_PASS, "passed"],
		["pytest, red", "uv run pytest 2>&1 | tail -20", PYTEST_FAIL, "failed"],
		["pytest, red, summary only", "pytest 2>&1 | tail -1", tail(PYTEST_FAIL, 1), "failed"],
		["pytest -q, red, summary only", "pytest -q | tail -1", "1 failed, 11 passed in 0.52s", "failed"],
		[
			"unittest, green with a logged exception",
			"python -m unittest 2>&1 | tail -30",
			UNITTEST_PASS_WITH_LOGGED_ERROR,
			"passed",
		],
		["unittest, red", "python -m unittest 2>&1 | tail -30", UNITTEST_FAIL, "failed"],
		["unittest, red, last line", "python -m unittest 2>&1 | tail -1", tail(UNITTEST_FAIL, 1), "failed"],
		[
			"pip's resolver note, then pytest green",
			"pip install -q -e . 2>&1 | tail -1; python -m pytest -q 2>&1 | tail -1",
			lines(PIP_RESOLVER_NOTE, "12 passed in 0.41s"),
			"passed",
		],
		[
			"a traceback after the pass summary",
			"python -m unittest 2>&1 | tail",
			lines("OK", "Traceback (most recent call last):", "RuntimeError: at exit"),
			"failed",
		],
		["a crash with no summary", "pytest 2>&1 | tail -2", "ModuleNotFoundError: No module named 'app'", "failed"],
		["a count, no summary", "cargo test 2>&1 | grep -c ok", "3", "unknown"],
	])("%s", (_name, command, output, verdict) => {
		expect(read(command, output)).toBe(verdict);
	});
});

describe("outcomeOf", () => {
	const exit0 = (command: string, output = "") => ({ input: { command }, isError: false, exitCode: 0, output });

	it("does not call a piped command it cannot read passed", () => {
		expect(outcomeOf(exit0("./integration.sh 2>&1 | tail -5", "3 scenarios, 1 FAILURE"))).toBe("unknown");
		expect(outcomeOf(exit0("mvn -q verify | tee build.log"))).toBe("unknown");
		expect(outcomeOf(exit0("python3 main.py | head -3"))).toBe("unknown");
		expect(outcomeOf(exit0("(cd svc && ./smoke) | tail"))).toBe("unknown");
		expect(outcomeOf(exit0("echo 'unterminated | tail"))).toBe("unknown");
	});

	it("takes the exit code when no pipe hid it", () => {
		expect(outcomeOf(exit0("./integration.sh"))).toBe("passed");
		expect(outcomeOf(exit0("grep -c 'a|b' file"))).toBe("passed");
		expect(outcomeOf(exit0("set -o pipefail && ./integration.sh | tail"))).toBe("passed");
		expect(outcomeOf(exit0("go test -run 'TestA|TestB' ./..."))).toBe("passed");
		// The test run's own exit code was seen, whatever else on the line was piped.
		expect(outcomeOf(exit0("ls | wc -l && cargo test"))).toBe("passed");
		expect(outcomeOf({ ...exit0("./integration.sh | tail"), exitCode: 1 })).toBe("failed");
		expect(outcomeOf({ input: { path: "a|b.rs" }, isError: false, exitCode: null, output: "" })).toBe("passed");
	});
});

// --- Lines, one at a time ----------------------------------------------------------------------

describe("output lines: what a green run prints is not a failure", () => {
	const flagged = (output: string) =>
		output.split("\n").filter((line) => (classifyErrorLine(line) ?? classifyErrorLine(line.trim())) === "generic");

	it.each([
		["cargo test", CARGO_TEST_PASS],
		["cargo build", CARGO_BUILD_OK],
		["cargo nextest", NEXTEST_PASS],
		["go test", GO_TEST_PASS],
		["cmake build", CMAKE_BUILD_OK],
		["ctest", CTEST_PASS],
		["googletest", GTEST_PASS],
		["pytest", PYTEST_PASS],
	])("%s: no line only mentions an error", (_name, output) => {
		expect(flagged(output)).toEqual([]);
		expect(firstErrorLine(output)).toBeUndefined();
	});

	it("finds the first error of each failing output", () => {
		expect(firstErrorLine(CARGO_TEST_FAIL)?.line).toBe("test eval::words ... FAILED");
		expect(firstErrorLine(CARGO_DOCTEST_FAIL)?.line).toBe("test src/lib.rs - add (line 5) ... FAILED");
		expect(firstErrorLine(CARGO_BUILD_FAIL)?.line).toBe("error[E0308]: mismatched types");
		expect(firstErrorLine(GO_TEST_FAIL)?.line).toBe("--- FAIL: TestEaster (0.00s)");
		expect(firstErrorLine(GO_BUILD_FAIL)?.line).toBe("./limiter.go:42:7: undefined: Limit");
		expect(firstErrorLine(CMAKE_BUILD_FAIL)?.line).toBe(
			"/home/u/netcalc/src/ring.hpp:17:3: error: no matching function for call to 'push'",
		);
		expect(firstErrorLine(LINK_FAIL)?.line).toBe("main.cpp:(.text+0x1f): undefined reference to `ring_push(int)'");
		expect(firstErrorLine(CTEST_FAIL)?.line).toBe(
			"1/2 Test #1: ring_wraps .......................***Failed    0.01 sec",
		);
		expect(firstErrorLine(GTEST_FAIL)?.line).toBe("/home/u/netcalc/test/ring_test.cpp:14: Failure");
		expect(firstErrorLine(PYTEST_FAIL)?.line).toBe("E       assert 1 == 2");
		expect(firstErrorLine(UNITTEST_FAIL)?.line).toBe("FAIL: test_tags (tests.test_catalog.ProductTest.test_tags)");
		// A linker warning before the error is not the error.
		expect(firstErrorLine(lines(CMAKE_BUILD_OK, LINK_FAIL))?.line).toContain("undefined reference");
	});

	it("keeps a failing Go test's messages in its identity, and a passing one's logs out of it", () => {
		expect(failureLines(GO_TEST_FAIL)).toContain("holiday_test.go:<n>: Easter(1981) = 1981-04-26, want 1981-04-19");
		const other = GO_TEST_FAIL.replace("1981-04-26", "1981-04-12");
		const key = (output: string) => failureKey({ toolName: "bash", input: { command: "go test ./..." }, output });
		expect(key(other)).not.toBe(key(GO_TEST_FAIL));
		expect(key(GO_TEST_FAIL.replace("0.004s", "0.019s").replace(":41:", ":57:"))).toBe(key(GO_TEST_FAIL));
	});
});
