import unittest

from examples.bookshop import create_app
from wisp.testing import TestClient


class BookshopTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app())

    def test_index(self):
        r = self.client.get("/")
        self.assertEqual(r.status, 200)
        self.assertIn("<h1>Bookshop</h1>", r.text)
        self.assertIn("Let There Be Rock", r.text)

    def test_list(self):
        books = self.client.get("/books").json()
        self.assertEqual(books[0]["title"], "Dune")
        self.assertEqual(len(books), 9)

    def test_detail_and_reviews(self):
        self.assertEqual(self.client.get("/books/42").json()["author"], "Douglas Adams")
        self.assertEqual(len(self.client.get("/books/42/reviews").json()["reviews"]), 2)
        self.assertEqual(self.client.get("/books/999").status, 404)

    def test_new_form_is_not_a_book_id(self):
        self.assertIn("<form", self.client.get("/books/new").text)

    def test_create(self):
        r = self.client.post("/books", form={"title": "Solaris", "author": "Stanisław Lem", "year": "1961"})
        self.assertEqual(r.status, 303)
        self.assertEqual(r.headers["Location"], "/books/43")
        self.assertEqual(self.client.get("/books/43").json()["title"], "Solaris")
        self.assertEqual(self.client.post("/books", form={"title": "x"}).status, 400)

    def test_author(self):
        r = self.client.get("/authors/Frank%20Herbert")
        self.assertEqual([b["id"] for b in r.json()["books"]], [1])
        self.assertEqual(self.client.get("/authors/Nobody").status, 404)

    def test_tags(self):
        self.assertEqual(self.client.get("/tags/cyberpunk").json(), {"tag": "cyberpunk", "books": [6]})

    def test_static(self):
        r = self.client.get("/static/css/site.css")
        self.assertEqual(r.headers["Content-Type"], "text/css")
        self.assertEqual(self.client.get("/static/css/nope.css").status, 404)

    def test_pages(self):
        self.assertIn("Shipping", self.client.get("/help/shipping").text)
        self.assertEqual(self.client.get("/nothing/here").status, 404)

    def test_cors(self):
        r = self.client.get("/books", headers={"Origin": "https://shop.example"})
        self.assertEqual(r.headers["Access-Control-Allow-Origin"], "https://shop.example")

    def test_search(self):
        r = self.client.get("/search?q=dune")
        self.assertEqual(r.status, 200)
        self.assertEqual([b["id"] for b in r.json()["results"]], [1])


if __name__ == "__main__":
    unittest.main()
