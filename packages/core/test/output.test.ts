import { describe, expect, it } from "vitest";
import {
	classifyErrorLine,
	cleanTerminalOutput,
	errorLineIndices,
	errorSignature,
	firstErrorLine,
	normalizeErrorLine,
} from "../src/modules/output.ts";

describe("cleanTerminalOutput", () => {
	it("strips ANSI escapes and keeps the final state of redrawn lines", () => {
		expect(cleanTerminalOutput("\u001b[31merror\u001b[0m: x")).toBe("error: x");
		expect(cleanTerminalOutput("10%\r50%\r100% done\r\nnext")).toBe("100% done\nnext");
		expect(cleanTerminalOutput("\u001b]0;title\u0007plain")).toBe("plain");
	});
});

describe("classifyErrorLine", () => {
	it.each([
		["error[E0502]: cannot borrow `x` as mutable", "specific"],
		["error: could not compile `forth`", "specific"],
		["thread 'main' panicked at src/main.rs:3:5:", "specific"],
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
