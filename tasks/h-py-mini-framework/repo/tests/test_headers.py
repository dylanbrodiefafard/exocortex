import unittest

from wisp.request import Headers


class HeadersTests(unittest.TestCase):
    def test_case_insensitive_lookup(self):
        h = Headers([("Content-Type", "text/plain")])
        self.assertEqual(h["content-type"], "text/plain")
        self.assertIn("CONTENT-TYPE", h)

    def test_multiple_values(self):
        h = Headers()
        h.add("Set-Cookie", "a=1")
        h.add("set-cookie", "b=2")
        self.assertEqual(h.getall("Set-Cookie"), ["a=1", "b=2"])
        self.assertEqual(h["Set-Cookie"], "b=2")
        self.assertEqual(len(h), 1)

    def test_set_replaces(self):
        h = Headers.coerce({"Vary": "Origin"})
        h["vary"] = "Accept"
        self.assertEqual(h.getall("Vary"), ["Accept"])

    def test_coerce(self):
        self.assertEqual(len(Headers.coerce(None)), 0)
        h = Headers()
        self.assertIs(Headers.coerce(h), h)
        self.assertEqual(Headers.coerce([("A", "1")])["a"], "1")

    def test_missing(self):
        h = Headers()
        self.assertIsNone(h.get("X"))
        with self.assertRaises(KeyError):
            h["X"]


if __name__ == "__main__":
    unittest.main()
