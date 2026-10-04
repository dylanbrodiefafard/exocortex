import unittest

from semver import satisfies


class RangeTest(unittest.TestCase):
    def check(self, rng, yes=(), no=()):
        for v in yes:
            with self.subTest(range=rng, version=v):
                self.assertTrue(satisfies(v, rng), f"{v} should satisfy {rng}")
        for v in no:
            with self.subTest(range=rng, version=v):
                self.assertFalse(satisfies(v, rng), f"{v} should not satisfy {rng}")

    def test_exact(self):
        self.check("1.2.3", yes=["1.2.3"], no=["1.2.4", "1.2.2"])

    def test_primitive_operators(self):
        self.check(">=1.2.3", yes=["1.2.3", "5.0.0"], no=["1.2.2"])
        self.check("<2.0.0", yes=["1.9.9"], no=["2.0.0"])

    def test_comparator_set(self):
        self.check(">=1.2.3 <1.5.0", yes=["1.2.3", "1.4.9"], no=["1.5.0", "1.2.2"])

    def test_union(self):
        self.check("1.2.3 || >=3.0.0", yes=["1.2.3", "3.1.0"], no=["2.0.0"])

    def test_caret(self):
        self.check("^1.2.3", yes=["1.2.3", "1.9.0"], no=["2.0.0", "1.2.2"])

    def test_tilde(self):
        self.check("~1.2.3", yes=["1.2.3", "1.2.9"], no=["1.3.0"])


if __name__ == "__main__":
    unittest.main()
