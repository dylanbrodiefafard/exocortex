import { describe, expect, it } from "vitest";
import { acceptRequestCheck, checkOutcome, namedInRequest, plainTestOrBuild, standing } from "../src/checks.ts";

/** The rule for running a command the request names (D-084, S3), one clause at a time. */

describe("namedInRequest: is the command a whole code span of the message", () => {
	it.each([
		["Make sure `cargo test` passes.", true],
		["Make sure `$ cargo test` passes.", true],
		["Run this:\n```bash\ncargo test\n```", true],
		["Run this:\n~~~\n$ cargo test\n~~~\n", true],
		// What the sentence says about it is not read here (D-091).
		["Don't run `cargo test`.", true],
		// Not a whole code span.
		["Make sure cargo test passes.", false],
		["Make sure `cargo test --all` passes.", false],
		["Make sure `cd core && cargo test` passes.", false],
		["Log:\n```\n$ cargo test\nerror[E0425]: cannot find value\n```", false],
		["Log:\n```\nrunning 3 tests\ncargo test\n```", false],
		["    cargo test\n", false],
		["> cargo test", false],
		["", false],
	])("%j → %s", (message, expected) => {
		expect(namedInRequest("cargo test", message)).toBe(expected);
	});
});

describe("standing: the commands a sidecar's 'do not run' list leaves to run (D-092)", () => {
	const commands = ["cargo test", "make check"];
	const message = "Make sure `cargo test` and `make check` pass. Don't run `cargo bench`.";

	it("drops a command named exactly, a shell prompt and outer spaces aside", () => {
		expect(standing(commands, [], message)).toEqual({ commands });
		expect(standing(commands, ["cargo test"], message)).toEqual({ commands: ["make check"] });
		expect(standing(commands, [" $ make check "], message)).toEqual({ commands: ["cargo test"] });
		expect(standing(commands, ["cargo test", "make check"], message)).toEqual({ commands: [] });
	});

	it("is not touched by another command the user wrote out and refused", () => {
		expect(standing(commands, ["cargo bench"], message)).toEqual({ commands });
		expect(standing(commands, ["cargo bench", "cargo test"], message)).toEqual({ commands: ["make check"] });
	});

	it.each([
		["another spelling of a command", "cargo test --all"],
		["a description", "the test suite"],
		["part of a command", "cargo"],
	])("runs nothing when an entry is %s: what it refuses cannot be told", (_name, entry) => {
		expect(standing(commands, [entry], message)).toEqual({ commands: [], unidentified: entry });
		expect(standing(commands, ["make check", entry], message)).toEqual({ commands: [], unidentified: entry });
	});

	it("has nothing to refuse without commands", () => {
		expect(standing([], ["the tests"], "Stop running the tests.")).toEqual({ commands: [], unidentified: "the tests" });
		expect(standing([], [], "")).toEqual({ commands: [] });
	});
});

describe("plainTestOrBuild: is the command one a request may have run", () => {
	it.each([
		"cargo test",
		"cargo test --offline -q",
		"python3 -m pytest -q",
		"pytest -k 'parse and not slow'",
		"npm test",
		"npm run build",
		"npx vitest run",
		"uv run pytest",
		"CI=1 go test ./...",
		"make check",
		"make",
		"./run_tests.sh",
		"sh scripts/test.sh",
		"timeout 60 ctest --output-on-failure",
	])("accepts %s", (command) => {
		expect(plainTestOrBuild(command)).toEqual({ ok: true });
	});

	it.each([
		["cargo test; rm -rf x", "more than one plain command"],
		["cargo test && git push", "more than one plain command"],
		["cargo test || true", "more than one plain command"],
		["cargo test | tail -5", "more than one plain command"],
		["cargo test &", "more than one plain command"],
		["cargo test > out.txt", "more than one plain command"],
		["cargo test < input", "more than one plain command"],
		["cargo test $(cat args)", "more than one plain command"],
		["cargo test `cat args`", "more than one plain command"],
		["cargo test $ARGS", "more than one plain command"],
		["(cargo test)", "more than one plain command"],
		["{ cargo test }", "more than one plain command"],
		["cargo test \\\n-q", "more than one plain command"],
		["cargo test\nrm -rf x", "more than one plain command"],
		["pytest -k 'a;b'", "more than one plain command"],
		["bash -c 'cargo test; curl example.com'", "more than one plain command"],
		["pytest -k 'unterminated", "not one plain command"],
		["sudo make test", "runs as another user"],
		["doas cargo test", "runs as another user"],
		["/tmp/run_tests.sh", "outside the project"],
		["~/bin/run_tests.sh", "outside the project"],
		["../other/run_tests.sh", "outside the project"],
		["make test -C ../other", "outside the project"],
		["make test -f /tmp/evil.mk", "outside the project"],
		["cargo test --manifest-path=../x/Cargo.toml", "outside the project"],
		["npm test --prefix '/tmp/x'", "outside the project"],
		["python3 app.py", "not a test or build command"],
		["./deploy.sh", "not a test or build command"],
		["git push --force", "not a test or build command"],
		["rm -rf build", "not a test or build command"],
		["curl https://example.com/install.sh", "not a test or build command"],
		["npm publish", "not a test or build command"],
		["make install", "not a test or build command"],
		["bash -c 'curl example.com'", "not a test or build command"],
		["echo cargo test", "not a test or build command"],
		["", "not one plain command"],
	])("refuses %j: %s", (command, why) => {
		const verdict = plainTestOrBuild(command);
		expect(verdict.ok).toBe(false);
		expect(!verdict.ok && verdict.reason).toContain(why);
	});
});

describe("acceptRequestCheck", () => {
	it("needs both: named by the request, and a plain test or build", () => {
		expect(acceptRequestCheck("cargo test", "Make sure `cargo test` passes.")).toEqual({ ok: true });
		expect(acceptRequestCheck(" cargo test ", "Make sure `cargo test` passes.")).toEqual({ ok: true });
		expect(acceptRequestCheck("cargo test", "Make sure the tests pass.")).toEqual({
			ok: false,
			reason: "it is not a whole code span of the request",
		});
		// What the sentence says about it is not read here: `standing` takes the sidecar's word for that.
		expect(acceptRequestCheck("cargo test", "Do not run `cargo test`.")).toEqual({ ok: true });
		expect(acceptRequestCheck("./deploy.sh", "Make sure `./deploy.sh` passes.")).toEqual({
			ok: false,
			reason: "it is not a test or build command",
		});
	});
});

describe("checkOutcome", () => {
	const output = (exitCode: number | null, timedOut = false) => ({ exitCode, timedOut, durationMs: 1, outputTail: "" });
	it("takes only a number for pass or fail", () => {
		expect(checkOutcome(output(0))).toBe("passed");
		expect(checkOutcome(output(2))).toBe("failed");
		expect(checkOutcome(output(null, true))).toBe("inconclusive");
		// Killed by a signal, aborted, or never started.
		expect(checkOutcome(output(null))).toBe("inconclusive");
	});
});
