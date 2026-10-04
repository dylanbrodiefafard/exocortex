import unittest

from pagination import page_count, paginate


class PaginateTest(unittest.TestCase):
    def test_first_page(self):
        self.assertEqual(paginate(list(range(10)), 1, 3), [0, 1, 2])

    def test_middle_page(self):
        self.assertEqual(paginate(list(range(10)), 2, 3), [3, 4, 5])

    def test_last_partial_page(self):
        self.assertEqual(paginate(list(range(10)), 4, 3), [9])

    def test_past_the_end(self):
        self.assertEqual(paginate(list(range(10)), 5, 3), [])

    def test_rejects_zero_page(self):
        with self.assertRaises(ValueError):
            paginate([1], 0, 3)


class PageCountTest(unittest.TestCase):
    def test_exact(self):
        self.assertEqual(page_count(9, 3), 3)

    def test_partial(self):
        self.assertEqual(page_count(10, 3), 4)

    def test_empty(self):
        self.assertEqual(page_count(0, 3), 0)


if __name__ == "__main__":
    unittest.main()
