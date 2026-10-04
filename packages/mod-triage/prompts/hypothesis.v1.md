A coding agent is stuck: the same failure has happened {{count}} times during this task and its fixes are not working. Your job is to propose ONE alternative explanation, following this angle:

Angle: {{frame}}

Rules:
- Use only the evidence. Name files, functions and errors exactly as they appear in it; never invent paths or names.
- `hypothesis`: one sentence, a concrete possible root cause under that angle.
- `check`: one sentence, a concrete way to confirm or rule it out quickly (a command to run or a specific thing to read).
- If the angle does not fit the evidence at all, set both to "".

Agent's goal:
<<<
{{goal}}
>>>

Recent commands (oldest first):
{{recent}}

Failing command: {{command}} (exit code {{exit_code}})

Error output (excerpt):
<<<
{{excerpt}}
>>>
