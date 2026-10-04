"""Resolve a request method + path to a route and its parameters."""

from dataclasses import dataclass

from wisp.exceptions import MethodNotAllowed, NotFound
from wisp.routing.route import Route
from wisp.utils.encoding import unquote


@dataclass(frozen=True)
class Match:
    route: Route
    params: dict


class Router:
    """Holds routes and picks the most specific one for a request.

    See ``docs/routing.md`` for the matching rules.
    """

    def __init__(self) -> None:
        self._routes: list[Route] = []

    @property
    def routes(self) -> list[Route]:
        return list(self._routes)

    def add(self, pattern: str, handler, methods=("GET",), name: str | None = None) -> Route:
        route = Route(pattern, handler, frozenset(methods), name)
        if route.name and any(r.name == route.name for r in self._routes):
            raise ValueError(f"duplicate route name {route.name!r}")
        self._routes.append(route)
        # Stable sort: routes with equal specificity keep registration order.
        self._routes.sort(key=lambda r: r.sort_key)
        return route

    def url_for(self, name: str, **params) -> str:
        for route in self._routes:
            if route.name == name:
                return route.build(**params)
        raise KeyError(f"no route named {name!r}")

    def match(self, method: str, path: str) -> Match:
        """Return the best match or raise ``NotFound`` / ``MethodNotAllowed``."""
        parts = _split(unquote(path))
        allowed: set[str] = set()
        for route in self._routes:
            raw = route.match_segments(parts)
            if raw is None:
                continue
            params = _convert(route, raw)
            if params is None:
                continue
            if method.upper() in route.methods:
                return Match(route, params)
            allowed |= route.methods
        if allowed:
            raise MethodNotAllowed(sorted(allowed))
        raise NotFound(path)


def _split(path: str) -> list[str]:
    if path in ("", "/"):
        return []
    return path[1:].split("/") if path.startswith("/") else path.split("/")


def _convert(route: Route, raw: dict[str, str]) -> dict | None:
    params = {}
    for seg in route.segments:
        if seg.is_static:
            continue
        value = raw[seg.name]
        if not seg.converter.accepts(value):
            return None
        params[seg.name] = seg.converter.to_python(value)
    return params
