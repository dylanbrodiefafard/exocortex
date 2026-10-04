"""An ordered multi-valued mapping."""

from collections.abc import Iterable, Iterator


class MultiDict:
    """Mapping where each key may hold several values, in insertion order.

    ``md[key]`` and ``md.get(key)`` return the most recently added value,
    which is what callers want for headers such as ``Content-Type`` where a
    later value overrides an earlier one. Use :meth:`getall` for every value.
    Keys are compared with :meth:`_normalize`, which subclasses may override
    (``Headers`` makes keys case-insensitive).
    """

    def __init__(self, items: Iterable[tuple[str, str]] = ()):
        self._items: list[tuple[str, str]] = []
        for key, value in items:
            self.add(key, value)

    def _normalize(self, key: str) -> str:
        return key

    def add(self, key: str, value: str) -> None:
        self._items.append((key, value))

    def set(self, key: str, value: str) -> None:
        """Replace every value of ``key`` with a single ``value``."""
        self.remove(key)
        self.add(key, value)

    def remove(self, key: str) -> None:
        norm = self._normalize(key)
        self._items = [(k, v) for k, v in self._items if self._normalize(k) != norm]

    def getall(self, key: str) -> list[str]:
        norm = self._normalize(key)
        return [v for k, v in self._items if self._normalize(k) == norm]

    def get(self, key: str, default: str | None = None) -> str | None:
        values = self.getall(key)
        return values[-1] if values else default

    def __getitem__(self, key: str) -> str:
        values = self.getall(key)
        if not values:
            raise KeyError(key)
        return values[-1]

    def __setitem__(self, key: str, value: str) -> None:
        self.set(key, value)

    def __contains__(self, key: object) -> bool:
        return isinstance(key, str) and bool(self.getall(key))

    def __iter__(self) -> Iterator[str]:
        seen = set()
        for key, _ in self._items:
            norm = self._normalize(key)
            if norm not in seen:
                seen.add(norm)
                yield key

    def __len__(self) -> int:
        return sum(1 for _ in self)

    def items(self) -> list[tuple[str, str]]:
        """Every (key, value) pair, including repeated keys, in insertion order."""
        return list(self._items)

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self._items!r})"
