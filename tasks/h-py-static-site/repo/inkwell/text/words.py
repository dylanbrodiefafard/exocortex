"""Word-level text helpers."""

import math
import re

_WHITESPACE = re.compile(r"\s+")
_TRAILING_PUNCT = ",;:-"


def collapse_whitespace(text):
    """Replace every run of whitespace with one space and trim the ends."""
    return _WHITESPACE.sub(" ", text).strip()


def split_words(text):
    """Split text into words on whitespace."""
    return text.split()


def word_count(text):
    return len(split_words(text))


def truncate_words(text, count, suffix=" ..."):
    """Keep the first ``count`` words of ``text``.

    Whitespace between the kept words is collapsed to single spaces. When
    words were dropped, trailing ``, ; : -`` is removed from the last kept
    word and ``suffix`` is appended. Text with ``count`` words or fewer is
    returned (collapsed) without the suffix.
    """
    words = split_words(text)
    if len(words) <= count:
        return " ".join(words)
    kept = words[:count]
    kept[-1] = kept[-1].rstrip(_TRAILING_PUNCT) or kept[-1]
    return " ".join(kept) + suffix


def truncate_chars(text, length, suffix="..."):
    """Shorten ``text`` to at most ``length`` characters including the suffix,
    cutting at a word boundary when one is available."""
    text = collapse_whitespace(text)
    if len(text) <= length:
        return text
    room = max(length - len(suffix), 0)
    cut = text[:room]
    if text[room] != " ":
        space = cut.rfind(" ")
        if space > 0:
            cut = cut[:space]
    return cut.rstrip(_TRAILING_PUNCT + " ") + suffix


def reading_time(text, words_per_minute=200):
    """Whole minutes needed to read ``text``, at least 1."""
    return max(1, math.ceil(word_count(text) / words_per_minute))
