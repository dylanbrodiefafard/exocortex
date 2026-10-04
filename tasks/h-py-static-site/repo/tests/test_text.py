import unittest

from inkwell.text.html import Markup, escape, strip_tags
from inkwell.text.slug import slugify
from inkwell.text.words import collapse_whitespace, reading_time, truncate_chars, truncate_words, word_count


class WordsTests(unittest.TestCase):
    def test_collapse(self):
        self.assertEqual(collapse_whitespace("  a \n\t b  "), "a b")

    def test_truncate_words(self):
        self.assertEqual(truncate_words("one two three", 3), "one two three")
        self.assertEqual(truncate_words("one  two\nthree", 5), "one two three")
        self.assertEqual(truncate_words("one two three", 2), "one two ...")
        self.assertEqual(truncate_words("Hello, world, again", 2), "Hello, world ...")
        self.assertEqual(truncate_words("a b c", 1, suffix="!"), "a!")

    def test_truncate_words_keeps_pure_punctuation(self):
        self.assertEqual(truncate_words("a - b", 2), "a - ...")

    def test_truncate_chars(self):
        self.assertEqual(truncate_chars("short", 10), "short")
        self.assertEqual(truncate_chars("the quick brown fox", 12), "the quick...")

    def test_counts(self):
        self.assertEqual(word_count(" a b  c "), 3)
        self.assertEqual(reading_time("word " * 401), 3)
        self.assertEqual(reading_time(""), 1)


class HtmlTests(unittest.TestCase):
    def test_escape(self):
        self.assertEqual(escape('<a href="x">'), "&lt;a href=&quot;x&quot;&gt;")
        self.assertEqual(escape(Markup("<b>")), "<b>")
        self.assertEqual(escape(None), "")

    def test_strip_tags(self):
        self.assertEqual(strip_tags("<p>Hello <b>you</b></p><p>there</p>"), "Hello you there")
        self.assertEqual(strip_tags("a<script>var x = 1;</script>b"), "ab")
        self.assertEqual(strip_tags("<style>p{}</style><p>&amp; &lt;3</p>"), "& <3")
        self.assertEqual(strip_tags("x<!-- hidden -->y"), "xy")
        self.assertEqual(strip_tags("<ul><li>a</li><li>b</li></ul>"), "a b")


class SlugTests(unittest.TestCase):
    def test_slugify(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("Café au lait"), "cafe-au-lait")
        self.assertEqual(slugify("  --  "), "")

    def test_max_length(self):
        self.assertEqual(slugify("aaa bbb ccc", max_length=9), "aaa-bbb")


if __name__ == "__main__":
    unittest.main()
