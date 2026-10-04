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


if __name__ == "__main__":
    unittest.main()
