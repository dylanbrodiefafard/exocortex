"""String filters."""

from inkwell.filters.args import int_arg, str_arg
from inkwell.filters.registry import register_filter
from inkwell.text.slug import slugify as _slugify
from inkwell.text.words import reading_time, truncate_chars, truncate_words, word_count


def _text(value):
    return "" if value is None else str(value)


@register_filter("upper")
def upper(value):
    """Uppercase the text."""
    return _text(value).upper()


@register_filter("lower")
def lower(value):
    """Lowercase the text."""
    return _text(value).lower()


@register_filter("title")
def title(value):
    """Capitalize each word."""
    return " ".join(word[:1].upper() + word[1:] for word in _text(value).split(" "))


@register_filter("trim")
def trim(value):
    """Remove leading and trailing whitespace."""
    return _text(value).strip()


@register_filter("default", args=(1, 1))
def default(value, fallback):
    """The argument when the value is missing or empty."""
    return fallback if value in (None, "", [], {}) else value


@register_filter("replace", args=(2, 2))
def replace(value, old, new):
    """Replace every occurrence of the first argument with the second."""
    return _text(value).replace(str_arg("replace", old), str_arg("replace", new))


@register_filter("truncate", args=(1, 1))
def truncate(value, length):
    """At most N characters, cut at a word boundary."""
    return truncate_chars(_text(value), int_arg("truncate", length, minimum=4))


@register_filter("truncatewords", args=(1, 1))
def truncatewords(value, count):
    """The first N words."""
    return truncate_words(_text(value), int_arg("truncatewords", count, minimum=1))


@register_filter("wordcount")
def wordcount(value):
    """Number of words."""
    return word_count(_text(value))


@register_filter("readingtime", args=(0, 1))
def readingtime(value, words_per_minute=200):
    """Minutes needed to read the text."""
    return reading_time(_text(value), int_arg("readingtime", words_per_minute, minimum=1))


@register_filter("slugify")
def slugify(value):
    """URL slug of the text."""
    return _slugify(_text(value))
