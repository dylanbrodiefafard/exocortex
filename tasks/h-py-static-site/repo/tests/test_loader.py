import datetime
import tempfile
import unittest
from pathlib import Path

from inkwell.config import parse_config
from inkwell.content import load_pages
from inkwell.content.loader import parse_page
from inkwell.errors import ContentError


class ParsePageTests(unittest.TestCase):
    def test_post(self):
        page = parse_page("---\ntitle: Hi There\ndate: 2024-01-02\ntags: one\nmood: calm\n---\nHello *you*", "notes/Hi There.md")
        self.assertEqual(page.slug, "hi-there")
        self.assertEqual(page.url, "/posts/hi-there/")
        self.assertEqual(page.date, datetime.date(2024, 1, 2))
        self.assertEqual(page.tags, ["one"])
        self.assertEqual(page.template, "post.html")
        self.assertEqual(page.content, "<p>Hello <em>you</em></p>")
        self.assertEqual(page["mood"], "calm")

    def test_page(self):
        page = parse_page("---\ntitle: About\nslug: about-us\n---\n", "about.md")
        self.assertEqual(page.url, "/about-us/")
        self.assertEqual(page.template, "page.html")
        self.assertFalse(page.is_post)

    def test_errors(self):
        with self.assertRaises(ContentError) as ctx:
            parse_page("no front matter", "x.md")
        self.assertEqual(str(ctx.exception), "x.md:1: front matter must set a title")
        with self.assertRaises(ContentError):
            parse_page("---\ntitle: x\ndate: soon\n---\n", "x.md")


class LoadPagesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "content").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        (self.root / "content" / name).write_text(text)

    def config(self, extra=""):
        return parse_config(extra, root=self.root)

    def test_order_and_drafts(self):
        self.write("a.md", "---\ntitle: A\ndate: 2024-01-01\n---\n")
        self.write("b.md", "---\ntitle: B\ndate: 2024-02-01\n---\n")
        self.write("z.md", "---\ntitle: Zed\n---\n")
        self.write("d.md", "---\ntitle: D\ndate: 2024-03-01\ndraft: true\n---\n")
        self.assertEqual([p.title for p in load_pages(self.config())], ["B", "A", "Zed"])
        drafts = self.config("[build]\ndrafts = yes\n")
        self.assertEqual([p.title for p in load_pages(drafts)], ["D", "B", "A", "Zed"])

    def test_duplicate_urls(self):
        self.write("a.md", "---\ntitle: A\nslug: same\n---\n")
        self.write("b.md", "---\ntitle: B\nslug: same\n---\n")
        with self.assertRaises(ContentError) as ctx:
            load_pages(self.config())
        self.assertEqual(str(ctx.exception), "b.md:1: URL /same/ is also used by a.md")


if __name__ == "__main__":
    unittest.main()
