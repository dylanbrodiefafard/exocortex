import unittest

from storefront import text

SLUG_CASES = [
    ("simple", "Claw Hammer", "claw-hammer"),
    ("punctuation", "Chef's Knife, 8\"", "chef-s-knife-8"),
    ("accents", "Crème Brûlée Torch", "creme-brulee-torch"),
    ("collapse", "a  --  b", "a-b"),
    ("trim", "  --Hello--  ", "hello"),
    ("digits", "Drill 18V 2.0Ah", "drill-18v-2-0ah"),
    ("only_symbols", "!!!", ""),
    ("non_latin_dropped", "日本 Knife", "knife"),
    ("upper", "ALL CAPS", "all-caps"),
    ("underscores", "snake_case_name", "snake-case-name"),
]

TRUNCATE_CASES = [
    ("short", "Hammer", 10, "Hammer"),
    ("exact", "Hammer", 6, "Hammer"),
    ("word_boundary", "Cordless Drill Kit", 12, "Cordless…"),
    ("no_space", "Supercalifragilistic", 8, "Superca…"),
    ("two_words", "Garden Hose 50ft", 14, "Garden Hose…"),
]

TITLE_CASES = [
    ("simple", "claw hammer", "Claw Hammer"),
    ("small_words", "the best of the garden", "The Best of the Garden"),
    ("last_small_word", "what it is for", "What It Is For"),
    ("shouting", "CAST IRON SKILLET", "Cast Iron Skillet"),
    ("with_and", "salt and pepper", "Salt and Pepper"),
]

PLURAL_CASES = [
    ("one", 1, "item", None, "1 item"),
    ("zero", 0, "item", None, "0 items"),
    ("many", 5, "box", "boxes", "5 boxes"),
    ("irregular_one", 1, "knife", "knives", "1 knife"),
]


class TextTest(unittest.TestCase):
    def test_slug_max_length(self):
        slug = text.slugify("word " * 40, max_length=20)
        self.assertLessEqual(len(slug), 20)
        self.assertFalse(slug.endswith("-"))

    def test_long_titles_truncated(self):
        for n in range(5, 30, 3):
            with self.subTest(n=n):
                self.assertLessEqual(len(text.slugify("long product name " * n)), 60)

    def test_truncate_rejects_tiny_width(self):
        with self.assertRaises(ValueError):
            text.truncate("abc", 0)

    def test_make_slug_deprecated(self):
        with self.assertWarns(DeprecationWarning):
            self.assertEqual(text.make_slug("Old API"), "old-api")

    def test_make_slug_many_callers(self):
        names = [f"Legacy Product {i}" for i in range(30)]
        self.assertEqual([text.make_slug(n) for n in names][-1], "legacy-product-29")


for _cases, _prefix, _fn in (
    (SLUG_CASES, "slugify", text.slugify),
    (TRUNCATE_CASES, "truncate", text.truncate),
    (TITLE_CASES, "title_case", text.title_case),
    (PLURAL_CASES, "pluralize", text.pluralize),
):
    for _name, *_args in _cases:
        def _test(self, args=_args, fn=_fn):
            *inputs, expected = args
            self.assertEqual(fn(*inputs), expected)
        _test.__name__ = f"test_{_prefix}_{_name}"
        setattr(TextTest, _test.__name__, _test)


if __name__ == "__main__":
    unittest.main()
