You are reviewing a code change for bugs. A coding agent made the change for the developer's request below. The change is finished and is said to work: your job is to find what is wrong with it that its author missed. Other reviewers read the same change, and a separate check tests every report before anyone acts on it, so report each bug you can show, not only the most obvious one.

Report only bugs in what the change wrote: code that does the wrong thing for some input or state the program can meet. For example:
- a wrong result, a crash, a hang, lost or corrupted data;
- a case the request covers that the code gets wrong (an edge case, an error case, an exact value);
- a caller, test or file the change left inconsistent with it (a renamed or changed function still used the old way);
- a security hole the change opens (injection, a secret written out, a check removed);
- a leftover that changes behaviour: debug output on a path users see, a disabled check, a hard-coded test value.

These are not bugs, so do not report them:
- a problem that was there before the change and that the change does not make worse;
- something that looks wrong but is correct once you follow the code;
- style, naming, formatting, comments, documentation, or how you would have written it;
- nitpicks a senior engineer would not raise, and general code-quality concerns ("could be cleaner", "might be slow", "missing tests");
- what a compiler, type checker or linter reports on its own;
- something the code deliberately allows or silences, with a comment or setting saying so;
- a guess about code you are not shown. Do not speculate that the change breaks other code unless you can point to the code it breaks.

For each bug:
- `file`: the path, as in the diff header.
- `quote`: one line the bug is in or starts from, copied exactly, with enough text to be unique; never `}` or a blank line. Either a line the change added (a `+` line, without the `+`), or, for a caller the change left behind, the line of that caller as the other-places block below shows it (without its `path:line:` prefix; then `file` is that caller's path). A finding that quotes neither is not used.
- `title`: the bug in one sentence.
- `scenario`: a concrete, realistic case: what input or state, what the code does, and what it should do instead.
- `severity`: "high" (wrong results, a crash or data loss on a path that will be used), "medium" (wrong on an edge or error case), "low" (wrong only in an unusual case).

Many changes have no bugs. An empty list is a good answer when you find nothing you can show. Report at most {{max_findings}} findings, the surest first.

Developer's request:
<<<
{{request}}
>>>

{{uses_label}}:
<<<
{{uses}}
>>>

The change (`git diff` with each changed function shown whole; lines starting with `+` were added, `-` removed):
<<<
{{diff}}
>>>
