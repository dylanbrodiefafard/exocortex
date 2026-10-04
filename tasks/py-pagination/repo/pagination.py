"""Helpers for paginating in-memory lists."""


def paginate(items, page, per_page):
    """Return the items on 1-indexed `page`, with `per_page` items per page.

    Pages past the end return an empty list. `page` and `per_page` must be >= 1.
    """
    if page < 1 or per_page < 1:
        raise ValueError("page and per_page must be >= 1")
    start = page * per_page
    return items[start:start + per_page]


def page_count(total, per_page):
    """Number of pages needed to show `total` items, `per_page` at a time."""
    if per_page < 1:
        raise ValueError("per_page must be >= 1")
    return total // per_page
