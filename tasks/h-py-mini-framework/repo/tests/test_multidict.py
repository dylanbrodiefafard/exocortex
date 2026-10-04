import unittest

from wisp.utils import MultiDict


class MultiDictTests(unittest.TestCase):
    def test_order_and_last_value(self):
        md = MultiDict([("a", "1"), ("b", "2"), ("a", "3")])
        self.assertEqual(list(md), ["a", "b"])
        self.assertEqual(md["a"], "3")
        self.assertEqual(md.getall("a"), ["1", "3"])
        self.assertEqual(md.items(), [("a", "1"), ("b", "2"), ("a", "3")])

    def test_defaults(self):
        md = MultiDict()
        self.assertIsNone(md.get("x"))
        self.assertEqual(md.get("x", "d"), "d")
        self.assertEqual(md.getall("x"), [])
        self.assertNotIn("x", md)

    def test_set_and_remove(self):
        md = MultiDict([("a", "1"), ("a", "2")])
        md.set("a", "9")
        self.assertEqual(md.getall("a"), ["9"])
        md.remove("a")
        self.assertEqual(len(md), 0)


if __name__ == "__main__":
    unittest.main()
