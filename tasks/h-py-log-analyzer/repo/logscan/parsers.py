"""Parsers for the line formats our services emit (see README.md)."""

import json
import re
import shlex
from dataclasses import dataclass, field

LEVELS = ("TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL")
ERROR_LEVELS = frozenset({"ERROR", "FATAL"})

TEXT_RE = re.compile(
    r"^(?P<ts>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))"
    r"\s+(?P<level>[A-Za-z]+)\s+\[(?P<service>[^\]]+)\]\s?(?P<msg>.*)$"
)
CODE_RE = re.compile(r"(?:^|\s)code=(\S+)")
EXCEPTION_HEADER_RE = re.compile(r"^(?P<cls>(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*)(?::\s.*)?$")
CAUSED_BY_PREFIX = "Caused by: "


@dataclass
class Entry:
    ts: str
    level: str
    service: str
    message: str
    code: str | None = None
    trace: list[str] = field(default_factory=list)

    @property
    def is_error(self):
        return self.level in ERROR_LEVELS


def normalize_level(raw):
    return raw.strip().upper()


def parse_text(line):
    m = TEXT_RE.match(line)
    if not m:
        return None
    msg = m.group("msg")
    code = CODE_RE.search(msg)
    return Entry(
        ts=m.group("ts"),
        level=normalize_level(m.group("level")),
        service=m.group("service"),
        message=msg,
        code=code.group(1) if code else None,
    )


def parse_kv(line):
    if not line.startswith("ts="):
        return None
    fields = {}
    for token in shlex.split(line):
        key, _, value = token.partition("=")
        fields[key] = value
    return Entry(
        ts=fields.get("ts", ""),
        level=normalize_level(fields.get("level", "")),
        service=fields.get("service", ""),
        message=fields.get("msg", ""),
        code=fields.get("code") or None,
    )


def parse_json(line):
    if not line.startswith("{"):
        return None
    try:
        obj = json.loads(line)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    return Entry(
        ts=str(obj.get("ts", "")),
        level=normalize_level(str(obj.get("level", ""))),
        service=str(obj.get("service", "")),
        message=str(obj.get("msg", "")),
        code=_json_code(obj),
    )


def _json_code(obj):
    code = obj.get("code")
    if not code and isinstance(obj.get("error"), dict):
        code = obj["error"].get("code")
    return str(code) if code else None


def parse_entry(line):
    """Parse a line that starts a new log entry, or return None."""
    for parser in (parse_text, parse_kv, parse_json):
        entry = parser(line)
        if entry is not None:
            return entry
    return None


def is_continuation(line):
    """True for stack-trace lines that belong to the preceding entry."""
    return (
        line.startswith("\tat ")
        or line.startswith(CAUSED_BY_PREFIX)
        or EXCEPTION_HEADER_RE.match(line) is not None
    )


def exception_class(trace):
    """The exception class reported for a stack trace, or None."""
    for line in trace:
        m = EXCEPTION_HEADER_RE.match(line)
        if m:
            return m.group("cls")
    return None
