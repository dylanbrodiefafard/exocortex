import unittest

from storefront import money
from storefront.money import allocate, cents, format_money, parse_money

FORMAT_CASES = [
    ("zero", 0, "USD", "$0.00"),
    ("whole_dollars", 12, "USD", "$12.00"),
    ("cents", 3.5, "USD", "$3.50"),
    ("thousands", 1234.56, "USD", "$1,234.56"),
    ("millions", 1234567.25, "USD", "$1,234,567.25"),
    ("negative", -42.1, "USD", "-$42.10"),
    ("negative_thousands", -1500, "USD", "-$1,500.00"),
    ("tiny_positive", 0.004, "USD", "$0.00"),
    ("tiny_negative_has_no_sign", -0.004, "USD", "$0.00"),
    ("euro", 9.99, "EUR", "€9.99"),
    ("pound", 1000, "GBP", "£1,000.00"),
    ("canadian", 75.4, "CAD", "CA$75.40"),
    ("yen_whole", 1200, "JPY", "¥1,200"),
    ("yen_rounds", 1200.4, "JPY", "¥1,200"),
    ("unknown_currency", 5, "XTS", "XTS 5.00"),
    ("already_rounded", 19.99, "USD", "$19.99"),
    ("small_cents", 0.07, "USD", "$0.07"),
    ("large_round", 1e9, "USD", "$1,000,000,000.00"),
]

PARSE_CASES = [
    ("dollars", "$12.00", 12.0),
    ("thousands", "$1,234.56", 1234.56),
    ("negative", "-$42.10", -42.1),
    ("euro", "€9.99", 9.99),
    ("canadian", "CA$75.40", 75.4),
    ("bare_number", "3.25", 3.25),
    ("whitespace", "  $7.00 ", 7.0),
    ("yen", "¥1,200", 1200.0),
]

CENTS_CASES = [
    ("whole", 3, 300),
    ("fraction", 3.21, 321),
    ("half_up", 0.125, 13),
    ("float_noise", 1.005, 101),
    ("negative_half", -0.125, -13),
    ("zero", 0, 0),
    ("large", 123456.78, 12345678),
]


class FormatMoneyTest(unittest.TestCase):
    def test_price_ending_in_half_cent_rounds_up(self):
        self.assertEqual(format_money(2.675), "$2.68")

    def test_round_trip_with_parse(self):
        for value in (0.0, 1.5, 19.99, 1234.56, -3.2):
            with self.subTest(value=value):
                self.assertAlmostEqual(parse_money(format_money(value)), value)


class ParseMoneyTest(unittest.TestCase):
    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            parse_money("$")

    def test_rejects_garbage(self):
        with self.assertRaises(ValueError):
            parse_money("twelve dollars")


class CentsTest(unittest.TestCase):
    def test_to_cents_is_deprecated_alias(self):
        for amount in (0.5, 1.25, 99.99, 100, 7.07):
            with self.subTest(amount=amount):
                with self.assertWarns(DeprecationWarning):
                    self.assertEqual(money.to_cents(amount), cents(amount))

    def test_legacy_callers_still_work(self):
        totals = [money.to_cents(x / 7) for x in range(1, 40)]
        self.assertEqual(len(totals), 39)
        self.assertEqual(totals[6], 100)


class AllocateTest(unittest.TestCase):
    def test_even_split(self):
        self.assertEqual(allocate(9, [1, 1, 1]), [3.0, 3.0, 3.0])

    def test_remainder_goes_to_first_parts(self):
        self.assertEqual(allocate(10, [1, 1, 1]), [3.34, 3.33, 3.33])

    def test_weighted(self):
        self.assertEqual(allocate(100, [1, 3]), [25.0, 75.0])

    def test_parts_sum_to_total(self):
        for amount in (0.01, 1, 33.33, 1000.01, 2.5):
            for weights in ([1], [1, 2], [3, 3, 4], [5, 1, 1, 1]):
                with self.subTest(amount=amount, weights=weights):
                    self.assertEqual(sum(cents(p) for p in allocate(amount, weights)), cents(amount))

    def test_rejects_empty_weights(self):
        with self.assertRaises(ValueError):
            allocate(10, [])

    def test_rejects_zero_weights(self):
        with self.assertRaises(ValueError):
            allocate(10, [0, 0])


def _add_cases(cls, prefix, cases, check):
    for name, *args in cases:
        def test(self, args=args):
            check(self, *args)
        test.__name__ = f"test_{prefix}_{name}"
        setattr(cls, test.__name__, test)


_add_cases(FormatMoneyTest, "format", FORMAT_CASES,
           lambda self, amount, currency, expected: self.assertEqual(format_money(amount, currency), expected))
_add_cases(ParseMoneyTest, "parse", PARSE_CASES,
           lambda self, text, expected: self.assertAlmostEqual(parse_money(text), expected))
_add_cases(CentsTest, "cents", CENTS_CASES,
           lambda self, amount, expected: self.assertEqual(cents(amount), expected))


class HalfCentRoundingTest(unittest.TestCase):
    CASES = [
        (0.125, "USD", "$0.13"),
        (1.005, "USD", "$1.01"),
        (0.285, "USD", "$0.29"),
        (8.325, "USD", "$8.33"),
        (0.015, "EUR", "€0.02"),
        (-2.675, "USD", "-$2.68"),
        (-0.125, "USD", "-$0.13"),
        (-0.005, "USD", "-$0.01"),
        (1234.565, "GBP", "£1,234.57"),
        (2.5, "JPY", "¥3"),
        (1200.5, "JPY", "¥1,201"),
        (-0.5, "JPY", "-¥1"),
    ]

    def test_half_away_from_zero(self):
        for amount, currency, expected in self.CASES:
            with self.subTest(amount=amount, currency=currency):
                self.assertEqual(format_money(amount, currency), expected)

    def test_matches_cents_for_every_half_cent(self):
        for n in range(0, 2000, 7):
            amount = n / 1000
            with self.subTest(amount=amount):
                c = cents(amount)
                self.assertEqual(format_money(amount), f"${c // 100}.{c % 100:02d}")


if __name__ == "__main__":
    unittest.main()
