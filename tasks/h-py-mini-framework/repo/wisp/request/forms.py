"""``application/x-www-form-urlencoded`` request bodies."""

from wisp.utils.encoding import unquote
from wisp.utils.multidict import MultiDict


def parse_urlencoded(body: bytes | str) -> MultiDict:
    if isinstance(body, bytes):
        body = body.decode("ascii", errors="replace")
    form = MultiDict()
    for pair in body.split("&"):
        if not pair:
            continue
        key, _, value = pair.partition("=")
        form.add(unquote(key), unquote(value))
    return form
