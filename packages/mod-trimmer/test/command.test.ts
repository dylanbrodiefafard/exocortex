import { describe, expect, it } from "vitest";
import { printsRequestedContent } from "../src/command.ts";

const NAMES = ["cat", "grep", "tail", "head", "sed", "git diff", "git log"];
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
});
