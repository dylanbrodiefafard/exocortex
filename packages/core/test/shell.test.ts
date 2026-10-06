import { describe, expect, it } from "vitest";
import { commandBase, shellCommands, splitCommand, unwrapCommand } from "../src/modules/shell.ts";

/** A shell parameter expansion, spelled so it is not taken for a template placeholder. */
const BRACED = "$" + "{X:-y}";

describe("splitCommand", () => {
	it("splits on unquoted operators into pipelines of stages of words", () => {
		expect(splitCommand("cd pkg && cat a.txt; grep -rn foo . | head -3")).toEqual([
			[["cd", "pkg"]],
			[["cat", "a.txt"]],
			[
				["grep", "-rn", "foo", "."],
				["head", "-3"],
			],
		]);
		expect(splitCommand("a || b & c\nd |& e")).toEqual([[["a"]], [["b"]], [["c"]], [["d"], ["e"]]]);
	});

	it("honors quotes and backslashes", () => {
		expect(splitCommand(`grep -c 'a && b' "c | d" e\\;f ''`)).toEqual([[["grep", "-c", "a && b", "c | d", "e;f", ""]]]);
		expect(splitCommand(`echo "say \\"hi\\"; ok" 'it''s'`)).toEqual([[["echo", 'say "hi"; ok', "its"]]]);
		expect(splitCommand("make \\\n  test")).toEqual([[["make", "test"]]]);
	});

	it("leaves redirections and their targets out of the words", () => {
		expect(splitCommand("cargo test > log.txt 2>&1")).toEqual([[["cargo", "test"]]]);
		expect(splitCommand("make 2>/dev/null >>out.log &>all.log")).toEqual([[["make"]]]);
		expect(splitCommand("sort < in.txt >out.txt; a>b c")).toEqual([[["sort"]], [["a", "c"]]]);
		expect(splitCommand("echo '>' \"2>&1\" 2>&1 && ls")).toEqual([[["echo", ">", "2>&1"]], [["ls"]]]);
		expect(shellCommands("cat <<< hello | wc -c")?.map((c) => c.words)).toEqual([["cat"], ["wc", "-c"]]);
	});

	it("skips comments", () => {
		expect(splitCommand("# build first\nmake # then test\nmake test")).toEqual([[["make"]], [["make", "test"]]]);
		expect(splitCommand("echo a#b '#c'")).toEqual([[["echo", "a#b", "#c"]]]);
	});

	it("reads quoted syntax characters as text, and a quoted substitution as a substitution (D-083)", () => {
		expect(splitCommand('grep -rn "fn main()" src')).toEqual([[["grep", "-rn", "fn main()", "src"]]]);
		expect(splitCommand('rg "impl<T> Foo {" src; grep "a << b" notes.txt')).toEqual([
			[["rg", "impl<T> Foo {", "src"]],
			[["grep", "a << b", "notes.txt"]],
		]);
		expect(splitCommand("find . -name x -exec grep -n todo {} \\;")).toEqual([
			[["find", ".", "-name", "x", "-exec", "grep", "-n", "todo", "{}", ";"]],
		]);
		expect(splitCommand("echo \\(a\\) \"\\$(not run)\" '$(nor this)'")).toEqual([
			[["echo", "(a)", "$(not run)", "$(nor this)"]],
		]);
		for (const command of ['echo "today is $(date)"', 'echo "today is `date`"', `echo "${BRACED}"`, "cat <(ls)"]) {
			expect(splitCommand(command), command).toBeUndefined();
		}
	});

	it("is undefined for what it does not model as a flat list, and for an unterminated quote", () => {
		for (const command of [
			"cat <<EOF\nx\nEOF",
			"cat $(find . -name x)",
			"echo `date`",
			"(cd x && ls)",
			"{ ls; }",
			`echo ${BRACED}`,
			"grep 'unterminated file",
			'echo "unterminated',
		]) {
			expect(splitCommand(command), command).toBeUndefined();
		}
	});
});

describe("shellCommands", () => {
	const read = (command: string) =>
		shellCommands(command)?.map(
			(c) => `${c.words.join(" ")}${c.exitShown ? "" : " [hidden]"}${c.piped ? " [piped]" : ""}`,
		);

	it("says for each command whether the line's exit code shows its failure", () => {
		expect(read("cd app && cargo test")).toEqual(["cd app", "cargo test"]);
		expect(read("cargo test; echo done")).toEqual(["cargo test [hidden]", "echo done"]);
		expect(read("cargo test || true")).toEqual(["cargo test [hidden]", "true"]);
		expect(read("cargo build && cargo test || echo no")).toEqual([
			"cargo build [hidden]",
			"cargo test [hidden]",
			"echo no",
		]);
		expect(read("cargo test &")).toEqual(["cargo test [hidden]"]);
		expect(read("cargo test;")).toEqual(["cargo test"]);
		expect(read("! cargo test")).toEqual(["cargo test [hidden]"]);
	});

	it("reads pipes, with and without pipefail", () => {
		expect(read("cargo test 2>&1 | tee log | tail -5")).toEqual([
			"cargo test [hidden] [piped]",
			"tee log [hidden] [piped]",
			"tail -5",
		]);
		expect(read("set -o pipefail; cargo test | tail")).toEqual(["set -o pipefail [hidden]", "cargo test", "tail"]);
		expect(read("set -euo pipefail\ncargo test | tail\necho ok")).toEqual([
			"set -euo pipefail",
			"cargo test",
			"tail",
			"echo ok",
		]);
		expect(read("set -eo pipefail; set +o pipefail; a | b")).toEqual([
			"set -eo pipefail",
			"set +o pipefail",
			"a [hidden] [piped]",
			"b",
		]);
		expect(read("set -o errexit; a && b; c")).toEqual(["set -o errexit", "a [hidden]", "b", "c"]);
		expect(read("set -e; set +e; a; b")).toEqual(["set -e", "set +e [hidden]", "a [hidden]", "b"]);
		expect(read("set -- x y; a")).toEqual(["set -- x y [hidden]", "a"]);
	});

	it("reads through subshells, brace groups and compound commands", () => {
		expect(read("(cd x && cargo test) | tail")).toEqual([
			"cd x [hidden] [piped]",
			"cargo test [hidden] [piped]",
			"tail",
		]);
		expect(read("(cd x && cargo test)")).toEqual(["cd x", "cargo test"]);
		expect(read("{ make; make test; } 2>&1 | tail")).toEqual([
			"make [hidden] [piped]",
			"make test [hidden] [piped]",
			"tail",
		]);
		expect(read("(set -o pipefail; a | b); c | d")).toEqual([
			"set -o pipefail [hidden]",
			"a [hidden]",
			"b [hidden]",
			"c [hidden] [piped]",
			"d",
		]);
		expect(read("if cargo test; then echo ok; else echo no; fi")).toEqual([
			"cargo test [hidden]",
			"echo ok [hidden]",
			"echo no [hidden]",
		]);
		expect(read("for f in a b; do pytest $f; done")).toEqual(["for f in a b [hidden]", "pytest $f [hidden]"]);
		expect(read("case $x in a) ls;; esac")).toEqual(["case $x in a [hidden]", "ls [hidden]", "esac"]);
		expect(read("f() { cargo test; }; f")).toEqual(["f [hidden]", "cargo test [hidden]", "f"]);
	});

	it("reads the script of an inline shell, under that shell's options", () => {
		expect(read("bash -lc 'cd app && cargo test | tail -5'")).toEqual([
			"cd app",
			"cargo test [hidden] [piped]",
			"tail -5",
		]);
		expect(read("bash -euo pipefail -c 'a | b; c'")).toEqual(["a", "b", "c"]);
		expect(read("timeout 60 sh -c 'make test' | tail")).toEqual(["make test [hidden] [piped]", "tail"]);
		expect(read("nix-shell --run 'cargo test'")).toEqual(["cargo test"]);
		expect(read("bash build.sh && zsh -x run.zsh")).toEqual(["bash build.sh", "zsh -x run.zsh"]);
		// A script that cannot be read stays one command.
		expect(read("bash -c 'echo \"x'")).toEqual(['bash -c echo "x']);
		expect(read("bash --norc -c")).toEqual(["bash --norc -c"]);
		expect(read('sh -c \'sh -c "sh -c \\"sh -c ls\\""\'')).toEqual(["sh -c ls"]);
	});

	it("reads past heredocs, substitutions and comments", () => {
		expect(read("cat > x.py <<'EOF'\nprint('a | b'); (\nEOF\npython3 x.py")).toEqual(["cat [hidden]", "python3 x.py"]);
		expect(read("cat <<-EOF | sh\n\tls\n\tEOF\necho done")).toEqual([
			"cat [hidden] [piped]",
			"sh [hidden]",
			"echo done",
		]);
		expect(read("cat <<EOF\nnever closed")).toEqual(["cat"]);
		expect(read(`echo "$(git log | head -1)" \`ls | wc -l\` $((1 + 2)) ${BRACED} <(sort a)`)).toEqual([
			`echo $(git log | head -1) \`ls | wc -l\` $((1 + 2)) ${BRACED} <(sort a)`,
		]);
		expect(read("# only a comment")).toEqual([]);
		expect(read("")).toEqual([]);
	});

	it("is undefined when the line cannot be read", () => {
		for (const command of ["echo 'open", 'echo "open', "echo `open", "echo $(open", BRACED.slice(0, -1), "cat << "]) {
			expect(shellCommands(command), command).toBeUndefined();
		}
	});

	it("gives the line without what each command is piped into", () => {
		const unpiped = (command: string) => shellCommands(command)?.map((c) => c.unpiped);
		expect(unpiped("cd a && make 2>&1 | tail -3 && ls")).toEqual([
			"cd a && make 2>&1 | tail -3 && ls",
			"cd a && make 2>&1 && ls",
			"cd a && make 2>&1 | tail -3 && ls",
			"cd a && make 2>&1 | tail -3 && ls",
		]);
		expect(unpiped("(a | b) 2>&1 | c")).toEqual(["(a) 2>&1", "(a | b) 2>&1", "(a | b) 2>&1 | c"]);
	});
});

describe("unwrapCommand", () => {
	it.each([
		["RUST_BACKTRACE=1 CI=true cargo test", "cargo test"],
		["env X=1 cargo test", "cargo test"],
		["env -i -u HOME -- make", "make"],
		["time -p go test ./...", "go test ./..."],
		["timeout -k 5 --signal=KILL 60 pytest -x", "pytest -x"],
		["sudo -u build nice -n 10 ionice -c 3 make", "make"],
		["nohup stdbuf -oL -e L command exec make", "make"],
		["uv run --with hypothesis --python 3.12 -- pytest", "pytest"],
		["poetry run pytest", "pytest"],
		["pipenv run python -m pytest", "python -m pytest"],
		["conda run -n dev --no-capture-output pytest", "pytest"],
		["bundle exec rspec", "rspec"],
		["npx -y -p typescript tsc --noEmit", "tsc --noEmit"],
		["pnpm --filter core exec vitest run", "vitest run"],
		["npm exec -- jest", "jest"],
		["yarn dlx jest", "jest"],
		["bun x vitest", "vitest"],
		["xvfb-run -a -n 99 npm test", "npm test"],
		[
			'nix --extra-experimental-features "nix-command flakes" shell nixpkgs#nodejs_22 -c npm run check',
			"npm run check",
		],
		["nix develop --command cargo test", "cargo test"],
		// Not wrappers here: no command follows, or the subcommand is another one.
		["uv sync", "uv sync"],
		["pnpm test", "pnpm test"],
		["poetry install", "poetry install"],
		["env", "env"],
		["timeout 60", "timeout 60"],
		["nix build", "nix build"],
		["nix shell -c", "nix shell -c"],
		["FOO=bar", "FOO=bar"],
		["cargo test", "cargo test"],
	])("%s → %s", (command, inner) => {
		expect(unwrapCommand(command.replace(/["']/g, "").split(" ")).join(" ")).toBe(inner.replace(/["']/g, ""));
	});

	it("stops at a wrapper nested too deep to be one", () => {
		expect(unwrapCommand(Array.from({ length: 12 }, () => "sudo").concat("ls"))).toEqual([
			"sudo",
			"sudo",
			"sudo",
			"sudo",
			"ls",
		]);
	});

	it("names a command without its directory", () => {
		expect(commandBase(".venv/bin/pytest")).toBe("pytest");
		expect(commandBase("make")).toBe("make");
		expect(commandBase(undefined)).toBe("");
	});
});
