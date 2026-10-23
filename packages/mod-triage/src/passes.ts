import { cleanTerminalOutput, commandBase, shellCommands } from "@exocortex/core";

/**
 * What a passing test run shows to be fixed (D-108 amendments). A whole run of the tests passing
 * fixes every test command's failures; a run narrowed to some tests (`pytest tests/a.py::t`,
 * `cargo test parse`, `go test -run X`) fixes only its own, and what it names; a run that ran no
 * test fixes nothing. The supervisor (D-107) and memory (D-109) read narrowing for their own ends;
 * this is triage's reading, kept local so modules do not depend on each other.
 */

/** Options that select tests by name, marker, package or target. */
const SELECTOR =
	/^(-k|-m|-run|-R|-L|-E|-t|-g|-p|--package|--test|--tests|--filter|--grep|--testNamePattern|--test-name-pattern|--label-regex)(=|$)/;
/** A positional that names a test file or a test id. */
const TEST_TARGET = /::|\.(py|[cm]?[jt]sx?|rs|go|rb|java|kt|c|cc|cpp|cxx|php|exs?|swift)$/;
/** Runners whose arguments are their own recipe's, never a selection of tests. */
const RECIPES = /^(g?make|ninja|just|task|cmake)$/;
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Whether a test run (`VerifyingRun.bare`) covers only some of the tests. */
export function isNarrowed(bare: string): boolean {
	let [first = "", ...args] = shellCommands(bare)?.[0]?.words ?? bare.trim().split(/\s+/);
	let name = commandBase(first);
	if (RECIPES.test(name)) return false;
	// `python -m pytest x`: the module is the runner.
	const module = args.indexOf("-m");
	if (/^(python|pypy)[\d.]*$/.test(name) && module !== -1) {
		name = args[module + 1] ?? "";
		args = args.slice(module + 2);
	}
	if (args.some((arg) => SELECTOR.test(arg))) return true;
	// `npm test -- src/a.test.ts`: what follows `--` goes to the runner.
	if (PACKAGE_MANAGERS.has(name))
		return args.includes("--") && positionals(args.slice(args.indexOf("--") + 1)).some((a) => TEST_TARGET.test(a));
	const named = positionals(args);
	if (name === "cargo") return named.slice(named[0] === "nextest" ? 2 : 1).length > 0;
	if (name === "go") {
		const packages = named.slice(1).filter((a) => a.startsWith(".") || a.includes("/"));
		return packages.length > 0 && !packages.some((p) => p.includes("...") || /^\.\/?$/.test(p));
	}
	if (name === "unittest") return named.length > 0 && named[0] !== "discover";
	return named.some((arg) => TEST_TARGET.test(arg));
}

function positionals(args: readonly string[]): string[] {
	const out: string[] = [];
	for (const arg of args) {
		if (arg === "--") break;
		if (!/^[-+]|^\w+=|^\d+$/.test(arg)) out.push(arg);
	}
	return out;
}

/** What says a run ran no test: a filter that matched nothing, an empty suite. */
const NO_TESTS =
	/\b(running 0 tests|no tests to run|no tests ran|collected 0 items|Ran 0 tests|no test files|no tests found|0 passed)\b/i;
/** What says some test ran. */
const SOME_TESTS = [
	/\b[1-9]\d* (passed|passing)\b/i,
	/\bRan [1-9]\d* tests?\b/,
	/\b[1-9]\d* tests? (passed|ok)\b/i,
	/^ok\s+\S+\s+[\d.]+s\s*$/m,
	/\[\s+PASSED\s+\] [1-9]/,
];

/** Whether a passing run's output says it ran no test (`cargo test nomatch`: "0 passed … filtered out"). */
export function ranNoTests(output: string): boolean {
	const text = cleanTerminalOutput(output);
	return NO_TESTS.test(text) && !SOME_TESTS.some((pattern) => pattern.test(text));
}

/**
 * Whether a run's command line or output names every one of the failing tests: by its whole id, or
 * by its last part (`tests/a.py::test_total` by `test_total`) when that is long enough to mean it.
 */
export function namesAll(items: readonly string[], text: string): boolean {
	return (
		items.length > 0 &&
		items.every((item) => {
			const last = item.split(/::|\.|\/| > /).at(-1) ?? "";
			return text.includes(item) || (last.length >= 4 && text.includes(last));
		})
	);
}
