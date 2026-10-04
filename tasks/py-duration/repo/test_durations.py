import unittest

from durations import parse_duration


class ValidTest(unittest.TestCase):
    def test_single_units(self):
        self.assertEqual(parse_duration("45s"), 45)
        self.assertEqual(parse_duration("3m"), 180)
        self.assertEqual(parse_duration("2h"), 7200)
        self.assertEqual(parse_duration("1d"), 86400)

    def test_combined(self):
        self.assertEqual(parse_duration("1h30m"), 5400)
        self.assertEqual(parse_duration("1d2h3m4s"), 93784)

    def test_whitespace_and_case(self):
        self.assertEqual(parse_duration("  2D 4H  "), 2 * 86400 + 4 * 3600)
        self.assertEqual(parse_duration("1h 5m 10s"), 3910)

    def test_zero_and_large(self):
        self.assertEqual(parse_duration("0s"), 0)
        self.assertEqual(parse_duration("100m"), 6000)


class InvalidTest(unittest.TestCase):
    def assertInvalid(self, text):
        with self.assertRaises(ValueError, msg=repr(text)):
            parse_duration(text)

    def test_empty(self):
        self.assertInvalid("")
        self.assertInvalid("   ")

    def test_unknown_unit(self):
        self.assertInvalid("5w")
        self.assertInvalid("10")

    def test_missing_number(self):
        self.assertInvalid("h")
        self.assertInvalid("1h m")

    def test_repeated_or_out_of_order(self):
        self.assertInvalid("1h2h")
        self.assertInvalid("5m1h")

    def test_signs_and_decimals(self):
        self.assertInvalid("-5m")
        self.assertInvalid("1.5h")

    def test_garbage(self):
        self.assertInvalid("1h30m!")
        self.assertInvalid("abc")


if __name__ == "__main__":
    unittest.main()
