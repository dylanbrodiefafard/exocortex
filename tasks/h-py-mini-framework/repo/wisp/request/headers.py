"""Case-insensitive HTTP header collection."""

from wisp.utils.multidict import MultiDict


class Headers(MultiDict):
    """Header names compare case-insensitively but keep their original spelling."""

    def _normalize(self, key: str) -> str:
        return key.lower()

    @classmethod
    def coerce(cls, value) -> "Headers":
        if value is None:
            return cls()
        if isinstance(value, Headers):
            return value
        if isinstance(value, dict):
            return cls(value.items())
        return cls(value)

    def to_list(self) -> list[tuple[str, str]]:
        return self.items()
