A coding agent's conversation is being compacted: the transcript below will be deleted and replaced by a summary. The user's requests, the files changed and the commands run are already recorded separately and exactly, so do not repeat them. Write only what the agent needs to continue the work that is not obvious from those records.

Return JSON:
- `current_work`: what the agent was doing at the end of the transcript, specifically (files, functions, the step in progress). At most 3 sentences.
- `next_step`: the very next concrete action. One sentence.
- `dead_ends`: approaches that were tried and failed, each with why ("tried X: failed because Y"). At most 6; [] if none.
- `key_facts`: facts discovered that the agent will need (APIs, conventions, causes of bugs, constraints the user stated). At most 8; [] if none.

Use names exactly as they appear in the transcript. Do not invent anything.
{{previous}}{{instructions}}
Transcript (oldest first; may start mid-way):
<<<
{{conversation}}
>>>
