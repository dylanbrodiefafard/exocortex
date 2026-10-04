"""Date filters."""

import datetime

from inkwell.filters.args import fail, str_arg
from inkwell.filters.registry import register_filter


def _as_date(name, value):
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value
    if isinstance(value, str):
        try:
            return datetime.date.fromisoformat(value)
        except ValueError:
            pass
    fail(name, f"expected a date, got '{value}'")


@register_filter("date", args=(0, 1), needs_context=True)
def date(ctx, value, fmt=None):
    """Format a date (default format: [build] date_format)."""
    if value is None:
        return ""
    fmt = ctx.config.date_format if fmt is None else str_arg("date", fmt)
    return _as_date("date", value).strftime(fmt)


@register_filter("isodate")
def isodate(value):
    """A date as YYYY-MM-DD."""
    if value is None:
        return ""
    return _as_date("isodate", value).isoformat()[:10]


@register_filter("year")
def year(value):
    """The year of a date."""
    if value is None:
        return ""
    return _as_date("year", value).year
