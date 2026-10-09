A developer has preferences about how their coding agent should work. They have just stated one. Say how it stands with the preferences already known.

The developer's words:
<<<
{{quote}}
>>>

The preference they state, as a rule:
<<<
{{rule}}
>>>

{{known_heading}}
{{known}}

Compare the stated rule with each known preference by what an agent would do when following it, not by the words used.

Return:
- `same`: the number of the known preference that asks for the same thing as the stated rule, in any wording ("Work test-first." and "Write the failing test before the implementation."). 0 if there is none. A preference about the same subject that asks for something different is not the same.
- `contradicts`: the numbers of the known preferences that the stated rule goes against: an agent cannot follow both ("Indent with spaces." against "Indent with tabs."; "Comments in the code are allowed." against "Never add comments."). [] if there are none. A rule that only adds to a known preference, or narrows it, does not contradict it.

A known preference cannot be both. Most stated rules are new: then return 0 and [].
