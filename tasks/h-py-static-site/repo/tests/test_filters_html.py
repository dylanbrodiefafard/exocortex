import unittest

from inkwell.text.html import Markup
from tests.support import render


class HtmlFilterTests(unittest.TestCase):
    def test_safe_and_escape(self):
        self.assertEqual(render("{{ x | safe }}", x="<b>"), "<b>")
        self.assertEqual(render("{{ x | escape }}", x=Markup("<b>")), "&lt;b&gt;")

    def test_striptags(self):
        html = Markup("<p>Fish &amp; chips</p><script>alert(1)</script><p>tonight</p>")
        self.assertEqual(render("{{ x | striptags }}", x=html), "Fish &amp; chips tonight")

    def test_striptags_then_truncate(self):
        html = Markup("<h1>Title</h1><p>one two three four</p>")
        self.assertEqual(render("{{ x | striptags | truncatewords:3 }}", x=html), "Title one two ...")

    def test_absurl_uses_base_url(self):
        out = render("{{ x | absurl }}", config_text="[site]\nbase_url = https://e.org/blog/\n", x="/posts/a/")
        self.assertEqual(out, "https://e.org/blog/posts/a/")

    def test_link(self):
        self.assertEqual(render("{{ u | link:t }}", u="/a?b&c", t="<A>"), '<a href="/a?b&amp;c">&lt;A&gt;</a>')


if __name__ == "__main__":
    unittest.main()
