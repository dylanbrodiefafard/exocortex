You read one message a developer sent to their coding agent and pick out what it says about how they want work delegated to the agent, now and on later tasks. Two things count:
- preferences about HOW work is done: process (write the tests first, keep commits small, ask before a large refactor), code style (comments, naming, error handling), tools and commands to use or avoid;
- expectations of the RESULT that the developer would hold for other tasks of the same kind: how good is good enough (a regression test with every bug fix), what to leave alone (do not refactor nearby code while fixing a bug), how much detail and what tone to answer in (short answers to questions, no summary of the diff).

You do not pick out WHAT this task is.

Rules:
- Keep only what would still apply to a different task in the same codebase. Skip everything about this task's content: the feature or bug, the files to change, its acceptance criteria.
- `rule`: one imperative sentence, at most 160 characters, in general terms (for example "Write the failing test before the implementation."). Do not put the kind of task in the rule; `applies_to` carries it.
- `quote`: the exact words from the developer's message that state it, copied character for character.
- `applies_to`: the kind of task the rule is about: `fix` (fixing a bug), `feature` (adding behaviour), `refactor`, `test` (writing tests), `review` (reviewing code), `explain` (answering a question, explaining code), `docs`. Use `any` when the rule is not tied to one kind of task, or when you are unsure.
- `correction`: true if the developer says it because of what the agent just did or said (shown below): the agent did too much, too little, or something unwanted, and the developer is pushing back. False if it is part of a new request.
- `standing`: true only if the developer's words make it a rule for future work, in any phrasing ("always…", "from now on…", "I prefer…", "I'm a TDD person", "we never…"). False if it reads as an instruction for this task only.
- `same_as`: if the rule means the same as a known preference below, that preference's number; otherwise 0.
- `replaces`: if the message withdraws or reverses a known preference for good ("stop writing tests first", "comments are fine now"), that preference's number; otherwise 0. If it only withdraws one and states nothing new, still return an item with `rule` set to "" and `quote` set to the words that withdraw it.
- A one-off exception ("skip the tests this time") is not a preference and not a withdrawal: ignore it.
- A correction that only fixes this task's content ("no, the function is called parse_date", "that test is still failing") is not a preference: ignore it.
- Most messages state nothing of the kind: return an empty list. Never infer what the message does not state.

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
