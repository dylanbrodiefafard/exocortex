# semver

A small, dependency-free library for semantic versions (SemVer 2.0.0) and
npm-style version ranges.

```python
from semver import Version, Range, satisfies, max_satisfying

Version.parse("1.2.3-beta.1+build.5")
satisfies("1.4.0", "^1.2.0")                         # True
max_satisfying(["1.2.0", "1.3.1", "2.0.0"], "~1.3")  # "1.3.1"
```

Tests: `python3 -m unittest discover -s tests -t .`
