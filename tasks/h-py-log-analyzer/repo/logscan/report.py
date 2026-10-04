"""Aggregate parsed log entries into the summary report described in README.md."""

from collections import Counter
from datetime import datetime, timezone

from logscan.parsers import exception_class, is_continuation, parse_entry

TOP_CODES = 5


class _Accumulator:
    def __init__(self):
        self.lines = 0
        self.entries = 0
        self.unparsed = 0
        self.levels = Counter()
        self.errors_by_service = Counter()
        self.error_codes = Counter()
        self.exceptions = Counter()
        self.first_ts = None
        self.last_ts = None

    def add(self, entry):
        self.entries += 1
        self.levels[entry.level] += 1
        if entry.is_error:
            self.errors_by_service[entry.service] += 1
            if entry.code:
                self.error_codes[entry.code] += 1
        if entry.trace:
            cls = exception_class(entry.trace)
            if cls:
                self.exceptions[cls] += 1
        ts = _parse_ts(entry.ts)
        if ts is not None:
            if self.first_ts is None or ts < self.first_ts:
                self.first_ts = ts
            if self.last_ts is None or ts > self.last_ts:
                self.last_ts = ts

    def result(self):
        top = sorted(self.error_codes.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_CODES]
        return {
            "lines": self.lines,
            "entries": self.entries,
            "unparsed": self.unparsed,
            "levels": dict(sorted(self.levels.items())),
            "errors_by_service": dict(sorted(self.errors_by_service.items())),
            "top_error_codes": [[code, count] for code, count in top],
            "exceptions": dict(sorted(self.exceptions.items())),
            "first_ts": _format_ts(self.first_ts),
            "last_ts": _format_ts(self.last_ts),
        }


def _parse_ts(raw):
    try:
        ts = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


def _format_ts(ts):
    if ts is None:
        return None
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def build_report(lines):
    """Build the report for an iterable of log lines (with or without trailing newlines)."""
    acc = _Accumulator()
    current = None
    for raw in lines:
        acc.lines += 1
        line = raw.rstrip("\n")
        entry = parse_entry(line)
        if entry is not None:
            if current is not None:
                acc.add(current)
            current = entry
        elif current is not None and is_continuation(line):
            current.trace.append(line)
        else:
            acc.unparsed += 1
    if current is not None:
        acc.add(current)
    return acc.result()


def analyze_file(path):
    with open(path, encoding="utf-8") as fh:
        return build_report(fh)
