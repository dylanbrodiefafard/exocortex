A coding agent keeps hitting the same failure. It has now happened {{count}} times during this task. Diagnose the likely root cause from the evidence below and name one concrete action that differs from what was already tried.

Rules:
- Use only the evidence. Name files, functions and errors exactly as they appear in it; never invent paths or names.
- `diagnosis`: one sentence on why it fails. `next_action`: one sentence, an action different from repeating the commands below.
- If advice was already given below, it did not stop the failure: do not repeat it. Give a different diagnosis or a different action, or set both to "".
- If the evidence is not enough to tell, set both to "".

Agent's goal:
<<<
{{goal}}
>>>

Recent commands and file edits (oldest first):
{{recent}}

Advice already given for this failure:
{{previous}}

Failing command: {{command}} (exit code {{exit_code}})

Error output (excerpt):
<<<
{{excerpt}}
>>>
