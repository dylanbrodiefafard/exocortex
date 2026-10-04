# logscan

Summarizes the aggregated service log that ops pulls from the collectors.

```
python3 analyze.py logs/app.log          # human-readable summary
python3 analyze.py logs/app.log --json   # the report as JSON
```

`logs/app.log` is not checked in. Generate a representative one with
`python3 tools/gen_logs.py --seed 1 > logs/app.log`.

Run the tests with `python3 -m unittest discover -q -s tests -t .`.

## Input

The file is read as UTF-8. Bytes that are not valid UTF-8 are replaced with
U+FFFD; they never abort the run. Lines are separated by `\n`.

Every line is classified as exactly one of the following, checked in this order.

1. **Text entry**: `<timestamp> <level> [<service>] <message>`, fields separated by
   one or more spaces, for example

   ```
   2026-03-14T00:00:01.400Z WARN  [gateway] slow query code=E1001 latency_ms=2661
   ```

   The error code, if any, is the value of a `code=<CODE>` token in the message.

2. **Key=value entry**: a line starting with `ts=`. Fields are `key=value` pairs
   separated by spaces. A value is either a double-quoted string, which may contain
   spaces, `=`, and the escapes `\"` and `\\`, or an unquoted run of non-space
   characters (any characters other than space, including quotes and apostrophes).
   Recognized keys: `ts`, `level`, `service`, `msg`, `code`. Other keys are ignored.

   ```
   ts=2026-03-14T00:00:02.181Z level=error service=gateway msg="charge declined" user=dave code=E2002
   ```

3. **JSON entry**: a line starting with `{` that parses as a JSON object, with keys
   `ts`, `level`, `service`, `msg` and optionally `code`. Some emitters nest the code
   instead: `"error": {"code": "E2001", "type": "Timeout"}`. A top-level `code` wins;
   otherwise the nested `error.code` is the entry's code. A `{` line that is not a
   valid JSON object is unparsed.

4. **Continuation line**: belongs to the most recent entry (it is part of that
   entry's stack trace). A continuation line is one of:
   - a line that starts with whitespace (tab or space) and is not entirely whitespace,
     e.g. `\tat com.acme.Foo.bar(Foo.java:12)` or `\t... 12 more`;
   - a line starting with `Caused by: `;
   - an exception header: a fully qualified Java class name (a dotted identifier such
     as `java.io.IOException`), optionally followed by `: ` and a message.

   A continuation-looking line before the first entry is unparsed.

5. Anything else (blank or whitespace-only lines, binary junk, truncated JSON, ...)
   is **unparsed**.

### Timestamps

ISO-8601 with milliseconds and either `Z` or a `+HH:MM`/`-HH:MM` UTC offset.
Emitters in other regions log local time with an offset.

### Levels

Levels are case-insensitive. The canonical levels are `TRACE`, `DEBUG`, `INFO`,
`WARN`, `ERROR`, `FATAL`. Some emitters use aliases: `WARNING` means `WARN`,
`ERR` means `ERROR`, and `CRITICAL` means `FATAL`. An **error entry** is one whose
level is `ERROR` or `FATAL`.

## Report

`--json` prints one object:

| key | meaning |
|---|---|
| `lines` | number of physical lines in the file |
| `entries` | number of entries (text, key=value and JSON) |
| `unparsed` | number of unparsed lines |
| `levels` | `{level: count}` over all entries, canonical level names only |
| `errors_by_service` | `{service: count}` of error entries |
| `top_error_codes` | `[[code, count], ...]`: the 5 most frequent codes among error entries, by count descending, ties by code ascending |
| `exceptions` | `{class: count}` over entries that have a stack trace: the **root cause** class, i.e. the class named by the last `Caused by: ` line, or by the exception header if there is no `Caused by: ` line |
| `first_ts`, `last_ts` | earliest and latest entry timestamp (by actual instant), converted to UTC and formatted `YYYY-MM-DDTHH:MM:SSZ` (fractional seconds dropped); `null` if there are no entries |

Lines + entries bookkeeping: every line is counted in `lines`; each line is
exactly one of an entry, a continuation line, or unparsed.
