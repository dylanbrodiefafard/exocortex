import unittest

from storefront.catalog import Catalog, Product

PRODUCTS = [
    ("HW-1001", "Claw Hammer", 24.99, 11.0, ["Tools", "hand tools", "steel"]),
    ("HW-1002", "Ball-peen Hammer", 27.5, 12.0, ["tools", "Hand Tools"]),
    ("HW-2001", "Cordless Drill 18V", 129.0, 70.0, ["tools", "power tools", "cordless"]),
    ("HW-2002", "Impact Driver", 149.0, 82.5, ["tools", "power tools"]),
    ("GD-3001", "Garden Hose 50ft", 39.95, 15.0, ["garden", "outdoor", "watering"]),
    ("GD-3002", "Hose Nozzle", 9.5, 2.0, ["garden", "watering", " outdoor "]),
    ("GD-3003", "Pruning Shears", 18.0, 7.25, ["garden", "hand tools"]),
    ("KT-4001", "Chef Knife 8in", 89.0, 30.0, ["kitchen", "knives", "steel"]),
    ("KT-4002", "Paring Knife", 19.0, 6.0, ["kitchen", "knives"]),
    ("KT-4003", "Cutting Board", 34.0, 9.0, ["kitchen", "wood", "Wood"]),
    ("KT-4004", "Cast Iron Skillet", 45.0, 18.0, ["kitchen", "cookware", "iron"]),
    ("PT-5001", "Dog Leash", 14.0, 4.0, ["pets", "dogs"]),
    ("PT-5002", "Cat Tree", 99.0, 120.0, ["pets", "cats", "clearance"]),
]


def build_catalog():
    catalog = Catalog()
    for sku, name, price, cost, tags in PRODUCTS:
        catalog.add(Product(sku, name, price, cost, tags))
    return catalog


class ProductTest(unittest.TestCase):
    def test_rejects_negative_price(self):
        with self.assertRaises(ValueError):
            Product("XX-001", "Broken", -1.0)

    def test_margin(self):
        self.assertAlmostEqual(Product("XX-002", "Widget", 10.0, 6.0).margin, 0.4)

    def test_margin_of_free_item(self):
        self.assertEqual(Product("XX-003", "Freebie", 0.0, 1.0).margin, 0.0)

    def test_label(self):
        self.assertEqual(Product("XX-004", "Widget", 1234.5).label(), "Widget ($1,234.50)")

    def test_below_cost_still_created(self):
        product = Product("XX-005", "Loss Leader", 5.0, 9.0)
        self.assertLess(product.margin, 0)

    def test_products_do_not_share_tags(self):
        first = Product("XX-006", "Red Mug", 8.0, tags=["Mugs", "red"])
        second = Product("XX-007", "Blue Mug", 8.0, tags=["mugs", "Blue"])
        self.assertEqual(first.tags, ["mugs", "red"])
        self.assertEqual(second.tags, ["mugs", "blue"])


class CatalogTest(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.catalog = build_catalog()

    def test_len(self):
        self.assertEqual(len(self.catalog), len(PRODUCTS))

    def test_iteration_sorted_by_sku(self):
        skus = [p.sku for p in self.catalog]
        self.assertEqual(skus, sorted(skus))

    def test_duplicate_sku_rejected(self):
        with self.assertRaises(KeyError):
            self.catalog.add(Product("HW-1001", "Another Hammer", 1.0))

    def test_get(self):
        self.assertEqual(self.catalog.get("KT-4002").name, "Paring Knife")

    def test_get_missing(self):
        with self.assertRaises(KeyError):
            self.catalog.get("NOPE-1")

    def test_find_is_deprecated(self):
        with self.assertWarns(DeprecationWarning):
            found = self.catalog.find("knife")
        self.assertEqual([p.sku for p in found], ["KT-4001", "KT-4002"])

    def test_legacy_find_calls(self):
        for word in ("hammer", "hose", "knife", "cat", "drill", "board", "leash"):
            with self.subTest(word=word):
                self.assertTrue(self.catalog.find(word))

    def test_search_everything(self):
        self.assertEqual(len(self.catalog.search()), len(PRODUCTS))

    def test_search_max_price_inclusive(self):
        self.assertEqual([p.sku for p in self.catalog.search(max_price=14.0)], ["GD-3002", "PT-5001"])

    def test_search_text_and_price(self):
        self.assertEqual([p.sku for p in self.catalog.search(text="hammer", max_price=25)], ["HW-1001"])

    def test_search_no_match(self):
        self.assertEqual(self.catalog.search(text="chainsaw"), [])


TEXT_SEARCH_CASES = [
    ("hammer", "hammer", ["HW-1001", "HW-1002"]),
    ("case_insensitive", "HOSE", ["GD-3001", "GD-3002"]),
    ("knife", "knife", ["KT-4001", "KT-4002"]),
    ("substring", "iron", ["KT-4004"]),
    ("drill", "drill", ["HW-2001"]),
    ("tree", "tree", ["PT-5002"]),
    ("space", "cast iron", ["KT-4004"]),
]

for _name, _text, _expected in TEXT_SEARCH_CASES:
    def _test(self, text=_text, expected=_expected):
        self.assertEqual([p.sku for p in self.catalog.search(text=text)], expected)
    _test.__name__ = f"test_text_search_{_name}"
    setattr(CatalogTest, _test.__name__, _test)


class TagIsolationTest(unittest.TestCase):
    def setUp(self):
        self.catalog = build_catalog()

    def test_product_without_tags_has_none(self):
        Product("XX-010", "Tagged", 1.0, tags=["a", "b"])
        self.assertEqual(Product("XX-011", "Plain", 1.0).tags, [])

    def test_tags_normalized_per_product(self):
        self.assertEqual(self.catalog.get("KT-4003").tags, ["kitchen", "wood"])
        self.assertEqual(self.catalog.get("GD-3002").tags, ["garden", "watering", "outdoor"])

    def test_search_by_tag(self):
        self.assertEqual([p.sku for p in self.catalog.search(tags=["power tools"])], ["HW-2001", "HW-2002"])

    def test_consecutive_tag_searches_are_independent(self):
        self.assertEqual([p.sku for p in self.catalog.search(tags=["steel"])], ["HW-1001", "KT-4001"])
        self.assertEqual([p.sku for p in self.catalog.search(tags=["Knives"])], ["KT-4001", "KT-4002"])
        self.assertEqual([p.sku for p in self.catalog.search(tags=[" Watering "])], ["GD-3001", "GD-3002"])

    def test_search_tags_and_text(self):
        self.assertEqual([p.sku for p in self.catalog.search(text="hose", tags=["outdoor"])], ["GD-3001", "GD-3002"])

    def test_normalize_tags_returns_fresh_list(self):
        from storefront.catalog import normalize_tags

        first = normalize_tags(["A", "a", " b "])
        second = normalize_tags(["c"])
        self.assertEqual(first, ["a", "b"])
        self.assertEqual(second, ["c"])

    def test_normalize_tags_into_existing(self):
        from storefront.catalog import normalize_tags

        existing = ["x"]
        self.assertIs(normalize_tags(["X", "y"], into=existing), existing)
        self.assertEqual(existing, ["x", "y"])


if __name__ == "__main__":
    unittest.main()
