A coding agent keeps hitting the same failure: {{history}} Diagnose the likely root cause from the evidence below and name one concrete action that differs from what was already tried.

Rules:
- Use only the evidence. Name files, functions and errors exactly as they appear in it; never invent paths or names.
- `diagnosis`: one sentence on why it fails. `next_action`: one sentence, an action different from the edits and commands below.
- The edits listed below were in place when the command failed this way again. They did not fix it: do not propose them again. If they changed code the errors do not point at, say where the errors do point.
- If the errors went away and came back, one of those edits may have brought them back: say which, if the evidence shows it.
- Read the code at the error locations as it is now, and the request for what the code is supposed to do there. If the error says exactly what is wrong and the code shows it, say that.
- If advice was already given below, it did not stop the failure: do not repeat it. Give a different diagnosis or a different action, or set both to "".
- If the evidence is not enough to tell, set both to "".

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

Advice already given for this failure:
{{previous}}

Failing command: {{command}} (exit code {{exit_code}})

Error output (excerpt):
<<<
{{excerpt}}
>>>

Code at the lines the output points at, as it is now (`>` marks the line):
<<<
{{code}}
>>>
