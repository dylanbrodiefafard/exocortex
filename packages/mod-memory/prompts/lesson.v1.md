A coding agent hit an error and then fixed it. Write the lesson as a short note that would help it avoid or quickly fix the same error next time in this codebase.

Rules:
- `lesson`: one or two sentences, at most 300 characters. Say what causes this error here and what fixed it, concretely (name the file, function or construct as it appears below). Do not retell the story.
- `applies_when`: a few words describing when the lesson applies (for example "borrowing a field while iterating over self.items").
- Use only names that appear below. If the fix does not teach anything reusable (a typo, a one-off), set both to "".

Command: {{command}}

Error:
<<<
{{excerpt}}
>>>

The fix (edits made before the command passed):
<<<
{{edits}}
>>>
