"""Offset pagination for listing endpoints."""

from dataclasses import dataclass

from storefront._log import get_logger

log = get_logger(__name__)

MAX_PAGE_SIZE = 100


@dataclass(frozen=True)
class Page:
    items: list
    number: int
    size: int
    total: int

    @property
    def pages(self):
        return max(1, -(-self.total // self.size))

    @property
    def has_next(self):
        return self.number < self.pages

    @property
    def has_prev(self):
        return self.number > 1


def paginate(items, number=1, size=20):
    if size <= 0:
        raise ValueError("size must be positive")
    if size > MAX_PAGE_SIZE:
        log.warning("page size %d clamped to %d", size, MAX_PAGE_SIZE)
        size = MAX_PAGE_SIZE
    if number < 1:
        raise ValueError("page number starts at 1")
    start = (number - 1) * size
    chunk = list(items[start:start + size])
    log.debug("page %d/%d size %d -> %d items", number, max(1, -(-len(items) // size)), size, len(chunk))
    return Page(chunk, number, size, len(items))
