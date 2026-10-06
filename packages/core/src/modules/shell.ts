/**
 * Reading a shell command line without running it (D-077): its words, the commands it runs, and
 * for each whether the line's exit code would show that it failed. One tokenizer serves the
 * trimmer's "what does this print" (D-070), the run classifier (D-071, D-075) and the benign-exit
 * rule (D-043). It models what agents write in a tool call, not all of bash.
 */

type Operator = "|" | "&&" | "||" | ";" | "&" | "(" | ")";

interface Token {
	readonly op?: Operator;
	readonly word?: string;
	/** A redirection (`2>&1`, `>`, `<`): says where output goes, not what runs. */
	readonly redirect?: boolean;
	readonly start: number;
	readonly end: number;
}

interface Stage {
	readonly words: readonly string[];
	/** A subshell or brace group in place of a command. */
	readonly group?: readonly Pipeline[];
	readonly end: number;
}

interface Pipeline {
	readonly stages: readonly Stage[];
	/** The operator after it: `&&`, `||`, `;` (or a newline) or `&`. */
	readonly sep?: Operator;
}

/** One command a line runs, wherever it sits: in a pipeline, a subshell or a `bash -c` script. */
export interface ShellCommand {
	/** Its words past environment assignments and wrappers (`env`, `timeout 60`, `uv run`…), without redirections. */
	readonly words: readonly string[];
	/**
	 * The line exits non-zero whenever this command does: it is not piped into another command
	 * (without `pipefail`), followed by `;` or `||`, sent to the background, or used as a condition.
	 */
	readonly exitShown: boolean;
	/** Its exit code is lost to a pipe: it is piped into another command without `pipefail`. */
	readonly piped: boolean;
	/** The line without what this command is piped into: `cd x && cargo test 2>&1` for `… | tail -5`. */
	readonly unpiped: string;
}

/**
 * Splits a command line into its `&&` / `||` / `;` / `&` / newline parts, each a pipeline of
 * stages, each stage a list of words. Quotes and backslashes are honored; undefined when the line
 * uses syntax this does not model as a flat list (heredocs, substitutions, subshells, braces).
 */
export function splitCommand(command: string): string[][][] | undefined {
	if (/<<|\$\(|`|[(){}]/.test(command.replace(/'[^']*'/g, "''"))) return undefined;
	const tokens = tokenize(command);
	if (!tokens) return undefined;
	return parseList(tokens, { at: 0 }, 0).map((pipeline) => pipeline.stages.map((stage) => [...stage.words]));
}

/**
 * Every command a line runs, in order, with what its exit code can tell (see {@link ShellCommand}).
 * Subshells, brace groups, `bash -c '…'` scripts, heredocs and substitutions are read through.
 * Undefined when the line cannot be read (an unterminated quote).
 */
export function shellCommands(command: string): ShellCommand[] | undefined {
	const tokens = tokenize(command);
	if (!tokens) return undefined;
	const out: ShellCommand[] = [];
	// Later spans first, so the earlier offsets still hold.
	const unpiped = (cuts: readonly Cut[]) =>
		[...cuts]
			.sort((a, b) => b[0] - a[0])
			.reduce((text, [from, to]) => text.slice(0, from) + text.slice(to), command)
			.trim();
	const options = { pipefail: false, errexit: false };
	walk(parseList(tokens, { at: 0 }, 0), options, { shown: true, piped: false, cuts: [], unpiped, out, depth: 0 });
	return out;
}

/**
 * A command's words past what only sets up or wraps the run: `VAR=…`, `env`, `time`,
 * `timeout [opts] 60`, `sudo`, `nice`, `uv run`, `poetry run`, `npx`, `pnpm exec`, `nix … -c`.
 */
export function unwrapCommand(words: readonly string[]): string[] {
	let rest = [...words];
	for (let depth = 0; depth < MAX_WRAPPERS; depth++) {
		let i = 0;
		while (ASSIGNMENT.test(rest[i] ?? "")) i++;
		if (i > 0 && i < rest.length) rest = rest.slice(i);
		const inner = unwrapOnce(rest);
		if (!inner) break;
		rest = inner;
	}
	return rest;
}

/** A command's name without its directory: `pytest` for `.venv/bin/pytest`. */
export function commandBase(word: string | undefined): string {
	return (word ?? "").replace(/^.*\//, "");
}

// --- Wrappers ----------------------------------------------------------------------------------

const MAX_WRAPPERS = 8;
const MAX_SCRIPT_DEPTH = 3;
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;

interface Wrapper {
	/** The subcommand that makes it a wrapper: `uv run`, not `uv sync`. */
	readonly sub?: readonly string[];
	/** Options that take their value as the next word. */
	readonly values?: readonly string[];
	/** Arguments of its own before the command: `timeout`'s duration. */
	readonly positionals?: number;
}

const CONDA: Wrapper = { sub: ["run"], values: ["-n", "--name", "-p", "--prefix", "--cwd"] };
const NPX: Wrapper = { values: ["-p", "--package"] };
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map(
	Object.entries({
		env: { values: ["-u", "--unset", "-C", "--chdir"] },
		sudo: { values: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"] },
		doas: { values: ["-u"] },
		time: { values: ["-f", "-o"] },
		timeout: { values: ["-k", "--kill-after", "-s", "--signal"], positionals: 1 },
		nice: { values: ["-n", "--adjustment"] },
		ionice: { values: ["-c", "-n", "-p"] },
		nohup: {},
		command: {},
		exec: {},
		builtin: {},
		stdbuf: { values: ["-i", "-o", "-e"] },
		unbuffer: {},
		setsid: {},
		chronic: {},
		"xvfb-run": { values: ["-n", "-s", "-e", "-f", "-w", "-p", "--server-args", "--server-num"] },
		uv: {
			sub: ["run"],
			values: [
				"--with",
				"--with-editable",
				"--with-requirements",
				"--extra",
				"--group",
				"--only-group",
				"--python",
				"-p",
				"--project",
				"--directory",
				"--package",
				"--env-file",
				"--index",
			],
		},
		poetry: { sub: ["run"], values: ["-C", "--directory", "-P", "--project"] },
		pdm: { sub: ["run"], values: ["-p", "--project", "--venv"] },
		pipenv: { sub: ["run"] },
		rye: { sub: ["run"] },
		hatch: { sub: ["run"], values: ["-e", "--env"] },
		pixi: { sub: ["run"], values: ["-e", "--environment", "--manifest-path"] },
		conda: CONDA,
		mamba: CONDA,
		micromamba: CONDA,
		bundle: { sub: ["exec"] },
		npx: NPX,
		pnpx: NPX,
		bunx: NPX,
		npm: { sub: ["exec", "x"], values: ["--prefix", "-w", "--workspace", "-p", "--package"] },
		pnpm: { sub: ["exec", "dlx"], values: ["-C", "--dir", "--filter", "-F"] },
		yarn: { sub: ["exec", "dlx"], values: ["--cwd"] },
		bun: { sub: ["x"], values: ["--cwd"] },
	} satisfies Record<string, Wrapper>),
);

function unwrapOnce(words: readonly string[]): string[] | undefined {
	const name = commandBase(words[0]);
	const args = words.slice(1);
	if (name === "nix") {
		// `nix shell nixpkgs#nodejs_22 -c npm test`, `nix develop --command cargo test`.
		const at = args.findIndex((arg) => arg === "-c" || arg === "--command");
		return at !== -1 && at + 1 < args.length ? args.slice(at + 1) : undefined;
	}
	const wrapper = WRAPPERS.get(name);
	if (!wrapper) return undefined;
	let i = skipOptions(args, 0, wrapper);
	if (wrapper.sub) {
		if (!wrapper.sub.includes(args[i] ?? "")) return undefined;
		i = skipOptions(args, i + 1, wrapper);
	}
	i += wrapper.positionals ?? 0;
	if (args[i] === "--") i++;
	return i < args.length ? args.slice(i) : undefined;
}

/** The index of the first argument from `from` that is not one of the wrapper's own options. */
function skipOptions(args: readonly string[], from: number, wrapper: Wrapper): number {
	let i = from;
	while (i < args.length && /^-./.test(args[i] ?? "") && args[i] !== "--") {
		i += wrapper.values?.includes(args[i] ?? "") ? 2 : 1;
	}
	return i;
}

// --- Shell options and inline scripts ----------------------------------------------------------

interface ShellOptions {
	pipefail: boolean;
	errexit: boolean;
}

/**
 * Reads the options of `set …` or `bash …` from the second word on: `-e`, `-euo pipefail`,
 * `+o pipefail`. Returns where they end, and whether `-c` was among them.
 */
function readShellOptions(words: readonly string[], options: ShellOptions): { rest: number; inline: boolean } {
	let inline = false;
	let i = 1;
	for (; i < words.length; i++) {
		const word = words[i] ?? "";
		if (!/^[-+]./.test(word)) break;
		if (word.startsWith("--")) continue;
		const on = word.startsWith("-");
		if (word.includes("c")) inline = on;
		if (word.includes("e")) options.errexit = on;
		if (!word.endsWith("o")) continue;
		const named = words[++i];
		if (named === "pipefail") options.pipefail = on;
		if (named === "errexit") options.errexit = on;
	}
	return { rest: i, inline };
}

/** The script of `bash -lc '…'`, `sh -c "…"` or `nix-shell --run '…'`, with the shell options given. */
function inlineScript(words: readonly string[]): { script: string; options: ShellOptions } | undefined {
	const name = commandBase(words[0]);
	const options = { pipefail: false, errexit: false };
	if (name === "nix-shell") {
		const at = words.findIndex((word) => word === "--run" || word === "--command");
		const script = at === -1 ? undefined : words[at + 1];
		return script === undefined ? undefined : { script, options };
	}
	if (!/^(ba|z|da|k)?sh$/.test(name)) return undefined;
	const { rest, inline } = readShellOptions(words, options);
	const script = words[rest];
	return inline && script !== undefined ? { script, options } : undefined;
}

// --- From the parsed line to its commands ------------------------------------------------------

/** Words that start a compound command or a branch of one: what follows runs under a condition. */
const KEYWORDS: ReadonlySet<string> = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"while",
	"until",
	"do",
	"done",
	"!",
]);

/** A span of the source to leave out: from the end of a piped command to the end of its pipeline. */
type Cut = readonly [from: number, to: number];

/** Where a list of pipelines sits in the line. */
interface Place {
	/** A failure of the list fails the line. */
	readonly shown: boolean;
	/** The list is inside something piped into another command. */
	readonly piped: boolean;
	readonly cuts: readonly Cut[];
	readonly unpiped: (cuts: readonly Cut[]) => string;
	readonly out: ShellCommand[];
	/** How many inline scripts deep. */
	readonly depth: number;
}

function walk(list: readonly Pipeline[], inherited: ShellOptions, place: Place): void {
	// A subshell's `set` ends with it.
	const options = { ...inherited };
	for (const [index, pipeline] of list.entries()) {
		// A `set` on its own changes this shell; as a stage of a pipeline it runs in a subshell.
		const only = pipeline.stages.length === 1 ? pipeline.stages[0] : undefined;
		if (only?.words[0] === "set") readShellOptions(only.words, options);
		const reaches = place.shown && failureReachesEnd(list, index, options);
		const count = pipeline.stages.length;
		const end = pipeline.stages[count - 1]?.end ?? 0;
		for (const [position, stage] of pipeline.stages.entries()) {
			const final = position === count - 1;
			const inside: Place = {
				...place,
				shown: reaches && (final || options.pipefail),
				piped: place.piped || !(final || options.pipefail),
				cuts: final ? place.cuts : [...place.cuts, [stage.end, end]],
			};
			if (stage.group) walk(stage.group, options, inside);
			else addCommand(stage.words, inside);
		}
	}
}

/**
 * Whether the list exits non-zero when the pipeline at `index` does. A failure skips the rest of
 * its `&&` list; after that only the end of the list, or `set -e` at a `;`, lets it through.
 */
function failureReachesEnd(list: readonly Pipeline[], index: number, options: ShellOptions): boolean {
	let last = index;
	while (list[last]?.sep === "&&" && last + 1 < list.length) last++;
	const sep = list[last]?.sep;
	if (last === list.length - 1) return sep !== "&";
	// Under `set -e` the shell stops at a failing command that ends its `&&` list.
	return sep === ";" && options.errexit && last === index;
}

function addCommand(stageWords: readonly string[], place: Place): void {
	let words = stageWords;
	while (KEYWORDS.has(words[0] ?? "")) words = words.slice(1);
	if (words.length === 0) return;
	const unwrapped = unwrapCommand(words);
	const exitShown = place.shown && words.length === stageWords.length;
	const line = place.unpiped(place.cuts);
	const inline = place.depth < MAX_SCRIPT_DEPTH ? inlineScript(unwrapped) : undefined;
	const tokens = inline ? tokenize(inline.script) : undefined;
	if (!(inline && tokens)) {
		place.out.push({ words: unwrapped, exitShown, piped: place.piped, unpiped: line });
		return;
	}
	const script: Place = { ...place, shown: exitShown, cuts: [], unpiped: () => line, depth: place.depth + 1 };
	walk(parseList(tokens, { at: 0 }, 0), inline.options, script);
}

// --- Parsing -----------------------------------------------------------------------------------

function parseList(tokens: readonly Token[], cursor: { at: number }, depth: number): Pipeline[] {
	const list: Pipeline[] = [];
	let stages: Stage[] = [];
	const endPipeline = (sep?: Operator) => {
		if (stages.length > 0) list.push(sep ? { stages, sep } : { stages });
		stages = [];
	};
	for (let token = tokens[cursor.at]; token; token = tokens[cursor.at]) {
		if (token.op === ")" && depth > 0) break;
		if (token.op === undefined) {
			stages.push(...parseWords(tokens, cursor));
			// `name (` starts something else: a function body is its own list.
			if (tokens[cursor.at]?.op === "(") endPipeline(";");
			continue;
		}
		cursor.at++;
		if (token.op === "(") stages.push(...parseGroup(tokens, cursor, depth, token.end));
		// A stray `)` is a `case` pattern: what follows is another command.
		else if (token.op !== "|") endPipeline(token.op === ")" ? ";" : token.op);
	}
	endPipeline();
	return list;
}

/** A subshell or brace group, from after its `(` to past its `)` and the redirections that follow. */
function parseGroup(tokens: readonly Token[], cursor: { at: number }, depth: number, open: number): Stage[] {
	const group = parseList(tokens, cursor, depth + 1);
	let end = tokens[cursor.at]?.end ?? open;
	cursor.at++;
	while (tokens[cursor.at]?.word !== undefined) end = tokens[cursor.at++]?.end ?? end;
	return group.length > 0 ? [{ words: [], group, end }] : [];
}

/** A command's words up to the next operator, without redirections and their targets. */
function parseWords(tokens: readonly Token[], cursor: { at: number }): Stage[] {
	const words: string[] = [];
	let end = 0;
	let target = false;
	for (let token = tokens[cursor.at]; token?.word !== undefined; token = tokens[++cursor.at]) {
		end = token.end;
		if (token.redirect) target = /[<>]$/.test(token.word);
		else if (target) target = false;
		else words.push(token.word);
	}
	return words.length > 0 ? [{ words, end }] : [];
}

// --- Tokenizing --------------------------------------------------------------------------------

interface Scan {
	readonly source: string;
	at: number;
	readonly tokens: Token[];
	/** The word being read, and where it started. */
	word: string | undefined;
	start: number;
	/** Nothing in the word was quoted or escaped: `{` is a brace, `2>` a redirection. */
	plain: boolean;
	redirect: boolean;
	/** Heredocs opened on this line: their bodies start after its newline. */
	readonly heredocs: { tag: string; tabs: boolean }[];
	/** An unterminated quote or substitution: the line cannot be read. */
	failed: boolean;
}

/** Each reads one construct at the scan's position and says whether it did. */
const READERS: readonly ((scan: Scan) => boolean)[] = [
	readQuote,
	readExpansion,
	readEscapeOrComment,
	readHeredoc,
	readNewline,
	readRedirect,
	readOperator,
];

/** Words and the operators between them, with where each sits in the source; undefined on an unterminated quote. */
function tokenize(command: string): Token[] | undefined {
	const scan: Scan = {
		source: command,
		at: 0,
		tokens: [],
		word: undefined,
		start: 0,
		plain: true,
		redirect: false,
		heredocs: [],
		failed: false,
	};
	while (scan.at < command.length && !scan.failed) {
		if (READERS.some((read) => read(scan))) continue;
		const c = command[scan.at] ?? "";
		if (/\s/.test(c)) endWord(scan, scan.at);
		else add(scan, c, true);
		scan.at++;
	}
	endWord(scan, command.length);
	return scan.failed ? undefined : scan.tokens;
}

function add(scan: Scan, text: string, literal: boolean): void {
	if (scan.word === undefined) {
		scan.word = "";
		scan.start = scan.at;
		scan.plain = true;
		scan.redirect = false;
	}
	scan.word += text;
	if (!literal) scan.plain = false;
}

function endWord(scan: Scan, end: number): void {
	const { word, start } = scan;
	if (word === undefined) return;
	scan.word = undefined;
	if (scan.plain && (word === "{" || word === "}")) scan.tokens.push({ op: word === "{" ? "(" : ")", start, end });
	else scan.tokens.push(scan.redirect ? { word, redirect: true, start, end } : { word, start, end });
}

/** Adds the source up to and including `close` to the word, less `strip` characters at each end; fails without a close. */
function addSpan(scan: Scan, close: number, strip: number): true {
	if (close === -1) scan.failed = true;
	else {
		add(scan, scan.source.slice(scan.at + strip, close + 1 - strip), false);
		scan.at = close + 1;
	}
	return true;
}

function readQuote(scan: Scan): boolean {
	const { source, at } = scan;
	const c = source[at];
	if (c === "'") return addSpan(scan, source.indexOf("'", at + 1), 1);
	// A command substitution stays in the word as written.
	if (c === "`") return addSpan(scan, source.indexOf("`", at + 1), 0);
	if (c !== '"') return false;
	let text = "";
	let i = at + 1;
	for (; i < source.length && source[i] !== '"'; i++) {
		const escaped = source[i] === "\\" && /["\\$`\n]/.test(source[i + 1] ?? "");
		if (escaped) i++;
		// A backslash before a newline continues the line.
		if (!(escaped && source[i] === "\n")) text += source[i] ?? "";
	}
	if (i >= source.length) scan.failed = true;
	else {
		add(scan, text, false);
		scan.at = i + 1;
	}
	return true;
}

/** `$(…)`, `<(…)`, `>(…)` and `${…}`: kept in the word as written, whatever is inside. */
function readExpansion(scan: Scan): boolean {
	const { source, at } = scan;
	const c = source[at];
	const next = source[at + 1];
	if ((c === "$" || c === "<" || c === ">") && next === "(") return addSpan(scan, closingParen(source, at + 1), 0);
	if (c === "$" && next === "{") return addSpan(scan, source.indexOf("}", at), 0);
	return false;
}

function readEscapeOrComment(scan: Scan): boolean {
	const { source, at } = scan;
	if (source[at] === "\\") {
		// A backslash before a newline continues the line.
		if (source[at + 1] !== "\n") add(scan, source[at + 1] ?? "", false);
		scan.at += 2;
		return true;
	}
	if (source[at] !== "#" || scan.word !== undefined) return false;
	const newline = source.indexOf("\n", at);
	scan.at = newline === -1 ? source.length : newline;
	return true;
}

/** `<<EOF`, `<<-'EOF'`: remembered until the line ends. `<<<` is a redirection. */
function readHeredoc(scan: Scan): boolean {
	const { source, at } = scan;
	if (!source.startsWith("<<", at) || source[at + 2] === "<") return false;
	endWord(scan, at);
	const match = /^<<(-?)[ \t]*(["']?)([^\s"'|&;()<>]+)\2/.exec(source.slice(at));
	if (!match) scan.failed = true;
	else {
		scan.heredocs.push({ tag: (match[3] ?? "").replace(/\\/g, ""), tabs: match[1] === "-" });
		scan.at += match[0].length;
	}
	return true;
}

function readNewline(scan: Scan): boolean {
	if (scan.source[scan.at] !== "\n") return false;
	endWord(scan, scan.at);
	scan.tokens.push({ op: ";", start: scan.at, end: scan.at + 1 });
	scan.at++;
	// The bodies of the heredocs opened on this line follow it.
	for (const heredoc of scan.heredocs.splice(0)) scan.at = afterHeredoc(scan.source, scan.at, heredoc);
	return true;
}

/** `>`, `2>`, `&>`, `>>` and the `&` of `2>&1`: they start or continue a redirection word. */
function readRedirect(scan: Scan): boolean {
	const { source, at } = scan;
	const c = source[at];
	const word = scan.plain ? scan.word : undefined;
	if (c === "<" || c === ">") {
		// `a>b` is a word followed by a redirection; `2>` is the redirection itself.
		if (scan.word !== undefined && !/^(\d*|&)[<>]*$/.test(word ?? "x")) endWord(scan, at);
		add(scan, c, true);
		scan.redirect = true;
		scan.at++;
		return true;
	}
	if (c !== "&") return false;
	const opens = source[at + 1] === ">";
	const continues = scan.redirect && /[<>]$/.test(word ?? "");
	if (!(opens || continues)) return false;
	if (opens && scan.word !== undefined) endWord(scan, at);
	add(scan, c, true);
	scan.at++;
	return true;
}

function readOperator(scan: Scan): boolean {
	const { source, at } = scan;
	const c = source[at];
	if (!(c === "(" || c === ")" || c === ";" || c === "|" || c === "&")) return false;
	endWord(scan, at);
	const two = source.slice(at, at + 2);
	const op: Operator = two === "&&" || two === "||" ? two : two === "|&" ? "|" : c;
	const length = two === "&&" || two === "||" || two === "|&" ? 2 : 1;
	scan.tokens.push({ op, start: at, end: at + length });
	scan.at += length;
	return true;
}

/** The index of the `)` that closes the `(` at `open`, past nested ones and quotes; -1 without one. */
function closingParen(source: string, open: number): number {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const c = source[i];
		if (c === "\\") i++;
		else if (c === "'" || c === '"') {
			const close = source.indexOf(c, i + 1);
			if (close === -1) return -1;
			i = close;
		} else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return -1;
}

/** The index after a heredoc's closing line, or the end of the text when it has none. */
function afterHeredoc(source: string, from: number, heredoc: { tag: string; tabs: boolean }): number {
	let at = from;
	while (at < source.length) {
		const newline = source.indexOf("\n", at);
		const end = newline === -1 ? source.length : newline;
		const line = source.slice(at, end);
		at = Math.min(source.length, end + 1);
		if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.tag) break;
	}
	return at;
}
