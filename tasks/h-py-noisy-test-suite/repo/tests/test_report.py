import unittest

from storefront import report

ROWS = [
    ("Claw Hammer", 12, 299.88),
    ("Cordless Drill 18V with Two Batteries and Charger", 3, 387.0),
    ("Paring Knife", 40, 760.0),
    ("Garden Hose 50ft", 7, 279.65),
]


class ReportTest(unittest.TestCase):
    maxDiff = None

    def test_table_layout(self):
        table = report.sales_table(ROWS, width=30)
        lines = table.splitlines()
        self.assertEqual(len(lines), len(ROWS) + 4)
        self.assertTrue(lines[0].startswith("product"))
        self.assertEqual(len({len(line) for line in lines}), 1)

    def test_long_names_truncated(self):
        table = report.sales_table(ROWS, width=30)
        self.assertIn("Cordless Drill 18V with Two…", table)

    def test_totals(self):
        last = report.sales_table(ROWS).splitlines()[-1]
        self.assertTrue(last.startswith("TOTAL"))
        self.assertIn("62", last)
        self.assertIn("$1,726.53", last)

    def test_print_sales(self):
        table = report.print_sales(ROWS)
        self.assertIn("$760.00", table)

    def test_print_large_report(self):
        rows = [(f"Product number {i} with a fairly long descriptive name", i, i * 10.5) for i in range(1, 60)]
        table = report.print_sales(rows, width=50)
        self.assertIn("$18,585.00", table)

    def test_empty(self):
        table = report.sales_table([])
        self.assertIn("$0.00", table.splitlines()[-1])


if __name__ == "__main__":
    unittest.main()
