"""The docs must describe everything users can configure or call."""

import re
import unittest
from pathlib import Path

from inkwell.config import DEFAULTS
from inkwell.filters import all_filters

DOCS = Path(__file__).resolve().parent.parent / "docs"


class DocsTests(unittest.TestCase):
    def test_every_filter_is_documented(self):
        text = (DOCS / "filters.md").read_text()
        documented = set(re.findall(r"^### `([A-Za-z0-9_]+)`$", text, re.M))
        missing = sorted(spec.name for spec in all_filters() if spec.name not in documented)
        self.assertEqual(missing, [], "filters missing from docs/filters.md")

    def test_every_config_key_is_documented(self):
        text = (DOCS / "configuration.md").read_text()
        missing = [
            f"{section}.{key}"
            for section, keys in DEFAULTS.items()
            for key in keys
            if f"| `{section}.{key}` | `{keys[key]}` |" not in text and f"| `{section}.{key}` | (empty) |" not in text
        ]
        self.assertEqual(missing, [], "keys missing from docs/configuration.md (with their default)")


if __name__ == "__main__":
    unittest.main()
