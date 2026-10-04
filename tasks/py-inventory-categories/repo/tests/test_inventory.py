import unittest

from inventory import Store
from inventory.report import summarize


def sample_store():
    store = Store()
    store.add("A1", "apple", 10, 0.5, category="fruit")
    store.add("B2", "banana", 4, 0.25, category="fruit")
    store.add("H3", "hammer", 1, 12.0, category="tools")
    store.add("X9", "mystery box", 2, 3.0)
    return store


class ExistingBehaviourTest(unittest.TestCase):
    def test_add_and_get(self):
        store = Store()
        store.add("A1", "apple", 10, 0.5)
        self.assertEqual(store.get("A1").name, "apple")

    def test_rejects_negative_quantity(self):
        with self.assertRaises(ValueError):
            Store().add("A1", "apple", -1, 0.5)

    def test_rejects_duplicate_sku(self):
        store = Store()
        store.add("A1", "apple", 1, 0.5)
        with self.assertRaises(KeyError):
            store.add("A1", "apple", 1, 0.5)

    def test_summary_totals(self):
        summary = summarize(sample_store())
        self.assertEqual(summary["item_count"], 4)
        self.assertEqual(summary["total_quantity"], 17)
        self.assertEqual(summary["total_value"], 24.0)


class CategoryTest(unittest.TestCase):
    def test_item_records_category(self):
        store = sample_store()
        self.assertEqual(store.get("A1").category, "fruit")
        self.assertEqual(store.get("X9").category, "uncategorized")

    def test_summary_by_category(self):
        self.assertEqual(
            summarize(sample_store())["by_category"],
            {"fruit": 6.0, "tools": 12.0, "uncategorized": 6.0},
        )

    def test_empty_store(self):
        self.assertEqual(summarize(Store())["by_category"], {})


if __name__ == "__main__":
    unittest.main()
