import unittest

from wisp.exceptions import MethodNotAllowed, NotFound
from wisp.routing import Router


def h(name):
    def handler(request, **params):
        return name

    handler.__name__ = name
    return handler


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.router = Router()
        self.router.add("/", h("root"))
        self.router.add("/books", h("books"))
        self.router.add("/books/<name>", h("book_by_name"))
        self.router.add("/books/<int:book_id>", h("book"))
        self.router.add("/books/new", h("new_book"))
        self.router.add("/books/<int:book_id>/reviews", h("reviews"))
        self.router.add("/tags/<slug:tag>", h("tag"))
        self.router.add("/files/<path:name>", h("files"))
        self.router.add("/books", h("create_book"), methods=["POST"])

    def resolve(self, path, method="GET"):
        m = self.router.match(method, path)
        return m.route.name, m.params

    def test_root(self):
        self.assertEqual(self.resolve("/"), ("root", {}))

    def test_static_beats_params_regardless_of_order(self):
        self.assertEqual(self.resolve("/books/new"), ("new_book", {}))

    def test_int_beats_str(self):
        self.assertEqual(self.resolve("/books/12"), ("book", {"book_id": 12}))
        self.assertEqual(self.resolve("/books/dune"), ("book_by_name", {"name": "dune"}))

    def test_nested(self):
        self.assertEqual(self.resolve("/books/3/reviews"), ("reviews", {"book_id": 3}))

    def test_slug(self):
        self.assertEqual(self.resolve("/tags/sci-fi"), ("tag", {"tag": "sci-fi"}))
        with self.assertRaises(NotFound):
            self.resolve("/tags/Sci_Fi")

    def test_path(self):
        self.assertEqual(self.resolve("/files/a/b/c.txt"), ("files", {"name": "a/b/c.txt"}))

    def test_method_dispatch(self):
        self.assertEqual(self.resolve("/books", "POST"), ("create_book", {}))
        self.assertEqual(self.resolve("/books", "HEAD"), ("books", {}))

    def test_method_not_allowed(self):
        with self.assertRaises(MethodNotAllowed) as ctx:
            self.resolve("/books", "DELETE")
        self.assertEqual(ctx.exception.headers["Allow"], "GET, HEAD, POST")

    def test_not_found(self):
        with self.assertRaises(NotFound):
            self.resolve("/nope")
        with self.assertRaises(NotFound):
            self.resolve("/books/3/reviews/extra")

    def test_simple_decoding(self):
        self.assertEqual(self.resolve("/books/war%20and%20peace"), ("book_by_name", {"name": "war and peace"}))

    def test_url_for(self):
        self.assertEqual(self.router.url_for("reviews", book_id=9), "/books/9/reviews")
        with self.assertRaises(KeyError):
            self.router.url_for("missing")

    def test_duplicate_names_rejected(self):
        with self.assertRaises(ValueError):
            self.router.add("/other", h("root"))


    # --- trailing slashes (docs/routing.md, rule 1) ---

    def test_trailing_slash_is_ignored(self):
        self.assertEqual(self.resolve("/books/12/"), ("book", {"book_id": 12}))
        self.assertEqual(self.resolve("/books/3/reviews/"), ("reviews", {"book_id": 3}))
        self.assertEqual(self.resolve("/books/"), ("books", {}))
        self.assertEqual(self.resolve("/books/new/"), ("new_book", {}))
        self.assertEqual(self.resolve("/books/dune/"), ("book_by_name", {"name": "dune"}))
        self.assertEqual(self.resolve("/books/", "POST"), ("create_book", {}))

    def test_trailing_slash_with_path_param(self):
        self.assertEqual(self.resolve("/files/a/b/"), ("files", {"name": "a/b"}))

    def test_root_still_matches_only_root(self):
        self.assertEqual(self.resolve("/"), ("root", {}))
        with self.assertRaises(NotFound):
            self.resolve("/nope/")

    def test_trailing_slash_does_not_fall_through_to_catch_all(self):
        router = Router()
        router.add("/books/<int:book_id>", h("book"))
        router.add("/<path:page>", h("page"))
        m = router.match("GET", "/books/7/")
        self.assertEqual((m.route.name, m.params), ("book", {"book_id": 7}))
        m = router.match("GET", "/about/")
        self.assertEqual((m.route.name, m.params), ("page", {"page": "about"}))

    # --- decoding (docs/routing.md, rule 2) ---

    def test_utf8_decoding(self):
        self.assertEqual(self.resolve("/books/Andr%C3%A9%20Gide"), ("book_by_name", {"name": "André Gide"}))
        self.assertEqual(self.resolve("/books/%E2%82%AC5"), ("book_by_name", {"name": "€5"}))

    def test_encoded_slash_is_part_of_value(self):
        self.assertEqual(self.resolve("/books/AC%2FDC"), ("book_by_name", {"name": "AC/DC"}))
        self.assertEqual(self.resolve("/books/AC%2fDC/"), ("book_by_name", {"name": "AC/DC"}))
        self.assertEqual(self.resolve("/files/a%2Fb/c%20d.txt"), ("files", {"name": "a/b/c d.txt"}))

    def test_plus_is_literal_in_paths(self):
        self.assertEqual(self.resolve("/books/c++"), ("book_by_name", {"name": "c++"}))
        self.assertEqual(self.resolve("/books/c%2B%2B"), ("book_by_name", {"name": "c++"}))
        self.assertEqual(self.resolve("/files/x+y/z"), ("files", {"name": "x+y/z"}))

    def test_converters_see_decoded_value(self):
        self.assertEqual(self.resolve("/books/%34%32"), ("book", {"book_id": 42}))
        self.assertEqual(self.resolve("/tags/sci%2Dfi"), ("tag", {"tag": "sci-fi"}))

    def test_decoded_exactly_once(self):
        self.assertEqual(self.resolve("/books/100%2525"), ("book_by_name", {"name": "100%25"}))

    def test_malformed_escapes_kept(self):
        self.assertEqual(self.resolve("/books/100%"), ("book_by_name", {"name": "100%"}))
        self.assertEqual(self.resolve("/books/%zz"), ("book_by_name", {"name": "%zz"}))

if __name__ == "__main__":
    unittest.main()
