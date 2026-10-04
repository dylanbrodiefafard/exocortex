import tempfile
import unittest
from pathlib import Path

from inkwell.config import DEFAULTS, default_config, load_config, parse_config
from inkwell.errors import ConfigError


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        cfg = default_config()
        self.assertEqual(cfg.title, "Untitled")
        self.assertEqual(cfg.base_url, "/")
        self.assertEqual(cfg.posts_per_page, 10)
        self.assertEqual(cfg.feed_items, 20)
        self.assertFalse(cfg.drafts)
        self.assertEqual(cfg.date_format, "%B %d, %Y")

    def test_every_default_parses(self):
        lines = []
        for section, keys in DEFAULTS.items():
            lines.append(f"[{section}]")
            lines.extend(f"{key} = {value}" for key, value in keys.items())
        self.assertEqual(parse_config("\n".join(lines)), parse_config(""))

    def test_overrides(self):
        cfg = parse_config("[site]\ntitle = Notes\nbase_url = https://x.org/\n[build]\nposts_per_page = 3\ndrafts = yes\n")
        self.assertEqual(cfg.title, "Notes")
        self.assertEqual(cfg.base_url, "https://x.org/")
        self.assertEqual(cfg.posts_per_page, 3)
        self.assertTrue(cfg.drafts)

    def assertConfigError(self, text, message):
        with self.assertRaises(ConfigError) as ctx:
            parse_config(text)
        self.assertEqual(str(ctx.exception), message)

    def test_positive_ints(self):
        self.assertConfigError(
            "[build]\nposts_per_page = 0\n",
            "site.ini: [build] posts_per_page: must be a positive integer, got '0'",
        )
        self.assertConfigError(
            "[build]\nfeed_items = many\n",
            "site.ini: [build] feed_items: must be a positive integer, got 'many'",
        )

    def test_unknown_section_and_key(self):
        self.assertConfigError("[theme]\nname = x\n", "site.ini: [theme]: unknown section")
        self.assertConfigError("[build]\ncolour = red\n", "site.ini: [build] colour: unknown key")

    def test_boolean(self):
        self.assertConfigError("[build]\ndrafts = maybe\n", "site.ini: [build] drafts: must be yes or no, got 'maybe'")

    def test_base_url(self):
        self.assertConfigError(
            "[site]\nbase_url = https://x.org\n",
            "site.ini: [site] base_url: must end with /, got 'https://x.org'",
        )
        self.assertConfigError(
            "[site]\nbase_url = x.org/\n",
            "site.ini: [site] base_url: must start with /, http:// or https://, got 'x.org/'",
        )

    def test_required_text(self):
        self.assertConfigError("[site]\ntitle =\n", "site.ini: [site] title: must not be empty")

    def test_syntax_error(self):
        with self.assertRaises(ConfigError) as ctx:
            parse_config("title = x\n")
        self.assertTrue(str(ctx.exception).startswith("site.ini: cannot parse:"))

    def test_load_resolves_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mysite.ini"
            path.write_text("[build]\noutput_dir = out\n")
            cfg = load_config(path)
            self.assertEqual(cfg.output_dir, Path(tmp) / "out")
            self.assertEqual(cfg.content_dir, Path(tmp) / "content")
            self.assertEqual(cfg.source, "mysite.ini")

    def test_with_drafts(self):
        self.assertTrue(default_config().with_drafts(True).drafts)


if __name__ == "__main__":
    unittest.main()
