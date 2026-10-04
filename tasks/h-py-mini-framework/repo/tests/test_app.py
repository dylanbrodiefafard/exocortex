import unittest

from wisp import HTTPError, JSONResponse, Wisp
from wisp.testing import TestClient


class AppTests(unittest.TestCase):
    def setUp(self):
        app = Wisp()

        @app.get("/json")
        def as_json(request):
            return {"ok": True}

        @app.get("/html")
        def as_html(request):
            return "<p>hi</p>"

        @app.get("/empty")
        def empty(request):
            return None

        @app.get("/items/<int:item_id>")
        def item(request, item_id):
            return JSONResponse({"id": item_id, "params": request.path_params})

        @app.route("/echo", methods=["POST", "PUT"])
        def echo(request):
            return {"method": request.method, "body": request.json()}

        @app.get("/teapot")
        def teapot(request):
            raise HTTPError("short and stout")

        @app.get("/weird")
        def weird(request):
            return 42

        self.app = app
        self.client = TestClient(app)

    def test_return_types(self):
        self.assertEqual(self.client.get("/json").json(), {"ok": True})
        html = self.client.get("/html")
        self.assertTrue(html.headers["Content-Type"].startswith("text/html"))
        self.assertEqual(self.client.get("/empty").status, 204)
        self.assertEqual(self.client.get("/weird").status, 500)

    def test_params_passed_to_handler(self):
        self.assertEqual(self.client.get("/items/5").json(), {"id": 5, "params": {"item_id": 5}})

    def test_json_body(self):
        r = self.client.request("PUT", "/echo", json={"a": 1})
        self.assertEqual(r.json(), {"method": "PUT", "body": {"a": 1}})

    def test_errors(self):
        self.assertEqual(self.client.get("/missing").status, 404)
        r = self.client.get("/echo")
        self.assertEqual(r.status, 405)
        self.assertEqual(r.headers["Allow"], "POST, PUT")
        self.assertEqual(self.client.get("/teapot").text, "short and stout")

    def test_head_strips_body(self):
        r = self.client.head("/json")
        self.assertEqual((r.status, r.body), (200, b""))

    def test_url_for(self):
        self.assertEqual(self.app.url_for("item", item_id=3), "/items/3")


if __name__ == "__main__":
    unittest.main()
