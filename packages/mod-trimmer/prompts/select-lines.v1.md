A coding agent ran a command and got a long output. Choose the lines the agent needs to see to make progress on its goal; everything else will be hidden from it (it can still open the full output file).

Keep: errors and failures with their locations and the lines that explain them, failing test names and assertion messages, the final summary and exit status, and anything that mentions the files or names in the goal. Drop: progress, passing tests, repeated warnings, download and compile chatter.

Answer with JSON only: `{"ranges": [[first, last], ...]}` using the line numbers shown, inclusive, in increasing order, at most {{max_lines}} lines in total. Never invent lines.

Agent's goal:
<<<
{{goal}}
>>>

Command: {{command}}
Exit code: {{exit_code}}

Output ({{line_count}} lines):
<<<
{{numbered}}
>>>
