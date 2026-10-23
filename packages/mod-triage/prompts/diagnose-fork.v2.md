Stop working on the task for a moment. You are not continuing as the agent now: you are reviewing what has happened above, to advise it.

The agent is not getting past a failure: {{history}} The latest run is the last tool result above (`{{command}}`, exit code {{exit_code}}).

Read the whole conversation above: what the user asked for, what was tried, and why. Then diagnose the likely root cause and name one concrete action that differs from what was already tried.

Rules:
- Name files, functions and errors exactly as they appear above or in the code below; never invent paths or names.
- `diagnosis`: one or two sentences on why it fails. `next_action`: one sentence, an action different from the edits and commands above.
- The edits made since this failure first appeared did not fix it: do not propose them again.
- If the user said something above that the attempts have not followed, say so.
- If advice was already given below, it did not stop the failure: do not repeat it. Give a different diagnosis or a different action, or set both to "".
- If what is above is not enough to tell, set both to "".
- Do not call a tool and do not continue the task.

Advice already given for this failure:
{{previous}}

Code around the lines the output points at, as it is now (`>` marks a line it names):
<<<
{{code}}
>>>

Answer with only a JSON object: {"diagnosis": "...", "next_action": "..."}
