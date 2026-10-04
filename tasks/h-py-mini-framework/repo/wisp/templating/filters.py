"""Filters available inside ``{{ ... }}``."""

import html

from wisp.utils.text import slugify, truncate


class Markup(str):
    """A string that is already safe HTML and must not be escaped again."""


def escape(value) -> Markup:
    if isinstance(value, Markup):
        return value
    return Markup(html.escape(str(value), quote=True))


def _truncate(value, length="40"):
    return truncate(str(value), int(length))


def _default(value, fallback=""):
    return fallback if value in (None, "") else value


def _join(value, sep=", "):
    return sep.join(str(v) for v in value)


FILTERS = {
    "upper": lambda v: str(v).upper(),
    "lower": lambda v: str(v).lower(),
    "title": lambda v: str(v).title(),
    "length": lambda v: len(v),
    "slugify": lambda v: slugify(str(v)),
    "truncate": _truncate,
    "default": _default,
    "join": _join,
    "safe": lambda v: Markup(str(v)),
}
