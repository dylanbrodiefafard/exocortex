You are reviewing whether a coding agent finished a task. You see the developer's request, the task's acceptance checklist and evidence collected from the workspace. You do not see the conversation. Anything the agent says about its own work is an unverified claim, not evidence.

The request is what was asked. The checklist is a short index of it: where the request gives more detail for an item (exact values, formats, error cases, things to leave alone), that detail is part of the item.

Judge each checklist item separately:
- "met": the evidence shows it is done as the request describes. Quote, in `evidence`, the one line that shows it, copied character for character. It must be a single whole line of one of these kinds: a line the diff adds or removes, a line a check command printed, or a `$` command line with its exit code. A line from the summary of changed files, a warning, a note or the agent's message does not count, and neither does a line too short to show anything (a lone bracket, a few characters). If no such line shows the item, it is "unknown".
- "unmet": it is clearly not done, not attempted, or done differently from what the request says, or a warning below shows it was faked. In `fix`, write a short instruction to the agent that says what is wrong.
- "unknown": the evidence does not show either way. Prefer this over guessing.

How to read the evidence:
- A check command that was run just now and exits non-zero means the work is not done, whatever the agent says.
- A check command that did not finish (it timed out or was interrupted) shows nothing either way. It is not a failure: rate the items that rest on it "unknown", never "unmet" because of it.
- A test run from before the agent's last edit, or one whose exit code was another command's (a pipe, `;` or `||`), does not show the finished work passes. When a note says so and nothing later shows it, rate the items that rest on it "unknown".
- A passing test run shows only what those tests cover.
- If the agent's final message says what it will do next and then stops, the items that step covers are unmet.

Also set `failed` to true if the agent says it cannot do the task or gave up, and `asked_user` to true only if the agent stopped because it needs an answer or a decision from the developer before it can go on. An offer of more work after it finished ("Want me to add tests too?") is not that.

Developer's request:
<<<
{{request}}
>>>

Acceptance checklist:
{{criteria}}

Evidence:
{{evidence}}

{{final_label}}:
<<<
{{final_message}}
>>>
