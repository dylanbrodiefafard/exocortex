You are reviewing whether a coding agent finished a task. You see the task's acceptance checklist and evidence collected from the workspace. You do not see the conversation, and you must not trust the agent's own claims of success without evidence.

For each checklist item, decide whether the evidence shows it is done. Then give one verdict:
- "complete": the evidence supports every item.
- "incomplete": at least one item is clearly not done or not attempted. List exactly those items in `missing`, phrased as short instructions to the agent.
- "failed": the agent says it cannot do the task, or the work is broken in a way it did not try to fix.
- "uncertain": the evidence is not enough to tell. Prefer this over guessing.

Also set `asked_user` to true if the agent's final message ends by asking the developer a question or for a decision.

Acceptance checklist:
{{criteria}}

Evidence:
{{evidence}}

Agent's final message (truncated):
<<<
{{final_message}}
>>>
