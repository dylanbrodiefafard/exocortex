import { isAbsolute, relative, resolve } from "node:path";
import { commandBase, shellCommands, verifyingRun } from "@exocortex/core";
import { detailShare, wordsOf } from "./detail.ts";

/**
 * A command a failure or a pass came from, as memory pairs them (D-109): a fix is a failure of a
 * runner and a later pass of the same runner that covers it, however the agent narrowed or cut
 * the run in between (`pytest` fails, `pytest tests/x.py::test_y 2>&1 | tail` passes).
 */
export interface Run {
	/**
	 * What ran, without what it was narrowed to: `cargo test`, `pytest`, `npm run test`,
	 * `make -C app test`, after any `cd` before it. For a command that is not a test or build run,
	 * the whole command.
	 */
	readonly runner: string;
	/** What the run was narrowed to (tests, files, packages, `-k` expressions); empty for a whole run. */
	readonly filters: readonly string[];
	/** A run of the tests or the build (core's `verifyingRun`): only these are learned from. */
	readonly verifying: boolean;
}

/** How many leading arguments name what runs: `cargo test`, `go vet`, `make check`, `npm run lint`. */
const SUBCOMMANDS: ReadonlyMap<string, (positionals: readonly string[]) => number> = new Map([
	...["cargo", "go", "deno", "dotnet", "mvn", "gradle", "gradlew", "mix", "swift", "zig", "make", "gmake", "ninja"].map(
		(name) => [name, (p: readonly string[]) => Math.min(p.length, 1)] as const,
	),
	...["just", "task"].map((name) => [name, (p: readonly string[]) => Math.min(p.length, 1)] as const),
	...["npm", "pnpm", "yarn", "bun"].map(
		(name) =>
			[name, (p: readonly string[]) => (/^run(-script)?$/.test(p[0] ?? "") ? 2 : Math.min(p.length, 1))] as const,
	),
	["vitest", (p: readonly string[]) => (/^(run|watch|dev)$/.test(p[0] ?? "") ? 1 : 0)],
]);
/** Options that say where a run runs, not what it covers: part of the runner. */
const LOCATION = new Set([
	"-C",
	"--manifest-path",
	"--prefix",
	"--dir",
	"--cwd",
	"--directory",
	"--build",
	"-f",
	"--file",
]);
/**
 * Options that take a value which says how a run runs, not what it covers (`pytest -n auto`,
 * `go test -timeout 30s`, `cargo test --features x`): the value is not a filter. Options whose
 * value narrows the run (`-k`, `-run`, `-t`, `-p` for a crate) are left out, so their value is one.
 */
const COMMON_VALUES = ["--color", "--colour", "-j", "--jobs", "--timeout", "--reporter", "-c", "--config"];
const VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
	(
		[
			[
				"pytest",
				["-n", "--numprocesses", "--tb", "-p", "--rootdir", "--maxfail", "--durations", "-W", "-o"],
				["--log-level", "--junitxml", "--basetemp", "--cov", "--cov-report", "--dist", "--import-mode"],
			],
			[
				"go",
				["-timeout", "-count", "-parallel", "-cpu", "-covermode", "-coverprofile", "-coverpkg", "-tags"],
				["-exec", "-o", "-vet", "-shuffle", "-p"],
			],
			["cargo", ["--target", "--features", "-F", "--message-format", "--profile", "--target-dir", "-Z"], []],
			["vitest", ["--maxWorkers", "--pool", "--environment", "--shard", "--project"], []],
			["jest", ["--maxWorkers", "-w", "--testEnvironment", "--shard"], []],
			["ctest", ["--parallel", "-C", "--build-config", "--output-log", "--repeat"], []],
			["make", ["-l", "--load-average"], []],
		] as const
	).map(([name, a, b]) => [name, new Set([...COMMON_VALUES, ...a, ...b])] as const),
);
/** Arguments that cover everything: `go test ./...`, `pytest .`. */
const EVERYTHING = new Set([".", "./", "...", "./..."]);

/**
 * The run on a command line (D-109). The test or build run when there is one, read past `cd`,
 * wrappers, redirection and what it is piped into; otherwise the command line itself, with its
 * redirection of stderr left out. A `cd` into the working directory `cwd` is no `cd`: the runner
 * keeps only where it ran relative to `cwd`.
 */
export function runOf(line: string, cwd: string): Run | undefined {
	const run = verifyingRun(line);
	if (!run) {
		const whole = line
			.replace(/\s*2>&1/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 300);
		return whole === "" ? undefined : { runner: whole, filters: [], verifying: false };
	}
	const commands = shellCommands(line) ?? [];
	const at = commands.findLastIndex((command) => command.words.join(" ") === run.bare);
	const words = commands[at]?.words ?? run.bare.split(" ");
	const where = placeOf(
		commands
			.slice(0, Math.max(at, 0))
			.filter((command) => commandBase(command.words[0]) === "cd")
			.map((command) => command.words[1] ?? "~"),
		cwd,
	);
	const { runner, filters } = split(words);
	return { runner: where === "" ? runner : `cd ${where} && ${runner}`, filters, verifying: true };
}

/** Where a run's `cd`s took it, relative to `cwd`: "" for `cwd` itself. A `cd` that cannot be followed (`~`, `$DIR`, `-`) is kept as written. */
function placeOf(targets: readonly string[], cwd: string): string {
	let dir = cwd;
	for (const target of targets) {
		if (/^[~$-]/.test(target)) return targets.join(" && cd ");
		dir = resolve(dir, target);
	}
	const inside = relative(cwd, dir);
	return isAbsolute(inside) ? dir : inside;
}

function split(words: readonly string[]): { runner: string; filters: string[] } {
	let [name = "", ...args] = words;
	name = commandBase(name);
	// `python -m pytest` is `pytest`.
	const module = args.indexOf("-m");
	if (/^(python|pypy)[\d.]*$/.test(name) && module !== -1 && args[module + 1]) {
		name = args[module + 1] ?? name;
		args = args.slice(module + 2);
	}
	const location: string[] = [];
	const positionals: string[] = [];
	const values = VALUE_OPTIONS.get(name) ?? new Set(COMMON_VALUES);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (LOCATION.has(arg)) {
			location.push(arg, args[i + 1] ?? "");
			i++;
		} else if (values.has(arg)) i++;
		else if (!/^-|^\w+=|^\d+$/.test(arg) && !EVERYTHING.has(arg)) positionals.push(arg);
	}
	const named = SUBCOMMANDS.get(name)?.(positionals) ?? 0;
	return {
		runner: [name, ...location, ...positionals.slice(0, named)].join(" "),
		filters: positionals.slice(named).sort(),
	};
}

/** A failure still open for a runner: what it was narrowed to, and what it is named by (its test, its symbol). */
export interface OpenFailure {
	readonly runner: string;
	readonly filters: readonly string[];
	readonly named: readonly string[];
}

/**
 * Whether a pass covers a failure (D-109): the same runner, and either a whole run, a run narrowed
 * the same way, or one that names what the failure is named by (its test, in its command line or
 * output), at least `minDetail` of it. A run narrowed to other tests says nothing about this one.
 */
export function covers(failure: OpenFailure, pass: Run, passText: string, minDetail: number): boolean {
	if (failure.runner !== pass.runner) return false;
	if (pass.filters.length === 0) return true;
	if (pass.filters.join("\n") === failure.filters.join("\n")) return true;
	if (failure.named.length === 0) return false;
	const share = detailShare(failure.named, wordsOf(passText));
	return share > 0 && share >= minDetail;
}
