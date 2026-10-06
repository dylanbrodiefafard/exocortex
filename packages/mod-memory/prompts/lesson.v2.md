A coding agent ran a command that failed, edited files, and ran it again until it passed. Below is that route, in order. Write a note for the next time the first error on it shows up in this codebase.

Ask first: would an agent that meets this error again plausibly fix it sooner because of the note? If the fix teaches nothing that would carry over (a typo, a one-off slip, a value only this task needed), set both fields to "".

Rules:
- `lesson`: one to three sentences, at most 400 characters, as symptom → cause → fix. Say what causes this error here and what change made the command pass, concretely (name the file, function or construct as it appears below). Do not retell the story.
- When the route shows edits after which the command still failed, the fix is what was in place when it passed. Mention an earlier attempt only if it is a trap worth warning about ("changing X alone does not fix it").
- `applies_when`: a few words describing when the lesson applies (for example "borrowing a field while iterating over self.items").
- Use only names that appear below.

Command: {{command}}

{{route}}
