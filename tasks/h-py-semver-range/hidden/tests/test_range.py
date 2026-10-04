import unittest

from semver import InvalidRange, InvalidVersion, Range, Version, max_satisfying, satisfies


class RangeCase(unittest.TestCase):
    def check(self, rng, yes=(), no=()):
        for v in yes:
            with self.subTest(range=rng, version=v):
                self.assertTrue(satisfies(v, rng), f"{v} should satisfy {rng}")
        for v in no:
            with self.subTest(range=rng, version=v):
                self.assertFalse(satisfies(v, rng), f"{v} should not satisfy {rng}")


class RangeTest(RangeCase):
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


class PrimitiveTest(RangeCase):
    def test_all_operators(self):
        self.check(">1.2.3", yes=["1.2.4", "2.0.0"], no=["1.2.3", "1.0.0"])
        self.check("<=1.2.3", yes=["1.2.3", "0.0.1"], no=["1.2.4"])
        self.check("=1.2.3", yes=["1.2.3", "1.2.3+build"], no=["1.2.4"])
        self.check("v1.2.3", yes=["1.2.3"], no=["1.2.4"])
        self.check("=v1.2.3", yes=["1.2.3"], no=["1.2.4"])

    def test_version_objects_accepted(self):
        self.assertTrue(satisfies(Version.parse("1.5.0"), "^1.2.3"))
        self.assertTrue(Range("^1.2.3").test("1.5.0"))
        self.assertFalse(Range("^1.2.3").test(Version.parse("2.0.0")))

    def test_whitespace(self):
        self.check(">= 1.2.3", yes=["1.2.3"], no=["1.2.2"])
        self.check("  >=1.2.3   <  2.0.0  ", yes=["1.9.0"], no=["2.0.0", "1.0.0"])
        self.check("1.2.3||2.0.0", yes=["1.2.3", "2.0.0"], no=["1.5.0"])
        self.check("\t^1.0.0 \t|| \t~3.1", yes=["1.4.0", "3.1.5"], no=["3.2.0"])

    def test_empty_matches_everything(self):
        for rng in ["", "   ", "*", "x", "X"]:
            self.check(rng, yes=["0.0.0", "1.2.3", "99.0.0"])

    def test_build_metadata_in_range(self):
        self.check("1.2.3+abc", yes=["1.2.3", "1.2.3+xyz"], no=["1.2.4"])
        self.check(">1.2.3+zzz", no=["1.2.3+aaa"], yes=["1.2.4"])


class XRangeTest(RangeCase):
    def test_partial_and_wildcards(self):
        for rng in ["1.2", "1.2.x", "1.2.X", "1.2.*", "=1.2"]:
            self.check(rng, yes=["1.2.0", "1.2.99"], no=["1.3.0", "1.1.9"])
        for rng in ["1", "1.x", "1.x.x", "1.*.*", "1.X"]:
            self.check(rng, yes=["1.0.0", "1.99.0"], no=["2.0.0", "0.9.9"])

    def test_wildcard_order(self):
        for rng in ["1.x.3", "*.2.3", "1.*.0"]:
            with self.subTest(rng=rng), self.assertRaises(InvalidRange):
                Range(rng)

    def test_partial_cannot_have_prerelease(self):
        for rng in ["1.2-beta", "1.x-beta", "^1.2-beta"]:
            with self.subTest(rng=rng), self.assertRaises(InvalidRange):
                Range(rng)

    def test_operators_with_partials(self):
        self.check(">=1.2", yes=["1.2.0", "3.0.0"], no=["1.1.9"])
        self.check("<1.2", yes=["1.1.9"], no=["1.2.0"])
        self.check(">1.2", yes=["1.3.0"], no=["1.2.0", "1.2.9"])
        self.check("<=1.2", yes=["1.2.9", "1.0.0"], no=["1.3.0"])
        self.check(">1", yes=["2.0.0"], no=["1.9.9"])
        self.check("<=1", yes=["1.9.9"], no=["2.0.0"])
        self.check(">=1.x", yes=["1.0.0"], no=["0.9.0"])
        self.check("<1.x", yes=["0.9.0"], no=["1.0.0"])
        self.check(">1.2.x", yes=["1.3.0"], no=["1.2.5"])


class TildeTest(RangeCase):
    def test_tilde_forms(self):
        self.check("~1.2", yes=["1.2.0", "1.2.7"], no=["1.3.0", "1.1.0"])
        self.check("~1", yes=["1.0.0", "1.9.9"], no=["2.0.0", "0.9.0"])
        self.check("~1.x", yes=["1.5.0"], no=["2.0.0"])
        self.check("~0.2.3", yes=["0.2.3", "0.2.9"], no=["0.3.0", "0.2.2"])
        self.check("~ 1.2.3", yes=["1.2.5"], no=["1.3.0"])

    def test_tilde_prerelease(self):
        self.check("~1.2.3-beta.2", yes=["1.2.3-beta.2", "1.2.3-beta.10", "1.2.3", "1.2.9"],
                   no=["1.2.3-beta.1", "1.2.4-beta.2", "1.3.0"])


class CaretTest(RangeCase):
    def test_caret_forms(self):
        self.check("^0.2.3", yes=["0.2.3", "0.2.9"], no=["0.3.0", "0.2.2", "1.0.0"])
        self.check("^0.0.3", yes=["0.0.3"], no=["0.0.4", "0.0.2", "0.1.0"])
        self.check("^1.2", yes=["1.2.0", "1.9.9"], no=["2.0.0", "1.1.9"])
        self.check("^1", yes=["1.0.0", "1.9.9"], no=["2.0.0"])
        self.check("^0.0", yes=["0.0.0", "0.0.9"], no=["0.1.0"])
        self.check("^0", yes=["0.0.0", "0.9.9"], no=["1.0.0"])
        self.check("^0.1", yes=["0.1.0", "0.1.5"], no=["0.2.0"])
        self.check("^0.0.x", yes=["0.0.7"], no=["0.1.0"])
        self.check("^1.x", yes=["1.5.0"], no=["2.0.0"])
        self.check("^0.0.0", yes=["0.0.0"], no=["0.0.1"])
        self.check("^ 1.2.3", yes=["1.5.0"], no=["2.0.0"])

    def test_caret_prerelease(self):
        self.check("^1.2.3-beta.2", yes=["1.2.3-beta.2", "1.2.3-beta.4", "1.2.3", "1.9.0"],
                   no=["1.2.3-beta.1", "1.2.4-beta.2", "2.0.0", "2.0.0-beta.2"])
        self.check("^0.0.3-beta", yes=["0.0.3-pr.2", "0.0.3"], no=["0.0.4", "0.0.3-alpha"])


class HyphenTest(RangeCase):
    def test_full(self):
        self.check("1.2.3 - 2.3.4", yes=["1.2.3", "2.0.0", "2.3.4"], no=["1.2.2", "2.3.5"])

    def test_partial_left(self):
        self.check("1.2 - 2.3.4", yes=["1.2.0", "2.3.4"], no=["1.1.9", "2.3.5"])
        self.check("1 - 2.3.4", yes=["1.0.0"], no=["0.9.9"])

    def test_partial_right(self):
        self.check("1.2.3 - 2.3", yes=["2.3.9", "1.2.3"], no=["2.4.0", "1.2.2"])
        self.check("1.2.3 - 2", yes=["2.9.9"], no=["3.0.0"])
        self.check("1.2.3 - 2.x", yes=["2.9.9"], no=["3.0.0"])

    def test_combined_with_other_comparators(self):
        self.check("1.0.0 - 2.0.0 <1.5.0", yes=["1.4.9"], no=["1.5.0", "2.0.0"])
        self.check("1.0.0 - 1.2.0 || 3.0.0 - 3.1.0", yes=["1.1.0", "3.0.5"], no=["2.0.0"])

    def test_no_spaces_is_a_prerelease(self):
        self.check("1.2.3-2.0.0", yes=["1.2.3-2.0.0"], no=["1.5.0", "2.0.0"])

    def test_prerelease_endpoints(self):
        self.check("1.2.3-rc.1 - 2.0.0", yes=["1.2.3-rc.2", "1.2.3", "2.0.0"],
                   no=["1.2.3-rc.0", "2.0.0-rc.1", "1.5.0-rc.1"])


class PrereleaseRuleTest(RangeCase):
    def test_same_tuple_required(self):
        self.check(">1.2.3-alpha.3", yes=["1.2.3-alpha.7", "1.2.3", "3.4.5"],
                   no=["3.4.5-alpha.9", "1.2.3-alpha.3", "1.2.3-alpha.2"])

    def test_plain_ranges_exclude_prereleases(self):
        self.check("^1.2.3", no=["1.5.0-rc.1", "2.0.0-rc.1", "1.2.3-rc.1"])
        self.check(">=1.0.0", no=["1.0.1-alpha", "2.0.0-beta"])
        self.check("<2.0.0", no=["2.0.0-rc.1", "1.0.0-rc.1"])
        self.check("*", no=["1.0.0-rc.1"])
        self.check("", no=["1.0.0-rc.1"])
        self.check("1.x", no=["1.2.0-beta"])
        self.check("1.0.0 - 2.0.0", no=["1.5.0-beta"])

    def test_any_comparator_in_set_counts(self):
        self.check(">=1.0.0 <2.0.0-rc.5", yes=["2.0.0-rc.1"], no=["2.0.0-rc.5", "1.5.0-rc.1"])
        self.check("<=1.2.3-beta >1.0.0", yes=["1.2.3-alpha"], no=["1.1.0-alpha"])

    def test_rule_is_per_set(self):
        self.check(">=1.2.3-beta || >=2.0.0", yes=["1.2.3-beta.1"], no=["2.0.1-beta"])
        self.check(">=2.0.0 || >=1.2.3-beta", yes=["1.2.3-beta.1"], no=["2.0.1-beta"])

    def test_exact_prerelease(self):
        self.check("1.2.3-beta.1", yes=["1.2.3-beta.1", "1.2.3-beta.1+b"], no=["1.2.3-beta.2", "1.2.3"])


class InvalidRangeTest(unittest.TestCase):
    def test_invalid(self):
        bad = [
            ">=", "<", "~", "^", ">=1.2.3.4", "1.2.3 -", "- 1.2.3", "1.2.3 - 2.0.0 -",
            "abc", "1.x.3", "~>1.2", "1.2.3 || || 2.0.0", "|| 1.0.0", "1.0.0 ||", "||",
            "01.2.3", ">=1.02", "1.2.3-", "!1.2.3", ">>1.2.3", "=>1.2.3", "1.2.3 <", "a - b",
            "1.2.3 - 2.0.0 - 3.0.0",
        ]
        for rng in bad:
            with self.subTest(rng=rng), self.assertRaises(InvalidRange):
                Range(rng)
            with self.subTest(rng=rng, via="satisfies"), self.assertRaises(InvalidRange):
                satisfies("1.2.3", rng)

    def test_invalid_range_is_value_error(self):
        self.assertTrue(issubclass(InvalidRange, ValueError))

    def test_invalid_version_in_satisfies(self):
        for v in ["1.2", "x", "01.0.0", "1.2.3.4"]:
            with self.subTest(v=v), self.assertRaises(InvalidVersion):
                satisfies(v, "*")


class MaxSatisfyingTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(max_satisfying(["1.2.0", "1.3.1", "2.0.0", "1.3.0"], "~1.3"), "1.3.1")
        self.assertEqual(max_satisfying(["1.2.0", "1.3.1", "2.0.0"], "^1"), "1.3.1")
        self.assertEqual(max_satisfying(["1.2.0", "1.3.1", "2.0.0"], "*"), "2.0.0")

    def test_none(self):
        self.assertIsNone(max_satisfying(["1.2.0", "1.3.1"], ">=5"))
        self.assertIsNone(max_satisfying([], "*"))

    def test_numeric_not_lexical(self):
        self.assertEqual(max_satisfying(["1.9.0", "1.10.0", "1.2.0"], "^1"), "1.10.0")

    def test_returns_input_string(self):
        self.assertEqual(max_satisfying(["v1.2.3", " =1.4.0 ", "1.3.0"], "^1"), " =1.4.0 ")

    def test_skips_invalid(self):
        self.assertEqual(max_satisfying(["garbage", "1.2.3", "9.9", "01.5.0", "1.4.0"], "^1"), "1.4.0")

    def test_prereleases(self):
        self.assertEqual(max_satisfying(["1.2.3", "1.2.4-beta.1", "1.2.3-beta.9"], "^1.2.3-beta.1"), "1.2.3")
        self.assertEqual(max_satisfying(["2.0.0-rc.1", "2.0.0-rc.2"], ">=2.0.0-rc.1"), "2.0.0-rc.2")
        self.assertEqual(max_satisfying(["2.0.0-rc.10", "2.0.0-rc.9"], ">=2.0.0-rc.1"), "2.0.0-rc.10")

    def test_tie_keeps_first(self):
        self.assertEqual(max_satisfying(["1.0.0+b", "1.0.0+a", "0.9.0"], "*"), "1.0.0+b")
        self.assertEqual(max_satisfying(["0.9.0", "1.0.0+a", "1.0.0", "1.0.0+b"], "*"), "1.0.0+a")

    def test_accepts_any_iterable(self):
        self.assertEqual(max_satisfying(iter(["1.0.0", "1.1.0"]), "1"), "1.1.0")
        self.assertEqual(max_satisfying((v for v in ["1.0.0", "1.1.0"]), "1"), "1.1.0")

    def test_invalid_range_raises(self):
        with self.assertRaises(InvalidRange):
            max_satisfying(["1.0.0"], ">=")


if __name__ == "__main__":
    unittest.main()
