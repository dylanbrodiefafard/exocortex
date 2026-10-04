import unittest

from wisp.request import parse_urlencoded


class FormTests(unittest.TestCase):
    def test_pairs(self):
        form = parse_urlencoded(b"a=1&b=two+words&a=3")
        self.assertEqual(form.getall("a"), ["1", "3"])
        self.assertEqual(form.get("b"), "two words")

    def test_escapes(self):
        form = parse_urlencoded("q=50%25+off&k%3D=v")
        self.assertEqual(form.get("q"), "50% off")
        self.assertEqual(form.get("k="), "v")

    def test_empty_pairs_skipped(self):
        form = parse_urlencoded("a=1&&b=")
        self.assertEqual(form.items(), [("a", "1"), ("b", "")])


if __name__ == "__main__":
    unittest.main()
