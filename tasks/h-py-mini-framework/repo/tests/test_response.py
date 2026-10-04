import unittest

from wisp.response import HTMLResponse, JSONResponse, Response, reason_phrase, redirect


class ResponseTests(unittest.TestCase):
    def test_text_default(self):
        r = Response("héllo")
        self.assertEqual(r.body, "héllo".encode())
        self.assertEqual(r.headers["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(r.reason, "OK")

    def test_html(self):
        self.assertTrue(HTMLResponse("<p>").headers["content-type"].startswith("text/html"))

    def test_json(self):
        r = JSONResponse({"b": 1, "a": "é"}, status=201)
        self.assertEqual(r.text, '{"a": "é", "b": 1}')
        self.assertEqual(r.json(), {"a": "é", "b": 1})
        self.assertEqual(r.status, 201)

    def test_no_content_has_no_type(self):
        self.assertNotIn("Content-Type", Response(status=204).headers)

    def test_redirect(self):
        r = redirect("/x", 303)
        self.assertEqual((r.status, r.headers["Location"]), (303, "/x"))
        with self.assertRaises(ValueError):
            redirect("/x", 200)

    def test_cookies(self):
        r = Response()
        r.set_cookie("a", "1", max_age=60)
        r.set_cookie("b", "2", http_only=False)
        self.assertEqual(r.headers.getall("Set-Cookie"), ["a=1; Path=/; Max-Age=60; HttpOnly", "b=2; Path=/"])

    def test_reason_phrase(self):
        self.assertEqual(reason_phrase(404), "Not Found")
        self.assertEqual(reason_phrase(599), "Unknown")


if __name__ == "__main__":
    unittest.main()
