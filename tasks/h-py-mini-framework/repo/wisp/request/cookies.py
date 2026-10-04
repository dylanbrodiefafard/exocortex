"""Parsing of the ``Cookie`` request header."""

from wisp.utils.encoding import unquote


def parse_cookie_header(header: str | None) -> dict[str, str]:
    """``"a=1; b=two%20words"`` -> ``{"a": "1", "b": "two words"}``.

    Later duplicates win. Pairs without ``=`` are ignored. Values may be
    double-quoted; quotes are stripped.
    """
    cookies: dict[str, str] = {}
    if not header:
        return cookies
    for chunk in header.split(";"):
        name, sep, value = chunk.strip().partition("=")
        if not sep or not name:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1]
        cookies[name.strip()] = unquote(value, plus_as_space=False)
    return cookies
