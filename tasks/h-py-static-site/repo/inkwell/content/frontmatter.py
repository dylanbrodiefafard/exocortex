"""Front matter: a ``---`` delimited block of ``key: value`` lines at the top
of a content file.

Values are typed: ``true``/``false`` become booleans, ``YYYY-MM-DD`` becomes a
:class:`datetime.date`, ``[a, b]`` becomes a list of strings, integers become
ints and anything else is a string (surrounding quotes are removed).
"""

import datetime
import re

from inkwell.errors import ContentError

_DELIMITER = "---"
_KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_INT = re.compile(r"^-?\d+$")


def split_front_matter(text, source):
    """Return ``(metadata, body, body_line)`` where ``body_line`` is the
    1-based line the body starts on."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != _DELIMITER:
        return {}, text, 1
    for index in range(1, len(lines)):
        if lines[index].strip() == _DELIMITER:
            meta = parse_front_matter(lines[1:index], source, first_line=2)
            body = "\n".join(lines[index + 1:])
            return meta, body, index + 2
    raise ContentError(source, 1, "front matter is not closed with ---")


def parse_front_matter(lines, source, first_line=1):
    meta = {}
    for offset, line in enumerate(lines):
        number = first_line + offset
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = _KEY.match(line)
        if not match:
            raise ContentError(source, number, f"expected 'key: value', got {line.strip()!r}")
        key, raw = match.group(1).lower(), match.group(2).strip()
        if key in meta:
            raise ContentError(source, number, f"duplicate key {key!r}")
        meta[key] = _value(raw, source, number)
    return meta


def _value(raw, source, line):
    if raw in ("true", "false"):
        return raw == "true"
    if _DATE.match(raw):
        try:
            return datetime.date.fromisoformat(raw)
        except ValueError:
            raise ContentError(source, line, f"invalid date {raw!r}") from None
    if _INT.match(raw):
        return int(raw)
    if raw.startswith("["):
        if not raw.endswith("]"):
            raise ContentError(source, line, "list is not closed with ]")
        inner = raw[1:-1].strip()
        return [_unquote(item.strip()) for item in inner.split(",")] if inner else []
    return _unquote(raw)


def _unquote(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value
