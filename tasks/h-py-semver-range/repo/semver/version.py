"""Parsing and ordering of semantic versions."""

from __future__ import annotations

import re
from functools import total_ordering

_VERSION_RE = re.compile(
    r"^(\d+)\.(\d+)\.(\d+)"
    r"(?:-([0-9A-Za-z.-]+))?"
    r"(?:\+([0-9A-Za-z.-]+))?$"
)


class InvalidVersion(ValueError):
    """Raised when a string is not a valid semantic version."""


@total_ordering
class Version:
    """A parsed semantic version: MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]."""

    __slots__ = ("major", "minor", "patch", "prerelease", "build")

    def __init__(self, major, minor, patch, prerelease=(), build=()):
        self.major = major
        self.minor = minor
        self.patch = patch
        self.prerelease = tuple(prerelease)
        self.build = tuple(build)

    @classmethod
    def parse(cls, text: str) -> Version:
        m = _VERSION_RE.match(text.strip())
        if not m:
            raise InvalidVersion(f"invalid version: {text!r}")
        major, minor, patch, pre, build = m.groups()
        return cls(
            int(major),
            int(minor),
            int(patch),
            pre.split(".") if pre else (),
            build.split(".") if build else (),
        )

    def _key(self):
        return (self.major, self.minor, self.patch, self.prerelease, self.build)

    def __eq__(self, other):
        if not isinstance(other, Version):
            return NotImplemented
        return self._key() == other._key()

    def __lt__(self, other):
        if not isinstance(other, Version):
            return NotImplemented
        return self._key() < other._key()

    def __hash__(self):
        return hash(self._key())

    def __str__(self):
        s = f"{self.major}.{self.minor}.{self.patch}"
        if self.prerelease:
            s += "-" + ".".join(self.prerelease)
        if self.build:
            s += "+" + ".".join(self.build)
        return s

    def __repr__(self):
        return f"Version({str(self)!r})"
