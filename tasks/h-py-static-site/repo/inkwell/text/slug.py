"""URL slugs."""

import re
import unicodedata

_NON_WORD = re.compile(r"[^a-z0-9]+")


def slugify(text, max_length=60):
    """ASCII, lowercase, hyphen-separated slug. Accents are folded
    (``Café`` becomes ``cafe``); everything else that is not a letter or a
    digit separates words."""
    folded = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii")
    slug = _NON_WORD.sub("-", folded.lower()).strip("-")
    if len(slug) > max_length:
        slug = slug[:max_length].rsplit("-", 1)[0] if "-" in slug[:max_length] else slug[:max_length]
    return slug
