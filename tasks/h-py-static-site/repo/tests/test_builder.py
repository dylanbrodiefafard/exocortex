import shutil
import tempfile
import unittest
from pathlib import Path

from inkwell.config import load_config
from inkwell.site.builder import build_site, collect_tags, paginate

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "blog"


class HelperTests(unittest.TestCase):
    def test_paginate(self):
        self.assertEqual(paginate([1, 2, 3], 2), [[1, 2], [3]])
        self.assertEqual(paginate([], 2), [[]])


class ExampleSiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        site = Path(cls.tmp.name) / "blog"
        shutil.copytree(EXAMPLE, site)
        cls.config = load_config(site / "site.ini")
        cls.result = build_site(cls.config)
        cls.out = Path(cls.config.output_dir)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def read(self, path):
        return (self.out / path).read_text()

    def test_files(self):
        written = sorted(p.relative_to(self.out).as_posix() for p in self.result.written)
        self.assertEqual(
            written,
            sorted([
                "posts/moss/index.html",
                "posts/tide-pools/index.html",
                "posts/hello-world/index.html",
                "about/index.html",
                "index.html",
                "page/2/index.html",
                "tags/coast/index.html",
                "tags/field/index.html",
                "tags/meta/index.html",
                "feed.xml",
            ]),
        )

    def test_drafts_skipped(self):
        self.assertFalse((self.out / "posts" / "unfinished").exists())

    def test_post_page(self):
        html = self.read("posts/tide-pools/index.html")
        self.assertIn("<h1>Tide pools at low water</h1>", html)
        self.assertIn("18 Apr 2024 &middot; field, coast", html)
        self.assertIn("<li>14 <em>Pisaster</em> sea stars</li>", html)
        self.assertIn('<a href="https://notes.example.org/">Field Notes</a>', html)

    def test_index_pagination(self):
        first = self.read("index.html")
        self.assertIn("Moss on the north wall", first)
        self.assertIn("Tide pools at low water", first)
        self.assertNotIn("Hello, world", first)
        self.assertIn('<a href="/page/2/">Older</a>', first)
        second = self.read("page/2/index.html")
        self.assertIn("Hello, world", second)
        self.assertIn('<a href="/">Newer</a>', second)

    def test_tags(self):
        html = self.read("tags/field/index.html")
        self.assertIn("Tagged field", html)
        self.assertLess(html.index("Moss"), html.index("Tide pools"))

    def test_feed(self):
        feed = self.read("feed.xml")
        self.assertIn("<title>Field Notes</title>", feed)
        self.assertIn('<link href="https://notes.example.org/posts/moss/"/>', feed)
        self.assertEqual(feed.count("<entry>"), 3)


if __name__ == "__main__":
    unittest.main()
