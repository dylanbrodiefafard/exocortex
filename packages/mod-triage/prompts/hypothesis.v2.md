A coding agent is stuck: the command below has reported the same errors {{count}} times during this task and its fixes are not changing them. Your job is to propose ONE alternative explanation, following this angle:

Angle: {{frame}}

Rules:
- Use only the evidence. Name files, functions and errors exactly as they appear in it; never invent paths or names.
- `hypothesis`: one sentence, a concrete possible root cause under that angle.
- `check`: one sentence, a concrete way to confirm or rule it out quickly (a command to run or a specific thing to read).
- The edits listed below did not change the failure: a cause they would have fixed is ruled out.
- If the angle does not fit the evidence at all, set both to "".

The request the agent is working on:
<<<
{{goal}}
>>>

Recent commands and file edits (oldest first):
{{recent}}

Edits made since this failure first appeared (it failed the same way after them):
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
