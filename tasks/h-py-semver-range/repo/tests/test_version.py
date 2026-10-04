import unittest

from semver import InvalidVersion, Version


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


if __name__ == "__main__":
    unittest.main()
