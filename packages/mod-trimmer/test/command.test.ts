import { describe, expect, it } from "vitest";
import { printsRequestedContent } from "../src/command.ts";

const NAMES = [
	..."cat grep tail head sed sort uniq find wc ls rg awk echo".split(" "),
	"git diff",
	"git log",
	"git ls-files",
];
const content = (command: string) => printsRequestedContent(command, NAMES);

describe("printsRequestedContent", () => {
	it("recognises reads, searches and git views, past setup, wrappers and env", () => {
		for (const command of [
			"cat src/lib.rs",
			"cd pkg && cat a.txt; grep -rn foo .",
			"LC_ALL=C grep -c 'a && b' file",
			"sudo timeout 30 /usr/bin/tail -n 50 /var/log/syslog",
			"git -C repo --no-pager diff HEAD~1",
			"sed -n '10,20p' file 2>/dev/null",
			"awk_missing 2>&1 || cat fallback.txt",
		]) {
			expect(content(command), command).toBe(command !== "awk_missing 2>&1 || cat fallback.txt");
		}
	});
	it("treats a pipe into a reader as the agent choosing what to see", () => {
		expect(content("cargo test 2>&1 | tail -100")).toBe(true);
		expect(content("make 2>&1 |& grep -A5 error")).toBe(true);
		expect(content("cat log | tee copy.log")).toBe(false);
	});
	it("is not content when any printing part is a run, or the line cannot be read", () => {
		for (const command of [
			"cargo test",
			"make test; cat build.log",
			"git status && git push",
			"git",
			"cd build",
			"cat <<EOF\nx\nEOF",
			"cat $(find . -name x)",
			"grep 'unterminated file",
			"./run.sh & cat out",
		]) {
			expect(content(command), command).toBe(false);
		}
	});

	it("reads quoted parentheses, braces and `<<` as text (R4)", () => {
		for (const command of [
			'grep -rn "fn main()" src',
			'rg "impl<T> Foo {" src',
			'grep -n "a << b" notes.txt',
			"find . -name '*.rs' -exec grep -n todo {} \\;",
		]) {
			expect(content(command), command).toBe(true);
		}
		expect(content('grep "$(cat patterns)" file')).toBe(false);
		expect(content('cat "`ls | head -1`"')).toBe(false);
	});

	it("exempts a run's output only when a later stage selects from it (R4)", () => {
		for (const [command, expected] of [
			["cargo test | cat", false],
			["make 2>&1 | sort", false],
			["cargo test 2>&1 | sed 's/^/> /'", false],
			["go test ./... | tail -40 && make | cat", false],
			["cargo test 2>&1 | sed -n '1,50p'", true],
			["cargo test | grep FAILED | sort", true],
			["cargo test | cat | tail -5", true],
			["pytest -q | awk '/FAILED/'", true],
			["go test ./... 2>&1 | wc -l", true],
			// The first stage is content already: whatever reshapes it is still what was asked for.
			["cat build.log | sort | uniq -c", true],
			["git log --oneline | cat", true],
		] as const) {
			expect(content(command), command).toBe(expected);
		}
	});

	it("reads through xargs to the command it runs (R4)", () => {
		for (const [command, expected] of [
			["find . -name '*.log' | xargs cat", true],
			["git ls-files | xargs -n 20 grep -n TODO", true],
			["find . -name '*.rs' -print0 | xargs -0 -P 4 wc -l", true],
			["git ls-files | xargs -I{} head -3 {}", true],
			["ls | xargs", true],
			["ls tests/*.py | xargs -I{} pytest {}", false],
			["ls crates | xargs -n1 cargo test -p", false],
		] as const) {
			expect(content(command), command).toBe(expected);
		}
	});

	it("skips a wrapper's own options and values", () => {
		expect(content("sudo -u build cat /var/log/build.log")).toBe(true);
		expect(content("env -u LANG LC_ALL=C sort names.txt")).toBe(true);
		expect(content("timeout -k 5 60 make test")).toBe(false);
	});
});
