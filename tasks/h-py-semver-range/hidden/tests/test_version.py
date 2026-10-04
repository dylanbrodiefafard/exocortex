import unittest

from semver import InvalidVersion, Version


def V(s):
    return Version.parse(s)


class VersionTest(unittest.TestCase):
    def test_parse_parts(self):
        v = Version.parse("1.2.3-beta.1+build.5")
        self.assertEqual((v.major, v.minor, v.patch), (1, 2, 3))
        self.assertEqual(v.prerelease, ("beta", "1"))
        self.assertEqual(v.build, ("build", "5"))

    def test_str_roundtrip(self):
        self.assertEqual(str(Version.parse("10.20.30-rc.1+abc")), "10.20.30-rc.1+abc")

    def test_ordering_of_releases(self):
        self.assertLess(Version.parse("1.2.3"), Version.parse("1.2.10"))
        self.assertLess(Version.parse("1.9.0"), Version.parse("1.10.0"))
        self.assertLess(Version.parse("1.0.0"), Version.parse("2.0.0"))

    def test_rejects_garbage(self):
        for text in ["", "1", "1.2", "a.b.c", "1.2.3.4"]:
            with self.subTest(text=text), self.assertRaises(InvalidVersion):
                Version.parse(text)

    def test_invalid_version_is_value_error(self):
        self.assertTrue(issubclass(InvalidVersion, ValueError))

    def test_prefix_and_whitespace(self):
        for text in ["v1.2.3", "=1.2.3", "  1.2.3  ", " v1.2.3\t"]:
            with self.subTest(text=text):
                v = V(text)
                self.assertEqual((v.major, v.minor, v.patch), (1, 2, 3))
                self.assertEqual(str(v), "1.2.3")

    def test_rejects_bad_prefixes(self):
        for text in ["vv1.2.3", "V1.2.3", "==1.2.3", "v=1.2.3"]:
            with self.subTest(text=text), self.assertRaises(InvalidVersion):
                V(text)

    def test_leading_zeros(self):
        for text in ["01.2.3", "1.02.3", "1.2.03", "00.0.0", "1.0.0-01", "1.0.0-alpha.00"]:
            with self.subTest(text=text), self.assertRaises(InvalidVersion):
                V(text)
        for text in ["0.0.0", "1.0.0-0", "1.0.0-0a", "1.0.0-alpha.0", "1.0.0+01", "1.0.0-0-1"]:
            with self.subTest(text=text):
                V(text)

    def test_bad_identifiers(self):
        for text in ["1.0.0-", "1.0.0+", "1.0.0-a..b", "1.0.0-a.", "1.0.0+a..b", "1.0.0-al_pha", "1.0.0+b@d", "1.0.0-a+b+c", "-1.0.0"]:
            with self.subTest(text=text), self.assertRaises(InvalidVersion):
                V(text)

    def test_hyphens_allowed_in_identifiers(self):
        v = V("1.0.0-x-y-z.--+b-1.-")
        self.assertEqual(v.prerelease, ("x-y-z", "--"))
        self.assertEqual(v.build, ("b-1", "-"))

    def test_semver_spec_precedence_chain(self):
        chain = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1-0",
            "1.0.1",
        ]
        for a, b in zip(chain, chain[1:]):
            with self.subTest(a=a, b=b):
                self.assertLess(V(a), V(b))
                self.assertGreater(V(b), V(a))
        self.assertEqual([str(v) for v in sorted(V(s) for s in reversed(chain))], chain)

    def test_numeric_identifiers_compare_numerically(self):
        self.assertLess(V("1.0.0-2"), V("1.0.0-10"))
        self.assertLess(V("1.0.0-rc.9"), V("1.0.0-rc.10"))
        self.assertLess(V("1.0.0-999"), V("1.0.0-a"))
        self.assertLess(V("1.0.0-1a"), V("1.0.0-a"))
        self.assertLess(V("1.0.0-Beta"), V("1.0.0-alpha"))

    def test_prerelease_below_release(self):
        self.assertLess(V("2.0.0-rc.1"), V("2.0.0"))
        self.assertGreater(V("2.0.0-rc.1"), V("1.99.99"))

    def test_build_metadata_ignored(self):
        self.assertEqual(V("1.0.0+a"), V("1.0.0+b"))
        self.assertEqual(V("1.0.0-rc.1+a"), V("1.0.0-rc.1"))
        self.assertEqual(hash(V("1.0.0+a")), hash(V("1.0.0+zzz.1")))
        self.assertFalse(V("1.0.0+a") < V("1.0.0+b"))
        self.assertFalse(V("1.0.0+b") < V("1.0.0+a"))
        self.assertEqual(len({V("1.0.0+a"), V("1.0.0+b"), V("1.0.0")}), 1)
        self.assertEqual(str(V("1.0.0+a")), "1.0.0+a")

    def test_large_numbers(self):
        self.assertLess(V("1.0.99999999999999999999"), V("1.0.100000000000000000000"))


if __name__ == "__main__":
    unittest.main()
