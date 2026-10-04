"""Filters for lists."""

from inkwell.filters.args import int_arg, str_arg
from inkwell.filters.registry import register_filter
from inkwell.template.context import _step


def _items(value):
    if value is None:
        return []
    if isinstance(value, (str, bytes)):
        return [value]
    return list(value)


@register_filter("join", args=(0, 1))
def join(value, separator=", "):
    """Join the items with a separator (default ", ")."""
    return str_arg("join", separator).join(str(item) for item in _items(value))


@register_filter("length")
def length(value):
    """Number of items, or of characters in a string."""
    if value is None:
        return 0
    return len(value)


@register_filter("first")
def first(value):
    """The first item."""
    items = _items(value)
    return items[0] if items else None


@register_filter("last")
def last(value):
    """The last item."""
    items = _items(value)
    return items[-1] if items else None


@register_filter("reverse")
def reverse(value):
    """The items in reverse order."""
    return list(reversed(_items(value)))


@register_filter("limit", args=(1, 1))
def limit(value, count):
    """The first N items."""
    return _items(value)[: int_arg("limit", count, minimum=0)]


@register_filter("sort", args=(0, 1))
def sort(value, attribute=None):
    """Sort the items, optionally by an attribute."""
    items = _items(value)
    if attribute is None:
        return sorted(items)
    attribute = str_arg("sort", attribute)
    return sorted(items, key=lambda item: (_step(item, attribute) is None, _step(item, attribute)))


@register_filter("where", args=(2, 2))
def where(value, attribute, expected):
    """Items whose attribute equals the second argument."""
    attribute = str_arg("where", attribute)
    return [item for item in _items(value) if _match(_step(item, attribute), expected)]


def _match(actual, expected):
    if isinstance(actual, (list, tuple)):
        return expected in actual
    return actual == expected
