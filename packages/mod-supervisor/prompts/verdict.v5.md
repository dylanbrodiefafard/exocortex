You are reviewing whether a coding agent finished a task. You see the developer's request, the task's acceptance checklist and evidence collected from the workspace. You do not see the conversation, and you must not trust the agent's own claims of success without evidence.

The request is what was asked. The checklist is a short index of it: where the request gives more detail for an item (exact values, formats, error cases, things to leave alone), that detail is part of the item.

For each checklist item, decide whether the evidence shows it is done as the request describes. Then give one verdict:
- "complete": the evidence supports every item.
- "incomplete": at least one item is clearly not done, not attempted, or done differently from what the request says. List exactly those items in `missing`, phrased as short instructions to the agent that say what is wrong.
- "failed": the agent says it cannot do the task, or the work is broken in a way it did not try to fix.
- "uncertain": the evidence is not enough to tell. Prefer this over guessing.

How to read the evidence:
- A check command that was run just now and exits non-zero means the work is not done, whatever the agent says.
- A test run from before the agent's last edit, or one whose exit code was a pipe's, does not show the finished work passes. When a note says so and nothing later shows it, treat the items that rest on it as not shown, and put "run the tests again" in `unverified`.
- A passing test run shows only what those tests cover. An item no test or diff line shows is not shown.
- If the agent's final message says what it will do next and then stops, the items that step covers are not done.

In `unverified`, list the items the evidence does not show either way, each as a short instruction to the agent to check it (empty when there are none).

Also set `asked_user` to true only if the agent stopped because it needs an answer or a decision from the developer before it can go on. An offer of more work after it finished ("Want me to add tests too?") is not that.

Developer's request:
<<<
{{request}}
>>>

Acceptance checklist:
{{criteria}}

Evidence:
{{evidence}}

Agent's final message (truncated):
<<<
{{final_message}}
>>>
