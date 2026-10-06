import { describe, expect, it } from "vitest";
import { acceptRequestCheck, checkOutcome, namedInRequest, plainTestOrBuild } from "../src/checks.ts";

/** The rule for running a command the request names (D-084, S3), one clause at a time. */

describe("namedInRequest: is the command a code span the user wants run", () => {
	it.each([
		["Make sure `cargo test` passes.", "named"],
		["Make sure `$ cargo test` passes.", "named"],
		["Run this:\n```bash\ncargo test\n```", "named"],
		["Run this:\n~~~\n$ cargo test\n~~~\n", "named"],
		// The negative sentence ended before this one began.
		["Don't refactor. Make sure `cargo test` passes.", "named"],
		["Don't run the linter; `cargo test` must pass.", "named"],
		["Don't run the linter but do run `cargo test`.", "named"],
		["Rules:\n- don't touch the docs\n- `cargo test` must pass", "named"],
		["Rules:\n1. never push\n2. `cargo test` must pass", "named"],
		["Don't touch the docs.\n\n`cargo test` must pass.", "named"],
		// Said not to run.
		["Don't run `cargo test`.", "negated"],
		["Do not, under any circumstances, run `cargo test`.", "negated"],
		["Never run `cargo test` here", "negated"],
		["Fix it without running `cargo test`.", "negated"],
		["Use `make check` instead of `cargo test`.", "negated"],
		["There is no need to run `cargo test`.", "negated"],
		["You can skip `cargo test`.", "negated"],
		["Stop running `cargo test`.", "negated"],
		["Please don’t run `cargo test`.", "negated"],
		["Do not run this:\n```\ncargo test\n```", "negated"],
		["Don't run: `cargo test`", "negated"],
		// Named once to run and once not to: not run.
		["Make sure `cargo test` passes. Actually, don't run `cargo test`.", "negated"],
		// Not a whole code span.
		["Make sure cargo test passes.", "absent"],
		["Make sure `cargo test --all` passes.", "absent"],
		["Make sure `cd core && cargo test` passes.", "absent"],
		["Log:\n```\n$ cargo test\nerror[E0425]: cannot find value\n```", "absent"],
		["Log:\n```\nrunning 3 tests\ncargo test\n```", "absent"],
		["    cargo test\n", "absent"],
		["> cargo test", "absent"],
		["", "absent"],
	])("%j → %s", (message, expected) => {
		expect(namedInRequest("cargo test", message)).toBe(expected);
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
		expect(acceptRequestCheck("cargo test", "Do not run `cargo test`.")).toEqual({
			ok: false,
			reason: "the request says not to run it",
		});
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
