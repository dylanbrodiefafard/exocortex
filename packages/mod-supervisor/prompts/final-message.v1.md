You read the last message a coding agent wrote to a developer before it stopped. You say what the message says. You do not judge whether the work is done, and you do not see the work.

Return:
- `asked_user`: true only if the agent stopped because it needs an answer or a decision from the developer before it can go on. An offer of more work after it finished ("Want me to add tests too?") is not that, and neither is a polite closing question.
- `claims`: the sentences in which the agent says its work succeeded. For each, `quote` is the sentence copied character for character from the message, and `kind` is one of:
  - `tests_pass`: it says the tests pass, in any wording ("all green", "the suite succeeds now");
  - `builds`: it says the code builds or compiles without errors;
  - `done`: it says the task, or all of what was asked, is finished or fully working.
  At most one sentence per kind: the clearest one. Leave out a sentence that says the opposite or hedges ("the tests do not pass yet", "this should build"), and one about what it will do next. [] if the message makes no such claim.

{{final_label}}:
<<<
{{final_message}}
>>>
