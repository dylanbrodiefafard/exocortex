"""npm-style version ranges. See README.md for the supported syntax."""

from __future__ import annotations

from semver.version import Version


class InvalidRange(ValueError):
    """Raised when a string is not a valid range."""


class Range:
    """A parsed version range."""

    def __init__(self, text: str):
        self.text = text
        raise NotImplementedError("Range")

    def test(self, version: Version | str) -> bool:
        """Whether ``version`` satisfies this range."""
        raise NotImplementedError("Range.test")


def satisfies(version: Version | str, range_text: str) -> bool:
    """Whether ``version`` satisfies the range ``range_text``."""
    return Range(range_text).test(version)


def max_satisfying(versions, range_text: str) -> str | None:
    """The highest of ``versions`` (strings) that satisfies ``range_text``."""
    raise NotImplementedError("max_satisfying")
