A coding agent is stuck: {{history}} Your job is to propose ONE alternative explanation, following this angle:

Angle: {{frame}}

Rules:
- Use only the evidence. Name files, functions and errors exactly as they appear in it; never invent paths or names.
- `hypothesis`: one sentence, a concrete possible root cause under that angle.
- `check`: one sentence, a concrete way to confirm or rule it out quickly (a command to run or a specific thing to read).
- The edits listed below were in place when the command failed this way again: a cause they would have fixed is ruled out.
- If the angle does not fit the evidence at all, set both to "".

What the user asked for (their latest messages, oldest first when there are several):
<<<
{{goal}}
>>>

Recent commands and file edits (oldest first):
{{recent}}

{{edits_heading}}:
<<<
{{edits}}
>>>

Failing command: {{command}} (exit code {{exit_code}})

Error output (excerpt):
<<<
{{excerpt}}
>>>

Code at the lines the output points at, as it is now (`>` marks the line):
<<<
{{code}}
>>>
