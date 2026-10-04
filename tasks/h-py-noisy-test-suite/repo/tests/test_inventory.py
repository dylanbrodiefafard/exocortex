import unittest

from storefront import report
from storefront.inventory import Inventory, OutOfStock


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.inv = Inventory(low_stock_threshold=3)
        self.inv.receive("HW-1001", 10)
        self.inv.receive("KT-4002", 4)

    def test_receive_accumulates(self):
        self.inv.receive("HW-1001", 5)
        self.assertEqual(self.inv.on_hand("HW-1001"), 15)

    def test_receive_rejects_zero(self):
        with self.assertRaises(ValueError):
            self.inv.receive("HW-1001", 0)

    def test_unknown_sku_has_nothing(self):
        self.assertEqual(self.inv.available("NOPE-1"), 0)

    def test_reserve_reduces_available(self):
        self.assertEqual(self.inv.reserve("HW-1001", 4), 6)
        self.assertEqual(self.inv.on_hand("HW-1001"), 10)
        self.assertEqual(self.inv.reserved("HW-1001"), 4)

    def test_reserve_everything(self):
        self.assertEqual(self.inv.reserve("KT-4002", 4), 0)

    def test_over_reserve_raises(self):
        with self.assertRaises(OutOfStock) as ctx:
            self.inv.reserve("KT-4002", 5)
        self.assertEqual((ctx.exception.requested, ctx.exception.available), (5, 4))

    def test_over_reserve_leaves_state(self):
        with self.assertRaises(OutOfStock):
            self.inv.reserve("KT-4002", 9)
        self.assertEqual(self.inv.reserved("KT-4002"), 0)

    def test_release(self):
        self.inv.reserve("HW-1001", 4)
        self.inv.release("HW-1001", 3)
        self.assertEqual(self.inv.available("HW-1001"), 9)

    def test_release_too_much(self):
        self.inv.reserve("HW-1001", 1)
        with self.assertRaises(ValueError):
            self.inv.release("HW-1001", 2)

    def test_commit(self):
        self.inv.reserve("HW-1001", 4)
        self.inv.commit("HW-1001", 4)
        self.assertEqual(self.inv.snapshot()["HW-1001"], (6, 0))

    def test_try_reserve_success(self):
        self.assertEqual(self.inv.try_reserve("HW-1001", 2), 8)

    def test_try_reserve_failure_returns_none(self):
        self.assertIsNone(self.inv.try_reserve("KT-4002", 50))

    def test_try_reserve_many_failures(self):
        results = [self.inv.try_reserve("KT-4002", n) for n in range(1, 12)]
        self.assertEqual(results[:4], [3, 1, None, None])
        self.assertEqual(results.count(None), 9)

    def test_snapshot_sorted(self):
        self.assertEqual(list(self.inv.snapshot()), ["HW-1001", "KT-4002"])

    def test_dump_prints_every_sku(self):
        for i in range(25):
            self.inv.receive(f"BULK-{i:03d}", i + 1)
        snapshot = report.inventory_dump(self.inv)
        self.assertEqual(len(snapshot), 27)

    def test_low_stock_threshold_boundary(self):
        self.inv.reserve("HW-1001", 6)
        self.assertEqual(self.inv.reserve("HW-1001", 1), 3)


class ReservationScenarioTest(unittest.TestCase):
    def test_reserve_in_small_steps(self):
        inv = Inventory(low_stock_threshold=10)
        inv.receive("GD-3001", 30)
        remaining = [inv.reserve("GD-3001", 1) for _ in range(30)]
        self.assertEqual(remaining, list(range(29, -1, -1)))

    def test_release_and_rereserve(self):
        inv = Inventory()
        inv.receive("GD-3002", 2)
        for _ in range(20):
            inv.reserve("GD-3002", 2)
            inv.release("GD-3002", 2)
        self.assertEqual(inv.available("GD-3002"), 2)

    def test_commit_partial(self):
        inv = Inventory()
        inv.receive("GD-3003", 10)
        inv.reserve("GD-3003", 5)
        inv.commit("GD-3003", 2)
        self.assertEqual(inv.snapshot()["GD-3003"], (8, 3))


if __name__ == "__main__":
    unittest.main()
