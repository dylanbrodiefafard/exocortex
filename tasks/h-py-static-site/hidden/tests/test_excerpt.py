import io
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from inkwell.cli import main
from inkwell.config import load_config, parse_config
from inkwell.errors import ConfigError, TemplateError
from inkwell.filters import get_filter
from inkwell.site.builder import build_site
from inkwell.text.html import Markup
from tests.support import render

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "blog"
WORDS = " ".join(f"w{i}" for i in range(1, 61))


class ExcerptFilterTests(unittest.TestCase):
    def test_default_length_is_40_words(self):
        self.assertEqual(render("{{ x | excerpt }}", x=WORDS), " ".join(WORDS.split()[:40]) + " ...")

    def test_short_text_has_no_suffix(self):
        self.assertEqual(render("{{ x | excerpt }}", x="just a few words"), "just a few words")

    def test_explicit_length(self):
        self.assertEqual(render("{{ x | excerpt:3 }}", x=WORDS), "w1 w2 w3 ...")
        self.assertEqual(render("{{ x | excerpt:'2' }}", x=WORDS), "w1 w2 ...")
        self.assertEqual(render("{{ x | excerpt:n }}", x=WORDS, n=4), "w1 w2 w3 w4 ...")

    def test_length_from_config(self):
        out = render("{{ x | excerpt }}", config_text="[build]\nexcerpt_words = 5\n", x=WORDS)
        self.assertEqual(out, "w1 w2 w3 w4 w5 ...")
        out = render("{{ x | excerpt:2 }}", config_text="[build]\nexcerpt_words = 5\n", x=WORDS)
        self.assertEqual(out, "w1 w2 ...")

    def test_html_removed_like_striptags(self):
        html = Markup("<h1>Fish</h1><p>and <b>chips</b> &amp; peas</p><script>var a = 1;</script><p>tonight at nine</p>")
        self.assertEqual(render("{{ x | excerpt:6 }}", x=html), "Fish and chips &amp; peas tonight ...")
        self.assertEqual(render("{{ x | excerpt }}", x=Markup("<ul><li>one</li><li>two</li></ul>")), "one two")

    def test_cut_like_truncatewords(self):
        self.assertEqual(render("{{ x | excerpt:2 }}", x=Markup("<p>Hello,   world,\nagain</p>")), "Hello, world ...")

    def test_output_is_plain_text(self):
        self.assertEqual(render("{{ x | excerpt }}", x="<p>1 &lt; 2</p>"), "1 &lt; 2")
        self.assertEqual(render("[{{ x | excerpt }}]", x=None), "[]")

    def test_more_marker(self):
        html = Markup("<p>Intro <em>text</em> here.</p>\n<!--more-->\n<p>Rest of the post.</p><!--more--><p>x</p>")
        self.assertEqual(render("{{ x | excerpt }}", x=html), "Intro text here.")
        self.assertEqual(render("{{ x | excerpt:1 }}", x=html), "Intro text here.")
        long_intro = Markup(f"<p>{WORDS}</p><!--more--><p>tail</p>")
        self.assertEqual(render("{{ x | excerpt:3 }}", x=long_intro), WORDS)

    def test_marker_must_be_exact(self):
        html = Markup("<p>a b c</p><!-- more --><p>d e f</p>")
        self.assertEqual(render("{{ x | excerpt:4 }}", x=html), "a b c d ...")


class ExcerptErrorTests(unittest.TestCase):
    def assertTemplateError(self, source, message):
        with self.assertRaises(TemplateError) as ctx:
            render(source, x="a b c")
        self.assertEqual(str(ctx.exception), message)

    def test_bad_arguments(self):
        self.assertTemplateError("\n{{ x | excerpt:0 }}", "page.html:2: filter 'excerpt': expected an integer >= 1, got '0'")
        self.assertTemplateError("{{ x | excerpt:'ten' }}", "page.html:1: filter 'excerpt': expected an integer, got 'ten'")
        self.assertTemplateError("{{ x | excerpt:-3 }}", "page.html:1: filter 'excerpt': expected an integer >= 1, got '-3'")

    def test_arity(self):
        self.assertTemplateError("{{ x | excerpt:1,2 }}", "page.html:1: filter 'excerpt': expected 0 to 1 arguments, got 2")


class ExcerptConfigTests(unittest.TestCase):
    def test_setting_is_validated(self):
        for raw in ("0", "-2", "lots"):
            with self.subTest(raw=raw):
                with self.assertRaises(ConfigError) as ctx:
                    parse_config(f"[build]\nexcerpt_words = {raw}\n")
                self.assertEqual(
                    str(ctx.exception),
                    f"site.ini: [build] excerpt_words: must be a positive integer, got '{raw}'",
                )

    def test_documented_with_default(self):
        text = (EXAMPLE.parent.parent / "docs" / "configuration.md").read_text()
        self.assertIn("| `build.excerpt_words` | `40` |", text)
        filters_doc = (EXAMPLE.parent.parent / "docs" / "filters.md").read_text()
        self.assertRegex(filters_doc, r"(?m)^### `excerpt`$")


class ExcerptRegistrationTests(unittest.TestCase):
    def test_registered(self):
        spec = get_filter("excerpt")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.summary, "First N words of the text, without HTML.")

    def test_listed_by_cli(self):
        out = io.StringIO()
        self.assertEqual(main(["filters"], out, io.StringIO()), 0)
        self.assertRegex(out.getvalue(), r"(?m)^excerpt\s+First N words of the text, without HTML\.$")


class ExampleBlogTests(unittest.TestCase):
    def test_index_uses_excerpts(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp) / "blog"
            shutil.copytree(EXAMPLE, site)
            config = load_config(site / "site.ini")
            build_site(config)
            html = (Path(config.output_dir) / "page" / "2" / "index.html").read_text()
        self.assertIn(
            "This is the first post on Field Notes. It exists mostly to check that the generator works.",
            html,
        )
        self.assertNotIn("Everything after the marker", html)
        self.assertIsNone(re.search(r"generator works\. \.\.\.", html))


if __name__ == "__main__":
    unittest.main()
