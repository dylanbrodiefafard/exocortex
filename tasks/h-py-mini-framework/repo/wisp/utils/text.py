"""Text helpers used by templates and the example apps."""

import re
import unicodedata

_NON_SLUG = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    """``"Le Café, Vol. 2"`` -> ``"le-cafe-vol-2"``."""
    normalized = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return _NON_SLUG.sub("-", normalized.lower()).strip("-")


def truncate(text: str, length: int, suffix: str = "...") -> str:
    """Shorten ``text`` to at most ``length`` characters, ending in ``suffix`` when cut."""
    if len(text) <= length:
        return text
    if length <= len(suffix):
        return suffix[:length]
    return text[: length - len(suffix)].rstrip() + suffix
