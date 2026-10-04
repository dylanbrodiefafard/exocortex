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


    def test_trailing_slashes(self):
        self.assertEqual(self.client.get("/books/42/").json()["title"], "The Hitchhiker's Guide to the Galaxy")
        self.assertEqual(self.client.get("/books/42/reviews/").json()["book_id"], 42)
        self.assertEqual(self.client.get("/authors/Frank%20Herbert/").status, 200)
        self.assertIn("Shipping", self.client.get("/help/shipping/").text)

    def test_author_with_accent(self):
        r = self.client.get("/authors/Andr%C3%A9%20Gide")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json()["author"], "André Gide")

    def test_tag_with_encoded_slash(self):
        self.assertEqual(self.client.get("/tags/ac%2Fdc").json(), {"tag": "ac/dc", "books": [8]})

    def test_tag_with_plus(self):
        self.assertEqual(self.client.get("/tags/c++").json(), {"tag": "c++", "books": [7]})
        self.assertEqual(self.client.get("/tags/c%2B%2B").json(), {"tag": "c++", "books": [7]})

    def ids(self, target):
        r = self.client.get(target)
        self.assertEqual(r.status, 200, r.text)
        return [b["id"] for b in r.json()["results"]]

    def test_search_all(self):
        r = self.client.get("/search").json()
        self.assertEqual(r["count"], 9)
        self.assertEqual(r["query"], "")
        self.assertEqual(r["tags"], [])

    def test_search_text(self):
        self.assertEqual(self.ids("/search?q=left+hand"), [2])
        self.assertEqual(self.ids("/search?q=le%20guin"), [3, 2])
        self.assertEqual(self.ids("/search?q=mis%C3%A9rables"), [4])
        self.assertEqual(self.ids("/search?q=c%2B%2B"), [7])

    def test_search_tags(self):
        self.assertEqual(self.ids("/search?tag=sf&tag=classic"), [1, 2])
        self.assertEqual(self.ids("/search?tag=sf&tag=classic&sort=year"), [1, 2])
        self.assertEqual(self.ids("/search?tag=ac%2Fdc"), [8])
        self.assertEqual(self.client.get("/search?tag=sf&tag=classic").json()["tags"], ["sf", "classic"])

    def test_search_sort_and_limit(self):
        self.assertEqual(self.ids("/search?tag=sf&sort=year&limit=2"), [1, 2])
        self.assertEqual(self.ids("/search?tag=classic&sort=year&limit=1&limit=5"), [4])
        self.assertEqual(self.client.get("/search?limit=lots").status, 400)
        self.assertEqual(self.client.get("/search?sort=price").status, 400)

if __name__ == "__main__":
    unittest.main()
