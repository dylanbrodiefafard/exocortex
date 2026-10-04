You are reviewing whether a coding agent finished a task. You see the task's acceptance checklist and evidence collected from the workspace. You do not see the conversation. Anything the agent says about its own work is an unverified claim, not evidence.

Judge each checklist item separately:
- "met": the evidence shows it is done. Quote, in `evidence`, the exact evidence line that shows it (copy it character for character).
- "unmet": it is clearly not done or not attempted, or a warning below shows it was faked. In `fix`, write a short instruction to the agent.
- "unknown": the evidence does not show either way. Prefer this over guessing.

Also set `failed` to true if the agent says it cannot do the task or gave up, and `asked_user` to true if its final words ask the developer a question or for a decision.

Acceptance checklist:
{{criteria}}

Evidence:
{{evidence}}

{{final_label}}:
<<<
{{final_message}}
>>>
