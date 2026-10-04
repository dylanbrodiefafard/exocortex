import unittest

from storefront import tax

RATE_CASES = [
    ("ontario", "CA-ON", 0.13),
    ("quebec", "CA-QC", 0.14975),
    ("alberta", "CA-AB", 0.05),
    ("new_york", "US-NY", 0.08875),
    ("oregon", "US-OR", 0.0),
    ("germany", "DE", 0.19),
    ("japan", "JP", 0.10),
    ("unknown_region", "ZZ", 0.0),
    ("lowercase_is_unknown", "ca-on", 0.0),
]

TAX_CASES = [
    ("ontario_100", 100, "CA-ON", None, 13.0),
    ("ontario_cents", 19.99, "CA-ON", None, 2.6),
    ("quebec", 50, "CA-QC", None, 7.49),
    ("alberta", 80, "CA-AB", None, 4.0),
    ("new_york", 10, "US-NY", None, 0.89),
    ("california", 200, "US-CA", None, 14.5),
    ("texas", 64, "US-TX", None, 4.0),
    ("oregon", 999.99, "US-OR", None, 0.0),
    ("germany", 42, "DE", None, 7.98),
    ("uk", 12.5, "GB", None, 2.5),
    ("grocery_exempt_ontario", 100, "CA-ON", "grocery", 0.0),
    ("grocery_taxed_germany", 100, "DE", "grocery", 19.0),
    ("grocery_exempt_uk", 30, "GB", "grocery", 0.0),
    ("other_category", 100, "CA-ON", "hardware", 13.0),
    ("unknown_region", 100, "XX", None, 0.0),
    ("zero_amount", 0, "CA-ON", None, 0.0),
]

GROSS_CASES = [
    ("ontario", 100, "CA-ON", 113.0),
    ("new_york", 10, "US-NY", 10.89),
    ("oregon", 25, "US-OR", 25.0),
    ("japan", 1000, "JP", 1100.0),
    ("germany_cents", 9.99, "DE", 11.89),
]


class TaxTest(unittest.TestCase):
    def test_exemption_lookup(self):
        self.assertTrue(tax.is_exempt("CA-ON", "grocery"))
        self.assertFalse(tax.is_exempt("DE", "grocery"))
        self.assertFalse(tax.is_exempt("CA-ON", "toys"))

    def test_unknown_regions_logged_but_not_fatal(self):
        for region in ("XX", "YY", "ZZ-1", "MARS", "", "ca-qc"):
            with self.subTest(region=region):
                self.assertEqual(tax.tax_for(50, region), 0.0)


for _cases, _prefix, _check in (
    (RATE_CASES, "rate", lambda self, region, expected: self.assertAlmostEqual(tax.rate_for(region), expected)),
    (TAX_CASES, "tax", lambda self, amount, region, category, expected:
        self.assertAlmostEqual(tax.tax_for(amount, region, category), expected)),
    (GROSS_CASES, "gross", lambda self, amount, region, expected:
        self.assertAlmostEqual(tax.gross(amount, region), expected)),
):
    for _name, *_args in _cases:
        def _test(self, args=_args, check=_check):
            check(self, *args)
        _test.__name__ = f"test_{_prefix}_{_name}"
        setattr(TaxTest, _test.__name__, _test)


if __name__ == "__main__":
    unittest.main()
