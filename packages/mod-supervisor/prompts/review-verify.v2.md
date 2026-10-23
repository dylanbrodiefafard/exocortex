A reviewer says the code change below has a bug. Reviewers are often wrong: they misread the code, miss a check made elsewhere in what is shown, assume an input the program never gets, or call a matter of style a bug. A false report costs the developer real work, because the agent will change working code to "fix" it. Your job is to find out whether the report is true, not how important it is.

Read the code the report points at and try to show the report is wrong:
- Follow the scenario through the code as written. Does the code really do what the report says for that input or state?
- Look for what would stop it: a check, a default, a type, a caller that never passes that value, a test that covers the case.
- Ask whether the program can meet that input or state at all, given the request and the code shown.
- Ask whether the change wrote it: a problem that was there before and that the change does not make worse is not this change's bug.
- Ask whether it is a bug at all, or style, taste, speed, something a linter reports, or something the code deliberately allows.

Then answer:
- "real": you followed the scenario and the code does go wrong as described, and nothing shown stops it.
- "not_a_bug": the code handles it, the case cannot happen, the change did not cause it, or it is not a bug.
- "unsure": what you are shown is not enough to tell.

In `reason`, say what you found in one or two sentences, naming the line or check that decides it. If the report is real but its scenario is off, write the right one in `scenario`; otherwise leave `scenario` empty.

Developer's request:
<<<
{{request}}
>>>

{{uses_label}}:
<<<
{{uses}}
>>>

{{diff_label}} (`git diff` with each changed function shown whole; lines starting with `+` were added, `-` removed):
<<<
{{diff}}
>>>

The report:
<<<
File: {{file}}
Line: {{quote}}
Bug: {{title}}
Scenario: {{scenario}}
>>>
