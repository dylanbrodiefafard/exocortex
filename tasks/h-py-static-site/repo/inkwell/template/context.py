"""Variable scopes used while rendering."""

from contextlib import contextmanager


class Scope:
    """A stack of variable dictionaries; inner names shadow outer ones."""

    def __init__(self, variables=None):
        self._frames = [dict(variables or {})]

    @contextmanager
    def push(self, variables):
        self._frames.append(variables)
        try:
            yield self
        finally:
            self._frames.pop()

    def get(self, name, default=None):
        for frame in reversed(self._frames):
            if name in frame:
                return frame[name]
        return default

    def lookup(self, path):
        """Resolve a dotted path. Each step tries a mapping key, then an
        attribute, then an integer index. Missing names resolve to None."""
        head, *rest = path.split(".")
        value = self.get(head)
        for part in rest:
            if value is None:
                return None
            value = _step(value, part)
        return value


def _step(value, part):
    if isinstance(value, dict):
        return value.get(part)
    if hasattr(value, part) and not part.startswith("_"):
        return getattr(value, part)
    if part.isdigit() and isinstance(value, (list, tuple)):
        index = int(part)
        return value[index] if index < len(value) else None
    try:
        return value[part]
    except (KeyError, TypeError, IndexError):
        return None
