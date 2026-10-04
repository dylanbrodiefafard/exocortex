import unittest

from wisp.request import parse_cookie_header


class CookieTests(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(parse_cookie_header("a=1; b=2"), {"a": "1", "b": "2"})

    def test_empty(self):
        self.assertEqual(parse_cookie_header(None), {})
        self.assertEqual(parse_cookie_header(""), {})

    def test_quotes_and_escapes(self):
        self.assertEqual(parse_cookie_header('msg="hi%20there"'), {"msg": "hi there"})

    def test_plus_is_literal(self):
        self.assertEqual(parse_cookie_header("expr=1+1"), {"expr": "1+1"})

    def test_bad_pairs_ignored_and_last_wins(self):
        self.assertEqual(parse_cookie_header("junk; a=1; =x; a=2"), {"a": "2"})


if __name__ == "__main__":
    unittest.main()
