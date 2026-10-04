import unittest

from wisp.exceptions import BadRequest
from wisp.request import Request


class RequestTests(unittest.TestCase):
    def test_target_is_split(self):
        req = Request("get", "/books/1?format=json&x=1")
        self.assertEqual(req.method, "GET")
        self.assertEqual(req.path, "/books/1")
        self.assertEqual(req.query_string, "format=json&x=1")

    def test_no_query(self):
        req = Request("GET", "/books")
        self.assertEqual(req.query_string, "")

    def test_only_first_question_mark_splits(self):
        req = Request("GET", "/a?b=?c")
        self.assertEqual(req.path, "/a")
        self.assertEqual(req.query_string, "b=?c")

    def test_headers_case_insensitive(self):
        req = Request("GET", "/", headers={"X-Thing": "1"})
        self.assertEqual(req.headers["x-thing"], "1")

    def test_content_type(self):
        req = Request("POST", "/", headers={"Content-Type": "Application/JSON; charset=utf-8"})
        self.assertEqual(req.content_type, "application/json")

    def test_json(self):
        req = Request("POST", "/", headers={"Content-Type": "application/json"}, body=b'{"a": [1, 2]}')
        self.assertEqual(req.json(), {"a": [1, 2]})

    def test_json_errors(self):
        with self.assertRaises(BadRequest):
            Request("POST", "/", body=b"{}").json()
        with self.assertRaises(BadRequest):
            Request("POST", "/", headers={"Content-Type": "application/json"}, body=b"{").json()

    def test_form(self):
        req = Request(
            "POST",
            "/",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            body=b"title=Dune&tag=sf&tag=classic",
        )
        self.assertEqual(req.form.get("title"), "Dune")
        self.assertEqual(req.form.getall("tag"), ["sf", "classic"])

    def test_cookies(self):
        req = Request("GET", "/", headers={"Cookie": "session=abc; theme=dark"})
        self.assertEqual(req.cookies, {"session": "abc", "theme": "dark"})

    def test_query_get(self):
        req = Request("GET", "/search?q=dune&page=2")
        self.assertEqual(req.query.get("q"), "dune")
        self.assertEqual(req.query.get("missing", "x"), "x")


if __name__ == "__main__":
    unittest.main()
