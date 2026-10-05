/** Commands that print nothing worth classifying: skipped when deciding what a command line outputs. */
const SILENT: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "export", "set", "source", ".", "true", ":"]);
/** Prefixes that run another command; their own flags and numbers are skipped with them. */
const WRAPPERS: ReadonlySet<string> = new Set(["sudo", "env", "time", "timeout", "nice", "nohup", "command", "stdbuf"]);
const GIT_GLOBAL_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree"]);

/**
 * Whether a shell command's output is content the agent asked to see, as opposed to the log of a
 * build or test run: every part of the command line that prints ends in one of `names` (`cat`,
 * `grep`, `git diff`, a pipe into `tail`…). Such output is not trimmed: the agent chose it, and
 * head/tail/error selection would mangle it (RTK's "respect what was asked for").
 *
 * Anything this cannot read with confidence (heredocs, substitutions, unbalanced quotes) is not
 * content, so it is trimmed as before.
 */
export function printsRequestedContent(command: string, names: readonly string[]): boolean {
	const segments = splitCommand(command);
	if (!segments) return false;
	let printing = 0;
	for (const pipeline of segments) {
		const name = commandName(pipeline.at(-1) ?? []);
		if (name === undefined || SILENT.has(name)) continue;
		if (!names.includes(name)) return false;
		printing += 1;
	}
	return printing > 0;
}

/** The command a stage runs, as `name` or `git <subcommand>`, past env assignments and wrappers. */
function commandName(words: readonly string[]): string | undefined {
	let i = 0;
	while (i < words.length) {
		const word = words[i] ?? "";
		if (/^\w+=/.test(word) || WRAPPERS.has(word) || /^-|^\d+[smhd]?$/.test(word)) i++;
		else break;
	}
	const name = words[i]?.replace(/^.*\//, "");
	if (name !== "git") return name;
	i++;
	while (i < words.length && words[i]?.startsWith("-")) i += GIT_GLOBAL_FLAGS_WITH_VALUE.has(words[i] ?? "") ? 2 : 1;
	return words[i] === undefined ? "git" : `git ${words[i]}`;
}

/**
 * Splits a command line into its `&&` / `||` / `;` / `&` / newline parts, each a pipeline of
 * stages, each stage a list of words. Quotes and backslashes are honored; undefined when the line
 * uses syntax this does not model.
 */
function splitCommand(command: string): string[][][] | undefined {
	if (/<<|\$\(|`|[(){}]/.test(command.replace(/'[^']*'/g, "''"))) return undefined;
	const tokens = tokenize(command);
	if (!tokens) return undefined;
	const segments: string[][][] = [];
	let pipeline: string[][] = [];
	let stage: string[] = [];
	for (const token of [...tokens, SEGMENT_END]) {
		if (typeof token === "string") {
			// Redirections say where output goes, not what runs.
			if (!/^(\d*|&)[<>]/.test(token)) stage.push(token);
			continue;
		}
		if (stage.length > 0) pipeline.push(stage);
		stage = [];
		if (token === SEGMENT_END && pipeline.length > 0) {
			segments.push(pipeline);
			pipeline = [];
		}
	}
	return segments;
}

const STAGE_END = Symbol("|");
const SEGMENT_END = Symbol(";");
type Token = string | typeof STAGE_END | typeof SEGMENT_END;

/** Words and the operators between them; undefined on an unterminated quote. */
function tokenize(command: string): Token[] | undefined {
	const tokens: Token[] = [];
	let word: string | undefined;
	let quote: string | undefined;
	const endWord = () => {
		if (word !== undefined) tokens.push(word);
		word = undefined;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i] ?? "";
		if (quote) {
			if (c === quote) quote = undefined;
			else word += c;
			continue;
		}
		const operator = operatorAt(command, i, word ?? "");
		if (operator) {
			endWord();
			tokens.push(operator.token);
			i += operator.length - 1;
		} else if (c === "'" || c === '"') {
			quote = c;
			word ??= "";
		} else if (/\s/.test(c)) endWord();
		else word = (word ?? "") + (c === "\\" ? (command[++i] ?? "") : c);
	}
	endWord();
	return quote ? undefined : tokens;
}

/** The control operator starting at `i`, if any; `&` inside a redirection (`2>&1`, `&>f`) is not one. */
function operatorAt(command: string, i: number, word: string): { token: Token; length: number } | undefined {
	const two = command.slice(i, i + 2);
	if (two === "&&" || two === "||") return { token: SEGMENT_END, length: 2 };
	if (two === "|&") return { token: STAGE_END, length: 2 };
	const c = command[i];
	if (c === "|") return { token: STAGE_END, length: 1 };
	if (c === ";" || c === "\n") return { token: SEGMENT_END, length: 1 };
	if (c === "&" && !/[<>]$/.test(word) && command[i + 1] !== ">") return { token: SEGMENT_END, length: 1 };
	return undefined;
}
