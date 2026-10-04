import tempfile
import unittest
from pathlib import Path

from wisp.templating import Template, TemplateError, TemplateLoader
from wisp.templating.filters import FILTERS, Markup, escape
from wisp.utils import slugify, truncate


class TemplateTests(unittest.TestCase):
    def test_expressions_are_escaped(self):
        self.assertEqual(Template("<p>{{ x }}</p>").render(x="<b>&"), "<p>&lt;b&gt;&amp;</p>")

    def test_safe_filter(self):
        self.assertEqual(Template("{{ x|safe }}").render(x="<b>"), "<b>")

    def test_dotted_lookup(self):
        class Obj:
            name = "obj"

        self.assertEqual(Template("{{ a.b }} {{ o.name }}").render(a={"b": 1}, o=Obj()), "1 obj")

    def test_for_loop(self):
        t = Template("{% for n in nums %}{{ n }}{% if loop.last %}.{% else %},{% endif %}{% endfor %}")
        self.assertEqual(t.render(nums=[1, 2, 3]), "1,2,3.")

    def test_if_not(self):
        t = Template("{% if not items %}empty{% else %}full{% endif %}")
        self.assertEqual(t.render(items=[]), "empty")
        self.assertEqual(t.render(items=[1]), "full")

    def test_filters_with_args(self):
        t = Template('{{ title|truncate:"8" }} {{ missing|default:"n/a" }} {{ tags|join:"/" }}')
        self.assertEqual(t.render(title="A long title", missing=None, tags=["a", "b"]), "A lon... n/a a/b")

    def test_errors(self):
        for source in ("{% for x %}{% endfor %}", "{% if a %}", "{% bogus %}", "{{ x|nope }}", "{% endfor %}"):
            with self.subTest(source=source), self.assertRaises(TemplateError):
                Template(source).render(x=1, a=1)
        with self.assertRaises(TemplateError):
            Template("{{ undefined }}").render()

    def test_loader(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "hi.html").write_text("Hi {{ name }}", encoding="utf-8")
            loader = TemplateLoader(tmp)
            self.assertEqual(loader.render("hi.html", name="Ann"), "Hi Ann")
            self.assertIs(loader.get("hi.html"), loader.get("hi.html"))
            with self.assertRaises(TemplateError):
                loader.get("nope.html")
            with self.assertRaises(TemplateError):
                loader.get("../etc/passwd")


class FilterTests(unittest.TestCase):
    def test_escape_once(self):
        once = escape("<a>")
        self.assertIsInstance(once, Markup)
        self.assertEqual(escape(once), "&lt;a&gt;")

    def test_simple_filters(self):
        self.assertEqual(FILTERS["upper"]("ab"), "AB")
        self.assertEqual(FILTERS["title"]("le guin"), "Le Guin")
        self.assertEqual(FILTERS["length"]([1, 2]), 2)
        self.assertEqual(FILTERS["default"]("", "x"), "x")
        self.assertEqual(FILTERS["default"]("y", "x"), "y")

    def test_slugify(self):
        self.assertEqual(slugify("Les Misérables, Tome 1"), "les-miserables-tome-1")
        self.assertEqual(FILTERS["slugify"]("  Hello  World "), "hello-world")

    def test_truncate(self):
        self.assertEqual(truncate("short", 10), "short")
        self.assertEqual(truncate("a long sentence", 9), "a long...")
        self.assertEqual(truncate("abcdef", 2), "..")


if __name__ == "__main__":
    unittest.main()
