import unittest

from storefront.cart import Cart, LineItem
from storefront.catalog import Catalog, Product
from storefront.inventory import Inventory, OutOfStock


def make_catalog():
    catalog = Catalog()
    for sku, name, price in [
        ("HW-1001", "Claw Hammer", 24.99),
        ("HW-2001", "Cordless Drill", 129.0),
        ("KT-4002", "Paring Knife", 19.0),
        ("GD-3002", "Hose Nozzle", 9.5),
        ("PT-5001", "Dog Leash", 14.0),
    ]:
        catalog.add(Product(sku, name, price))
    return catalog


def make_inventory():
    inv = Inventory(low_stock_threshold=2)
    for sku, qty in [("HW-1001", 5), ("HW-2001", 2), ("KT-4002", 20), ("GD-3002", 3), ("PT-5001", 8)]:
        inv.receive(sku, qty)
    return inv


class LineItemTest(unittest.TestCase):
    def test_subtotal(self):
        self.assertEqual(LineItem("A", 2.5, 4).subtotal, 10.0)

    def test_subtotal_rounds_to_cents(self):
        self.assertEqual(LineItem("A", 0.333, 3).subtotal, 1.0)

    def test_frozen(self):
        with self.assertRaises(AttributeError):
            LineItem("A", 1.0, 1).quantity = 2


class CartTest(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.catalog = make_catalog()
        self.inventory = make_inventory()
        self.cart = Cart("CA-ON", self.catalog, self.inventory)

    def test_empty_cart(self):
        self.assertEqual(Cart("CA-ON").subtotal, 0.0)
        self.assertEqual(Cart("CA-ON").total, 0.0)

    def test_add_uses_catalog_price(self):
        self.cart.add("HW-1001")
        self.assertEqual(self.cart.lines(), [LineItem("HW-1001", 24.99, 1)])

    def test_add_merges_quantities(self):
        self.cart.add("KT-4002", 2)
        self.cart.add("KT-4002", 3)
        self.assertEqual(self.cart.lines()[0].quantity, 5)

    def test_add_explicit_price(self):
        cart = Cart("CA-ON")
        cart.add("XX-1", 2, unit_price=3.25)
        self.assertEqual(cart.subtotal, 6.5)

    def test_add_without_price_or_catalog(self):
        with self.assertRaises(ValueError):
            Cart("CA-ON").add("XX-1")

    def test_add_rejects_zero_quantity(self):
        with self.assertRaises(ValueError):
            self.cart.add("HW-1001", 0)

    def test_add_reserves_stock(self):
        self.cart.add("HW-1001", 2)
        self.assertEqual(self.inventory.available("HW-1001"), 3)

    def test_add_out_of_stock(self):
        with self.assertRaises(OutOfStock):
            self.cart.add("HW-2001", 3)
        self.assertEqual(self.cart.lines(), [])

    def test_remove_releases_stock(self):
        self.cart.add("GD-3002", 3)
        self.cart.remove("GD-3002")
        self.assertEqual(self.inventory.available("GD-3002"), 3)
        self.assertEqual(self.cart.lines(), [])

    def test_lines_sorted(self):
        for sku in ("PT-5001", "HW-1001", "KT-4002"):
            self.cart.add(sku)
        self.assertEqual([line.sku for line in self.cart.lines()], ["HW-1001", "KT-4002", "PT-5001"])

    def test_subtotal(self):
        self.cart.add("HW-1001", 2)
        self.cart.add("GD-3002", 1)
        self.assertEqual(self.cart.subtotal, 59.48)

    def test_tax_and_total(self):
        self.cart.add("HW-2001", 1)
        self.assertEqual(self.cart.tax, 16.77)
        self.assertEqual(self.cart.total, 145.77)

    def test_percent_discount(self):
        self.cart.add("PT-5001", 5)
        self.cart.apply_discount(percent=10)
        self.assertEqual(self.cart.discount_total, 7.0)
        self.assertEqual(self.cart.taxable, 63.0)

    def test_amount_discount(self):
        self.cart.add("PT-5001", 2)
        self.cart.apply_discount(amount=5)
        self.assertEqual(self.cart.taxable, 23.0)

    def test_stacked_discounts(self):
        self.cart.add("KT-4002", 10)
        self.cart.apply_discount(percent=10, code="SPRING10")
        self.cart.apply_discount(amount=4.0, code="WELCOME")
        self.assertEqual(self.cart.discount_total, 23.0)

    def test_discount_capped_at_subtotal(self):
        self.cart.add("GD-3002", 1)
        self.cart.apply_discount(amount=50)
        self.assertEqual(self.cart.taxable, 0.0)
        self.assertEqual(self.cart.total, 0.0)

    def test_discount_validation(self):
        with self.assertRaises(ValueError):
            self.cart.apply_discount(percent=120)
        with self.assertRaises(ValueError):
            self.cart.apply_discount(amount=-1)

    def test_apply_coupon_deprecated(self):
        self.cart.add("KT-4002", 4)
        with self.assertWarns(DeprecationWarning):
            self.cart.apply_coupon("SAVE25")
        self.assertEqual(self.cart.discount_total, 19.0)

    def test_legacy_coupons(self):
        self.cart.add("KT-4002", 10)
        for code in ("A05", "B05", "C10", "NOPE", "D05"):
            self.cart.apply_coupon(code)
        self.assertEqual(self.cart.discount_total, 47.5)

    def test_summary(self):
        self.cart.add("HW-1001", 2)
        self.cart.add("PT-5001", 1)
        self.cart.apply_discount(amount=3.98)
        self.assertEqual(self.cart.summary(), {
            "lines": 2,
            "items": 3,
            "subtotal": "$63.98",
            "discounts": "$3.98",
            "tax": "$7.80",
            "total": "$67.80",
        })

    def test_summary_empty(self):
        self.assertEqual(Cart("US-OR").summary()["total"], "$0.00")


REGION_TOTAL_CASES = [
    ("ontario", "CA-ON", 113.0),
    ("quebec", "CA-QC", 114.98),
    ("alberta", "CA-AB", 105.0),
    ("new_york", "US-NY", 108.88),
    ("oregon", "US-OR", 100.0),
    ("germany", "DE", 119.0),
    ("unknown", "XX", 100.0),
]

for _name, _region, _expected in REGION_TOTAL_CASES:
    def _test(self, region=_region, expected=_expected):
        cart = Cart(region)
        cart.add("XX-1", 4, unit_price=25.0)
        self.assertEqual(cart.total, expected)
    _test.__name__ = f"test_total_in_{_name}"
    setattr(CartTest, _test.__name__, _test)


class BulkCartTest(unittest.TestCase):
    def test_many_lines(self):
        cart = Cart("US-TX")
        for i in range(40):
            cart.add(f"BULK-{i:03d}", i % 3 + 1, unit_price=1.25 * (i + 1))
        self.assertEqual(len(cart.lines()), 40)
        self.assertEqual(cart.subtotal, 2032.5)

    def test_summary_of_many_lines(self):
        cart = Cart("CA-BC")
        for i in range(25):
            cart.add(f"BULK-{i:03d}", 2, unit_price=4.0)
        self.assertEqual(cart.summary()["total"], "$224.00")


if __name__ == "__main__":
    unittest.main()
