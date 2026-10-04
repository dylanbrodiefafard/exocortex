import unittest

from storefront.pagination import MAX_PAGE_SIZE, paginate

ITEMS = [f"item-{i:03d}" for i in range(95)]


class PaginationTest(unittest.TestCase):
    def test_first_page(self):
        page = paginate(ITEMS)
        self.assertEqual(page.items, ITEMS[:20])
        self.assertEqual((page.number, page.pages, page.total), (1, 5, 95))

    def test_last_page_partial(self):
        page = paginate(ITEMS, number=5)
        self.assertEqual(len(page.items), 15)
        self.assertFalse(page.has_next)
        self.assertTrue(page.has_prev)

    def test_past_the_end(self):
        self.assertEqual(paginate(ITEMS, number=9).items, [])

    def test_empty(self):
        page = paginate([])
        self.assertEqual((page.items, page.pages, page.has_next, page.has_prev), ([], 1, False, False))

    def test_exact_multiple(self):
        self.assertEqual(paginate(ITEMS[:40], size=20).pages, 2)

    def test_size_clamped(self):
        page = paginate(list(range(500)), size=1000)
        self.assertEqual(page.size, MAX_PAGE_SIZE)
        self.assertEqual(len(page.items), MAX_PAGE_SIZE)

    def test_rejects_bad_size(self):
        with self.assertRaises(ValueError):
            paginate(ITEMS, size=0)

    def test_rejects_page_zero(self):
        with self.assertRaises(ValueError):
            paginate(ITEMS, number=0)

    def test_walk_all_pages(self):
        seen = []
        number = 1
        while True:
            page = paginate(ITEMS, number=number, size=7)
            seen.extend(page.items)
            if not page.has_next:
                break
            number += 1
        self.assertEqual(seen, ITEMS)

    def test_walk_with_every_size(self):
        for size in range(1, 30):
            with self.subTest(size=size):
                total = sum(len(paginate(ITEMS, n, size).items) for n in range(1, paginate(ITEMS, 1, size).pages + 1))
                self.assertEqual(total, len(ITEMS))

    def test_tuple_input(self):
        self.assertEqual(paginate(tuple(ITEMS), number=2, size=3).items, ITEMS[3:6])

    def test_middle_page_flags(self):
        page = paginate(ITEMS, number=3)
        self.assertTrue(page.has_next and page.has_prev)


if __name__ == "__main__":
    unittest.main()
