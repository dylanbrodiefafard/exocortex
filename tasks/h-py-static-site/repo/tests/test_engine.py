import unittest

from inkwell.errors import TemplateError
from inkwell.text.html import Markup
from tests.support import make_env, render


class OutputTests(unittest.TestCase):
    def test_variables_and_escaping(self):
        self.assertEqual(render("<{{ x }}>", x="a&b"), "<a&amp;b>")
        self.assertEqual(render("{{ x }}", x=Markup("<b>")), "<b>")
        self.assertEqual(render("[{{ missing.deep }}]"), "[]")

    def test_paths(self):
        self.assertEqual(render("{{ a.b.c }}", a={"b": {"c": 3}}), "3")
        self.assertEqual(render("{{ xs.1 }}", xs=["p", "q"]), "q")

    def test_literals(self):
        self.assertEqual(render("{{ 'it' }}|{{ \"q\" }}|{{ 42 }}|{{ true }}|{{ none }}"), "it|q|42|true|")
        self.assertEqual(render("{{ \"a\\\"b\" }}"), "a&quot;b")

    def test_comments_dropped(self):
        self.assertEqual(render("a{# b #}c"), "ac")


class TagTests(unittest.TestCase):
    def test_if_else(self):
        src = "{% if x %}yes{% else %}no{% endif %}"
        self.assertEqual(render(src, x=1), "yes")
        self.assertEqual(render(src, x=0), "no")
        self.assertEqual(render("{% if not x %}none{% endif %}", x=[]), "none")

    def test_for(self):
        src = "{% for i in xs %}{{ loop.index }}={{ i }}{% if not loop.last %},{% endif %}{% empty %}nothing{% endfor %}"
        self.assertEqual(render(src, xs=["a", "b"]), "1=a,2=b")
        self.assertEqual(render(src, xs=[]), "nothing")

    def test_for_scope_restored(self):
        self.assertEqual(render("{% for x in xs %}{% endfor %}{{ x }}", xs=[1], x="outer"), "outer")

    def test_include(self):
        env = make_env({"main.html": "[{% include 'part.html' %}]", "part.html": "{{ name }}"})
        self.assertEqual(env.render("main.html", {"name": "n"}), "[n]")


class ErrorTests(unittest.TestCase):
    def assertTemplateError(self, source, message, **variables):
        with self.assertRaises(TemplateError) as ctx:
            render(source, **variables)
        self.assertEqual(str(ctx.exception), message)

    def test_syntax_errors(self):
        self.assertTemplateError("a\n{{ x", "page.html:2: {{ is not closed with }}")
        self.assertTemplateError("{% if x %}", "page.html:1: {% if %} is not closed")
        self.assertTemplateError("\n\n{% endif %}", "page.html:3: unexpected {% endif %}")
        self.assertTemplateError("{% while %}", "page.html:1: unknown tag 'while'")
        self.assertTemplateError("{{ x | }}", "page.html:1: expected a filter name after |")
        self.assertTemplateError("{{ x y }}", "page.html:1: expected | before 'y'")

    def test_unknown_filter(self):
        self.assertTemplateError("\n{{ x | shout }}", "page.html:2: unknown filter 'shout'")

    def test_arity(self):
        self.assertTemplateError("{{ x | upper:1 }}", "page.html:1: filter 'upper': expected no arguments, got 1")
        self.assertTemplateError("{{ x | truncatewords }}", "page.html:1: filter 'truncatewords': expected 1 argument, got 0")
        self.assertTemplateError("{{ x | replace:'a' }}", "page.html:1: filter 'replace': expected 2 arguments, got 1")
        self.assertTemplateError("{{ x | join:1,2 }}", "page.html:1: filter 'join': expected 0 to 1 arguments, got 2")

    def test_filter_errors_get_location(self):
        self.assertTemplateError(
            "\n\n{{ x | truncatewords:'ten' }}",
            "page.html:3: filter 'truncatewords': expected an integer, got 'ten'",
            x="a b",
        )

    def test_missing_include(self):
        env = make_env({"main.html": "\n{% include 'nope.html' %}"})
        with self.assertRaises(TemplateError) as ctx:
            env.render("main.html")
        self.assertEqual(str(ctx.exception), "main.html:2: template 'nope.html' not found")

    def test_recursive_include(self):
        env = make_env({"loop.html": "{% include 'loop.html' %}"})
        with self.assertRaises(TemplateError) as ctx:
            env.render("loop.html")
        self.assertIn("nested more than 10 deep", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
