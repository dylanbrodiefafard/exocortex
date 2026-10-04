import unittest

from wisp.routing import Route, RoutePatternError
from wisp.routing.converters import CONVERTERS


def handler(request):
    return None


class RouteTests(unittest.TestCase):
    def test_static_route(self):
        route = Route("/about/team", handler)
        self.assertEqual(route.match_segments(["about", "team"]), {})
        self.assertIsNone(route.match_segments(["about"]))
        self.assertIsNone(route.match_segments(["about", "team", "x"]))

    def test_params_are_captured_raw(self):
        route = Route("/books/<int:book_id>/reviews", handler)
        self.assertEqual(route.match_segments(["books", "5", "reviews"]), {"book_id": "5"})

    def test_path_param_takes_the_rest(self):
        route = Route("/files/<path:name>", handler)
        self.assertEqual(route.match_segments(["files", "a", "b.txt"]), {"name": "a/b.txt"})
        self.assertIsNone(route.match_segments(["files"]))

    def test_root(self):
        route = Route("/", handler)
        self.assertEqual(route.segments, [])
        self.assertEqual(route.match_segments([]), {})

    def test_get_implies_head(self):
        self.assertEqual(Route("/", handler).methods, frozenset({"GET", "HEAD"}))
        self.assertEqual(Route("/", handler, frozenset({"post"})).methods, frozenset({"POST"}))

    def test_name_defaults_to_handler_name(self):
        self.assertEqual(Route("/", handler).name, "handler")

    def test_bad_patterns(self):
        for pattern in ("no-slash", "/a//b", "/<int:>", "/<bogus:x>", "/<a>/<a>", "/<path:p>/tail"):
            with self.subTest(pattern=pattern), self.assertRaises(RoutePatternError):
                Route(pattern, handler)

    def test_build(self):
        self.assertEqual(Route("/books/<int:book_id>", handler).build(book_id=3), "/books/3")
        self.assertEqual(Route("/authors/<name>", handler).build(name="Le Guin"), "/authors/Le%20Guin")
        self.assertEqual(Route("/static/<path:f>", handler).build(f="css/a b.css"), "/static/css/a%20b.css")
        with self.assertRaises(KeyError):
            Route("/books/<int:book_id>", handler).build()

    def test_specificity_key(self):
        static = Route("/books/new", handler)
        typed = Route("/books/<int:book_id>", handler)
        loose = Route("/books/<name>", handler)
        self.assertLess(static.sort_key, typed.sort_key)
        self.assertLess(typed.sort_key, loose.sort_key)


class ConverterTests(unittest.TestCase):
    def test_int(self):
        conv = CONVERTERS["int"]
        self.assertTrue(conv.accepts("42"))
        self.assertFalse(conv.accepts("-1"))
        self.assertFalse(conv.accepts("4x"))
        self.assertEqual(conv.to_python("007"), 7)

    def test_slug(self):
        conv = CONVERTERS["slug"]
        self.assertTrue(conv.accepts("hello-world-2"))
        self.assertFalse(conv.accepts("Hello"))
        self.assertFalse(conv.accepts("a--b"))
        self.assertFalse(conv.accepts("-a"))

    def test_str_rejects_empty(self):
        conv = CONVERTERS["str"]
        self.assertTrue(conv.accepts("anything at all"))
        self.assertFalse(conv.accepts(""))

    def test_path_accepts_slashes(self):
        conv = CONVERTERS["path"]
        self.assertTrue(conv.multi_segment)
        self.assertTrue(conv.accepts("a/b/c.txt"))

    def test_priorities_are_ordered(self):
        order = [CONVERTERS[n].priority for n in ("int", "slug", "str", "path")]
        self.assertEqual(order, sorted(order))


if __name__ == "__main__":
    unittest.main()
