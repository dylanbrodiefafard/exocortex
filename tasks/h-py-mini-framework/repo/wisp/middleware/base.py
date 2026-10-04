"""Middleware protocol and composition."""

from collections.abc import Callable

Handler = Callable[[object], object]


class Middleware:
    """Base class. Subclasses override :meth:`__call__`."""

    def __call__(self, request, call_next: Handler):
        return call_next(request)


def compose(middlewares: list, endpoint: Handler) -> Handler:
    """Build a single callable; the first middleware in the list runs outermost."""
    handler = endpoint
    for mw in reversed(middlewares):
        handler = _bind(mw, handler)
    return handler


def _bind(mw, call_next: Handler) -> Handler:
    def run(request):
        return mw(request, call_next)

    return run
