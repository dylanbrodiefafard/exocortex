"""Text helpers for product pages and URLs."""

import re
import unicodedata
import warnings

from storefront._log import get_logger

log = get_logger(__name__)

_NON_SLUG = re.compile(r"[^a-z0-9]+")


def slugify(text, max_length=60):
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    slug = _NON_SLUG.sub("-", ascii_text.lower()).strip("-")
    if len(slug) > max_length:
        log.debug("slug for %r truncated from %d chars", text, len(slug))
        slug = slug[:max_length].rstrip("-")
    return slug


def truncate(text, width, ellipsis="…"):
    if width < len(ellipsis):
        raise ValueError("width too small")
    if len(text) <= width:
        return text
    cut = text[: width - len(ellipsis)]
    if " " in cut:
        cut = cut[: cut.rindex(" ")]
    return cut.rstrip() + ellipsis


def title_case(text):
    small = {"a", "an", "and", "of", "the", "for", "in", "on", "with"}
    words = text.split()
    out = []
    for i, word in enumerate(words):
        lower = word.lower()
        if 0 < i < len(words) - 1 and lower in small:
            out.append(lower)
        else:
            out.append(lower[:1].upper() + lower[1:])
    return " ".join(out)


def make_slug(text):
    warnings.warn(f"make_slug({text!r}) is deprecated; use slugify()", DeprecationWarning, stacklevel=2)
    return slugify(text)


def pluralize(count, singular, plural=None):
    word = singular if count == 1 else (plural or singular + "s")
    return f"{count} {word}"
