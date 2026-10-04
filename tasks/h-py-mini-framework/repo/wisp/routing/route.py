"""A single route: a URL pattern bound to a handler and a set of methods."""

import re
from dataclasses import dataclass, field

from wisp.routing.converters import CONVERTERS, Converter

_PARAM = re.compile(r"^<(?:(?P<conv>[a-z_]+):)?(?P<name>[A-Za-z_][A-Za-z0-9_]*)>$")


class RoutePatternError(ValueError):
    pass


@dataclass(frozen=True)
class Segment:
    """One ``/``-separated piece of a pattern: static text or a parameter."""

    text: str | None = None
    name: str | None = None
    converter: Converter | None = None

    @property
    def is_static(self) -> bool:
        return self.converter is None

    @property
    def priority(self) -> int:
        return 0 if self.is_static else self.converter.priority


@dataclass
class Route:
    pattern: str
    handler: object
    methods: frozenset[str] = frozenset({"GET"})
    name: str | None = None
    segments: list[Segment] = field(init=False)

    def __post_init__(self) -> None:
        self.methods = frozenset(m.upper() for m in self.methods)
        if "GET" in self.methods:
            self.methods = self.methods | {"HEAD"}
        self.segments = parse_pattern(self.pattern)
        if self.name is None:
            self.name = getattr(self.handler, "__name__", None)

    @property
    def sort_key(self) -> tuple[int, ...]:
        """Lexicographic specificity: earlier, more specific segments win."""
        return tuple(seg.priority for seg in self.segments)

    def match_segments(self, parts: list[str]) -> dict[str, str] | None:
        """Match already-split request path ``parts``; return raw captured values."""
        captured: dict[str, str] = {}
        for index, seg in enumerate(self.segments):
            if seg.converter is not None and seg.converter.multi_segment:
                rest = parts[index:]
                if not rest:
                    return None
                captured[seg.name] = "/".join(rest)
                return captured
            if index >= len(parts):
                return None
            part = parts[index]
            if seg.is_static:
                if part != seg.text:
                    return None
            else:
                captured[seg.name] = part
        if len(parts) != len(self.segments):
            return None
        return captured

    def build(self, **params) -> str:
        """Reverse the pattern: ``Route("/books/<int:id>").build(id=3) == "/books/3"``."""
        from wisp.utils.encoding import quote

        pieces = []
        for seg in self.segments:
            if seg.is_static:
                pieces.append(seg.text)
                continue
            if seg.name not in params:
                raise KeyError(f"missing parameter {seg.name!r} for route {self.pattern!r}")
            raw = seg.converter.to_url(params[seg.name])
            pieces.append(quote(raw, safe="/" if seg.converter.multi_segment else ""))
        return "/" + "/".join(pieces)


def parse_pattern(pattern: str) -> list[Segment]:
    if not pattern.startswith("/"):
        raise RoutePatternError(f"pattern must start with '/': {pattern!r}")
    if pattern == "/":
        return []
    segments = []
    seen = set()
    raw_parts = pattern[1:].rstrip("/").split("/")
    for i, raw in enumerate(raw_parts):
        if not raw:
            raise RoutePatternError(f"empty segment in pattern {pattern!r}")
        if "<" not in raw:
            segments.append(Segment(text=raw))
            continue
        m = _PARAM.match(raw)
        if not m:
            raise RoutePatternError(f"bad parameter syntax {raw!r} in {pattern!r}")
        conv_name = m.group("conv") or "str"
        if conv_name not in CONVERTERS:
            raise RoutePatternError(f"unknown converter {conv_name!r} in {pattern!r}")
        name = m.group("name")
        if name in seen:
            raise RoutePatternError(f"duplicate parameter {name!r} in {pattern!r}")
        seen.add(name)
        converter = CONVERTERS[conv_name]
        if converter.multi_segment and i != len(raw_parts) - 1:
            raise RoutePatternError(f"<{conv_name}:...> must be the last segment in {pattern!r}")
        segments.append(Segment(name=name, converter=converter))
    return segments
