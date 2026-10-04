import unittest

from inkwell.content.markup import render, render_inline
from inkwell.text.html import Markup


class InlineTests(unittest.TestCase):
    def test_emphasis_and_code(self):
        self.assertEqual(render_inline("a **b** *c* `d*e*`"), "a <strong>b</strong> <em>c</em> <code>d*e*</code>")

    def test_links_and_escaping(self):
        self.assertEqual(render_inline("[x & y](/a?b=1)"), '<a href="/a?b=1">x &amp; y</a>')
        self.assertEqual(render_inline("1 < 2"), "1 &lt; 2")


class BlockTests(unittest.TestCase):
    def test_returns_markup(self):
        self.assertIsInstance(render("hi"), Markup)

    def test_paragraphs_and_headings(self):
        self.assertEqual(render("# Title\n\nOne\ntwo\n\nThree"), "<h1>Title</h1>\n<p>One two</p>\n<p>Three</p>")

    def test_lists(self):
        self.assertEqual(render("- a\n- b\n\n1. c\n2. d"), "<ul><li>a</li><li>b</li></ul>\n<ol><li>c</li><li>d</li></ol>")

    def test_quote(self):
        self.assertEqual(render("> quoted\n> text"), "<blockquote><p>quoted text</p></blockquote>")

    def test_fenced_code(self):
        self.assertEqual(render("```\n<b>\n```"), "<pre><code>&lt;b&gt;</code></pre>")

    def test_raw_html_passes_through(self):
        self.assertEqual(render("intro\n\n<!--more-->\n\nrest"), "<p>intro</p>\n<!--more-->\n<p>rest</p>")


if __name__ == "__main__":
    unittest.main()
