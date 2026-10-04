import datetime
import unittest

from inkwell.content.frontmatter import split_front_matter
from inkwell.errors import ContentError


class FrontMatterTests(unittest.TestCase):
    def test_no_front_matter(self):
        self.assertEqual(split_front_matter("Hello", "a.md"), ({}, "Hello", 1))

    def test_typed_values(self):
        meta, body, line = split_front_matter(
            "---\ntitle: \"Hi: there\"\ndate: 2024-01-05\ntags: [a, 'b c']\ndraft: true\nweight: 3\n---\nBody\n",
            "a.md",
        )
        self.assertEqual(
            meta,
            {"title": "Hi: there", "date": datetime.date(2024, 1, 5), "tags": ["a", "b c"], "draft": True, "weight": 3},
        )
        self.assertEqual(body, "Body")
        self.assertEqual(line, 8)

    def test_empty_list(self):
        meta, _, _ = split_front_matter("---\ntags: []\n---\n", "a.md")
        self.assertEqual(meta["tags"], [])

    def test_errors(self):
        cases = {
            "---\ntitle: x\n": "a.md:1: front matter is not closed with ---",
            "---\njust words\n---\n": "a.md:2: expected 'key: value', got 'just words'",
            "---\na: 1\na: 2\n---\n": "a.md:3: duplicate key 'a'",
            "---\nd: 2024-02-30\n---\n": "a.md:2: invalid date '2024-02-30'",
            "---\nt: [a, b\n---\n": "a.md:2: list is not closed with ]",
        }
        for text, message in cases.items():
            with self.subTest(text=text):
                with self.assertRaises(ContentError) as ctx:
                    split_front_matter(text, "a.md")
                self.assertEqual(str(ctx.exception), message)


if __name__ == "__main__":
    unittest.main()
