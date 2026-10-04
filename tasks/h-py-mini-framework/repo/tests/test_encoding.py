import unittest

from wisp.utils import quote, unquote


class EncodingTests(unittest.TestCase):
    def test_unquote_ascii(self):
        self.assertEqual(unquote("a%20b%2Fc"), "a b/c")

    def test_plus_handling(self):
        self.assertEqual(unquote("a+b"), "a b")
        self.assertEqual(unquote("a+b", plus_as_space=False), "a+b")

    def test_malformed_escapes_kept(self):
        self.assertEqual(unquote("100%"), "100%")
        self.assertEqual(unquote("%zz%4"), "%zz%4")

    def test_quote(self):
        self.assertEqual(quote("a b/c"), "a%20b%2Fc")
        self.assertEqual(quote("a b/c", safe="/"), "a%20b/c")
        self.assertEqual(quote("é"), "%C3%A9")
        self.assertEqual(quote("safe-._~"), "safe-._~")


if __name__ == "__main__":
    unittest.main()
