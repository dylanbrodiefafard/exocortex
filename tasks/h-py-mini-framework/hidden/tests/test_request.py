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


    def test_query_repeated_values(self):
        q = Request("GET", "/s?tag=sf&q=x&tag=classic&tag=sf").query
        self.assertEqual(q.getlist("tag"), ["sf", "classic", "sf"])
        self.assertEqual(q.get("tag"), "sf")
        self.assertEqual(q["tag"], "sf")
        self.assertEqual(q.getlist("q"), ["x"])

    def test_query_first_value_wins(self):
        q = Request("GET", "/s?page=1&page=2").query
        self.assertEqual(q.get("page"), "1")
        self.assertEqual(q["page"], "1")

    def test_query_missing(self):
        q = Request("GET", "/s?a=1").query
        self.assertIsNone(q.get("b"))
        self.assertEqual(q.get("b", "fallback"), "fallback")
        self.assertEqual(q.getlist("b"), [])
        self.assertIn("a", q)
        self.assertNotIn("b", q)
        with self.assertRaises(KeyError):
            q["b"]

    def test_query_absent(self):
        for target in ("/s", "/s?"):
            with self.subTest(target=target):
                q = Request("GET", target).query
                self.assertIsNone(q.get("a"))
                self.assertEqual(q.getlist("a"), [])

    def test_query_plus_and_percent(self):
        q = Request("GET", "/s?q=left+hand&op=1%2B1&sp=a%20b").query
        self.assertEqual(q.get("q"), "left hand")
        self.assertEqual(q.get("op"), "1+1")
        self.assertEqual(q.get("sp"), "a b")

    def test_query_utf8(self):
        q = Request("GET", "/s?q=caf%C3%A9&city=K%C3%B8benhavn&sym=%E2%82%AC").query
        self.assertEqual(q.get("q"), "café")
        self.assertEqual(q.get("city"), "København")
        self.assertEqual(q.get("sym"), "€")

    def test_query_names_are_decoded(self):
        q = Request("GET", "/s?my+key=1&caf%C3%A9=2&a%5B%5D=3").query
        self.assertEqual(q.get("my key"), "1")
        self.assertEqual(q.get("café"), "2")
        self.assertEqual(q.getlist("a[]"), ["3"])

    def test_query_split_before_decoding(self):
        q = Request("GET", "/s?x=1%262&y=a%3Db&z=a=b").query
        self.assertEqual(q.get("x"), "1&2")
        self.assertEqual(q.get("y"), "a=b")
        self.assertEqual(q.get("z"), "a=b")
        self.assertNotIn("2", q)

    def test_query_blank_values_and_empty_pairs(self):
        q = Request("GET", "/s?&&flag&empty=&a=1&").query
        self.assertEqual(q.get("flag"), "")
        self.assertEqual(q.get("empty"), "")
        self.assertIn("flag", q)
        self.assertEqual(q.getlist("a"), ["1"])
        self.assertNotIn("", q)

    def test_query_malformed_escapes_kept(self):
        q = Request("GET", "/s?a=100%&b=%zz&c=%4").query
        self.assertEqual(q.get("a"), "100%")
        self.assertEqual(q.get("b"), "%zz")
        self.assertEqual(q.get("c"), "%4")

if __name__ == "__main__":
    unittest.main()
