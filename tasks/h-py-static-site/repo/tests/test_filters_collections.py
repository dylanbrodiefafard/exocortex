import unittest

from tests.support import render

POSTS = [
    {"title": "b", "tags": ["x"], "n": 2},
    {"title": "a", "tags": ["y", "x"], "n": 1},
    {"title": "c", "tags": [], "n": 3},
]


class CollectionFilterTests(unittest.TestCase):
    def test_join_length(self):
        self.assertEqual(render("{{ xs | join }}|{{ xs | join:'-' }}|{{ xs | length }}", xs=["a", "b"]), "a, b|a-b|2")

    def test_first_last_reverse(self):
        self.assertEqual(render("{{ xs | first }}{{ xs | last }}{{ xs | reverse | join:'' }}", xs=[1, 2, 3]), "13321")
        self.assertEqual(render("[{{ xs | first }}]", xs=[]), "[]")

    def test_limit_sort_where(self):
        self.assertEqual(render("{{ xs | limit:2 | join }}", xs=[1, 2, 3]), "1, 2")
        out = render("{% for p in ps | sort:'title' %}{{ p.title }}{% endfor %}", ps=POSTS)
        self.assertEqual(out, "abc")
        out = render("{% for p in ps | where:'tags','x' %}{{ p.title }}{% endfor %}", ps=POSTS)
        self.assertEqual(out, "ba")
        out = render("{% for p in ps | where:'n',3 %}{{ p.title }}{% endfor %}", ps=POSTS)
        self.assertEqual(out, "c")


if __name__ == "__main__":
    unittest.main()
