"""Percent-encoding helpers.

wisp keeps its own tiny implementation so behaviour is identical across
Python versions and so the form parser and router agree on the details.
"""

_HEX = "0123456789abcdefABCDEF"
_SAFE = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")


def _is_escape(value: str, i: int) -> bool:
    return value[i] == "%" and i + 2 < len(value) and value[i + 1] in _HEX and value[i + 2] in _HEX


def unquote(value: str, plus_as_space: bool = True) -> str:
    """Decode ``%XX`` escapes in ``value`` (UTF-8).

    Malformed escapes such as ``%zz`` or a lone trailing ``%`` are kept
    literally. With ``plus_as_space`` (the default, matching
    ``application/x-www-form-urlencoded``), ``+`` decodes to a space.
    """
    out = []
    i = 0
    while i < len(value):
        ch = value[i]
        if _is_escape(value, i):
            out.append(chr(int(value[i + 1 : i + 3], 16)))
            i += 3
            continue
        if ch == "+" and plus_as_space:
            out.append(" ")
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def quote(value: str, safe: str = "") -> str:
    """Percent-encode ``value`` as UTF-8, leaving unreserved characters and ``safe`` alone."""
    allowed = _SAFE | frozenset(safe)
    out = []
    for ch in value:
        if ch in allowed:
            out.append(ch)
        else:
            out.extend(f"%{byte:02X}" for byte in ch.encode("utf-8"))
    return "".join(out)
