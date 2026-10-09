You read one message a developer sent to their coding agent and pick out what it says about how they want work delegated to the agent. Two things count:
- preferences about HOW work is done: process (write the tests first, keep commits small, ask before a large refactor), code style (comments, naming, error handling), tools and commands to use or avoid;
- expectations of the RESULT that the developer would hold for other tasks of the same kind: how good is good enough (a regression test with every bug fix), what to leave alone (do not refactor nearby code while fixing a bug), how much detail and what tone to answer in (short answers to questions, no summary of the diff).

You do not pick out WHAT this task is.

Rules:
- Keep only what could apply to a different task in the same codebase. Skip everything about this task's content: the feature or bug, the files to change, its acceptance criteria.
- `rule`: one imperative sentence, at most 160 characters, in general terms (for example "Write the failing test before the implementation."). Do not put the kind of task in the rule; `applies_to` carries it.
- When the developer takes back or reverses something they asked for before ("stop writing tests first", "comments are fine now"), that is a preference too. Write the rule as what they want now ("Do not write the tests before the implementation.", "Comments in the code are allowed.").
- `quote`: the exact words from the developer's message that state it, copied character for character.
- `holds`: how long the developer means it to hold. Read the meaning, in any phrasing or language:
  - `standing`: their words make it a rule for future work ("always…", "from now on…", "I prefer…", "I'm a TDD person", "we never…", "stop doing…").
  - `task`: an instruction for how to do this task, with nothing that says whether it holds beyond it ("write the tests first for the parser").
  - `exception`: they set aside how they normally want things, for this task only ("skip the tests this time", "just patch it quickly for now, no refactor").
  When unsure between `standing` and `task`, use `task`.
- `applies_to`: the kind of task the rule is about: `fix` (fixing a bug), `feature` (adding behaviour), `refactor`, `test` (writing tests), `review` (reviewing code), `explain` (answering a question, explaining code), `docs`. Use `any` when the rule is not tied to one kind of task, or when you are unsure.
- `correction`: true if the developer says it because of what the agent just did or said (shown below): the agent did too much, too little, or something unwanted, and the developer is pushing back. False if it is part of a new request.
- A correction that only fixes this task's content ("no, the function is called parse_date", "that test is still failing") is not a preference: leave it out.
- Most messages state nothing of the kind: return an empty list. Never infer what the message does not state.

What the agent said just before (context only; never quote it):
<<<
{{before}}
>>>

Developer's message:
<<<
{{message}}
>>>
