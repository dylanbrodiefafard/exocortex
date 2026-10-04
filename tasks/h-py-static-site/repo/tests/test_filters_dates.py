import datetime
import unittest

from inkwell.errors import TemplateError
from tests.support import render

DAY = datetime.date(2024, 3, 2)


class DateFilterTests(unittest.TestCase):
    def test_default_format_from_config(self):
        self.assertEqual(render("{{ d | date }}", d=DAY), "March 02, 2024")
        self.assertEqual(render("{{ d | date }}", config_text="[build]\ndate_format = %d/%m/%Y\n", d=DAY), "02/03/2024")

    def test_explicit_format(self):
        self.assertEqual(render("{{ d | date:'%Y' }}", d=DAY), "2024")

    def test_strings_and_missing(self):
        self.assertEqual(render("{{ d | isodate }}|{{ d | year }}", d="2024-03-02"), "2024-03-02|2024")
        self.assertEqual(render("[{{ d | date }}]", d=None), "[]")

    def test_bad_value(self):
        with self.assertRaises(TemplateError) as ctx:
            render("{{ d | year }}", d="soon")
        self.assertEqual(str(ctx.exception), "page.html:1: filter 'year': expected a date, got 'soon'")


if __name__ == "__main__":
    unittest.main()
