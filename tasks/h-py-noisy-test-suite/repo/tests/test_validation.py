import unittest

from storefront import validation
from storefront.validation import ValidationError

GOOD_SKUS = ["HW-1001", "KT-4002", "ABCD-123456", "PT-500"]
BAD_SKUS = ["hw-1001", "H-1001", "HW1001", "HW-12", "HWXYZ-1001", "HW-1234567", "", "HW-10O1"]
GOOD_EMAILS = [
    ("plain", "alice@example.com", "alice@example.com"),
    ("upper", "Bob@Example.COM", "bob@example.com"),
    ("plus", "carol+shop@example.co.uk", "carol+shop@example.co.uk"),
    ("whitespace", "  dave@example.org ", "dave@example.org"),
    ("dots", "e.r.i.n@sub.example.io", "e.r.i.n@sub.example.io"),
]
BAD_EMAILS = ["", "no-at-sign", "a@b", "a@b.c", "@example.com", "alice@", "al ice@example.com", "a@@example.com"]
POSTAL_CASES = [
    ("ca", "CA", "m5v 3l9", "M5V 3L9"),
    ("ca_no_space", "CA", "K1A0B1", "K1A0B1"),
    ("us", "US", "10001", "10001"),
    ("us_plus4", "US", "10001-1234", "10001-1234"),
    ("gb", "GB", "sw1a 1aa", "SW1A 1AA"),
    ("unknown_country", "FR", " 75008 ", "75008"),
]
BAD_POSTAL = [("CA", "12345"), ("US", "1000"), ("US", "ABCDE"), ("GB", "12345")]
QUANTITY_CASES = [("int", 3, 3), ("str", "7", 7), ("padded", " 2 ", 2)]
BAD_QUANTITIES = [0, -1, "x", None, "1.5", ""]


class ValidationTest(unittest.TestCase):
    def test_validate_sku_deprecated(self):
        with self.assertWarns(DeprecationWarning):
            self.assertTrue(validation.validate_sku("HW-1001"))

    def test_validate_sku_legacy_batch(self):
        results = [validation.validate_sku(s) for s in GOOD_SKUS + BAD_SKUS]
        self.assertEqual(results, [True] * len(GOOD_SKUS) + [False] * len(BAD_SKUS))

    def test_bad_postal_codes(self):
        for country, code in BAD_POSTAL:
            with self.subTest(country=country, code=code):
                with self.assertRaises(ValidationError):
                    validation.check_postal_code(country, code)

    def test_bad_quantities(self):
        for value in BAD_QUANTITIES:
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    validation.check_quantity(value)

    def test_validation_error_is_value_error(self):
        self.assertTrue(issubclass(ValidationError, ValueError))


def _add(name, fn):
    fn.__name__ = name
    setattr(ValidationTest, name, fn)


for _sku in GOOD_SKUS:
    _add(f"test_good_sku_{_sku.replace('-', '_').lower()}",
         lambda self, sku=_sku: self.assertEqual(validation.check_sku(sku), sku))
for _i, _sku in enumerate(BAD_SKUS):
    def _bad_sku(self, sku=_sku):
        with self.assertRaises(ValidationError):
            validation.check_sku(sku)
    _add(f"test_bad_sku_{_i}", _bad_sku)
for _name, _email, _expected in GOOD_EMAILS:
    _add(f"test_good_email_{_name}",
         lambda self, email=_email, expected=_expected: self.assertEqual(validation.check_email(email), expected))
for _i, _email in enumerate(BAD_EMAILS):
    def _bad_email(self, email=_email):
        with self.assertRaises(ValidationError):
            validation.check_email(email)
    _add(f"test_bad_email_{_i}", _bad_email)
for _name, _country, _code, _expected in POSTAL_CASES:
    _add(f"test_postal_{_name}",
         lambda self, c=_country, code=_code, e=_expected: self.assertEqual(validation.check_postal_code(c, code), e))
for _name, _value, _expected in QUANTITY_CASES:
    _add(f"test_quantity_{_name}",
         lambda self, v=_value, e=_expected: self.assertEqual(validation.check_quantity(v), e))


if __name__ == "__main__":
    unittest.main()
