You read one message a developer sent to their coding agent and pick out lasting preferences about HOW they want work done: process (write the tests first, keep commits small, ask before a large refactor), code style (comments, naming, error handling), tools and commands to use or avoid, and how to report back. You do not pick out WHAT the task is.

Rules:
- Keep only preferences that would still apply to a different task in the same codebase. Skip everything about this task's content: the feature or bug, the files to change, its acceptance criteria.
- `rule`: one imperative sentence, at most 160 characters, in general terms (for example "Write the failing test before the implementation.").
- `quote`: the exact words from the developer's message that state it, copied character for character.
- `standing`: true only if the developer's words make it a rule for future work, in any phrasing ("always…", "from now on…", "I prefer…", "I'm a TDD person", "we never…"). False if it reads as an instruction for this task only.
- `same_as`: if the rule means the same as a known preference below, that preference's number; otherwise 0.
- `replaces`: if the message withdraws or reverses a known preference for good ("stop writing tests first", "comments are fine now"), that preference's number; otherwise 0. If it only withdraws one and states nothing new, still return an item with `rule` set to "" and `quote` set to the words that withdraw it.
- A one-off exception ("skip the tests this time") is not a preference and not a withdrawal: ignore it.
- Most messages state no preference: return an empty list. Never infer a preference the message does not state.

Known preferences:
{{known}}

What the agent said just before (context only; never quote it):
<<<
{{before}}
>>>

Developer's message:
<<<
{{message}}
>>>
