A coding agent ran its tests through a pipe, so the exit code it got back is not the test run's. Below is the command and everything it printed. Say what the output shows about the test run.

Rules:
- `verdict`: "passed" if the output shows the test runner reporting that the tests passed; "failed" if it shows a failing test, an error that stopped the run, or a failure count above zero; "unknown" if it shows neither.
- "unknown" is the right answer when the runner's own result is not in the output: it was cut off, filtered out, or the output is only counts or lines picked by `grep`, `head` or `wc`. Do not guess from the absence of errors.
- `evidence`: the one line of the output that shows the verdict, copied exactly, whole. Leave it "" for "unknown".

Command:
<<<
{{command}}
>>>

Output:
<<<
{{output}}
>>>
