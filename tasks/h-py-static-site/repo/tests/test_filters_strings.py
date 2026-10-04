import unittest

from tests.support import render


class StringFilterTests(unittest.TestCase):
    def test_case(self):
        self.assertEqual(render("{{ x | upper }} {{ x | lower }} {{ x | title }}", x="hello World"), "HELLO WORLD hello world Hello World")

    def test_trim_and_replace(self):
        self.assertEqual(render("[{{ x | trim | replace:'a','o' }}]", x="  banana "), "[bonono]")

    def test_default(self):
        self.assertEqual(render("{{ x | default:'none' }}", x=""), "none")
        self.assertEqual(render("{{ x | default:'none' }}", x=[]), "none")
        self.assertEqual(render("{{ x | default:'none' }}", x=0), "0")
        self.assertEqual(render("{{ missing | default:other }}", other="o"), "o")

    def test_truncate(self):
        self.assertEqual(render("{{ x | truncate:12 }}", x="the quick brown fox"), "the quick...")
        self.assertEqual(render("{{ x | truncatewords:2 }}", x="Hello, world, again"), "Hello, world ...")
        self.assertEqual(render("{{ x | truncatewords:'3' }}", x="a b c d"), "a b c ...")

    def test_truncate_arguments_checked(self):
        from inkwell.errors import TemplateError

        with self.assertRaises(TemplateError) as ctx:
            render("{{ x | truncatewords:0 }}", x="a")
        self.assertEqual(str(ctx.exception), "page.html:1: filter 'truncatewords': expected an integer >= 1, got '0'")
        with self.assertRaises(TemplateError) as ctx:
            render("{{ x | truncate:2 }}", x="a")
        self.assertEqual(str(ctx.exception), "page.html:1: filter 'truncate': expected an integer >= 4, got '2'")

    def test_counts(self):
        self.assertEqual(render("{{ x | wordcount }}", x="a b  c"), "3")
        self.assertEqual(render("{{ x | readingtime }} {{ x | readingtime:2 }}", x="w w w w w"), "1 3")

    def test_slugify(self):
        self.assertEqual(render("{{ x | slugify }}", x="Tide Pools: Day 1"), "tide-pools-day-1")

    def test_output_is_escaped(self):
        self.assertEqual(render("{{ x | upper }}", x="<b>"), "&lt;B&gt;")


if __name__ == "__main__":
    unittest.main()
