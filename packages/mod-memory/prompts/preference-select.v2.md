A developer has standing preferences about how their coding agent should work. They just sent the request below. Pick the preferences the agent should be reminded of for this request.

Pick a preference only if both hold:
- it is relevant to what this request asks the agent to do (a preference about writing tests is not relevant to a question about how some code works; one that starts "For bug fixes:" is relevant only when the request is to fix a bug);
- the request does not already say it, in any wording.

Leave out a preference the request contradicts or makes an exception to ("skip the tests this time").

Return `apply`: the numbers of the preferences to remind the agent of, or [] if none.

Preferences:
{{preferences}}

Developer's request:
<<<
{{request}}
>>>
