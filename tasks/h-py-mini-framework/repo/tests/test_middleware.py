import unittest

from wisp import NotFound, Request, Response, Wisp
from wisp.middleware import CORSMiddleware, ErrorMiddleware, Middleware, TimingMiddleware, compose


class Tag(Middleware):
    def __init__(self, name, trail):
        self.name, self.trail = name, trail

    def __call__(self, request, call_next):
        self.trail.append(f"{self.name}>")
        response = call_next(request)
        self.trail.append(f"<{self.name}")
        return response


class FakeClock:
    def __init__(self, *ticks):
        self.ticks = list(ticks)

    def __call__(self):
        return self.ticks.pop(0)


class MiddlewareTests(unittest.TestCase):
    def test_compose_order(self):
        trail = []
        handler = compose([Tag("a", trail), Tag("b", trail)], lambda req: Response("ok"))
        handler(Request("GET", "/"))
        self.assertEqual(trail, ["a>", "b>", "<b", "<a"])

    def test_error_middleware_http_error(self):
        def boom(request):
            raise NotFound("gone")

        response = ErrorMiddleware()(Request("GET", "/"), boom)
        self.assertEqual((response.status, response.text), (404, "gone"))

    def test_error_middleware_unexpected(self):
        def boom(request):
            raise RuntimeError("x")

        self.assertEqual(ErrorMiddleware()(Request("GET", "/"), boom).status, 500)
        with self.assertRaises(RuntimeError):
            ErrorMiddleware(debug=True)(Request("GET", "/"), boom)

    def test_json_errors(self):
        def boom(request):
            raise NotFound()

        response = ErrorMiddleware(json_errors=True)(Request("GET", "/"), boom)
        self.assertEqual(response.json(), {"error": "Not Found", "status": 404})

    def test_timing(self):
        log = []
        mw = TimingMiddleware(clock=FakeClock(10.0, 10.25), log=log)
        response = mw(Request("GET", "/x"), lambda req: Response("ok"))
        self.assertEqual(response.headers["Server-Timing"], "app;dur=250.0")
        self.assertEqual(log, [("GET", "/x", 200, 250.0)])

    def test_cors_simple_request(self):
        mw = CORSMiddleware(allow_origins=["https://a.example"])
        req = Request("GET", "/", headers={"Origin": "https://a.example"})
        response = mw(req, lambda r: Response("ok"))
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "https://a.example")
        self.assertEqual(response.headers["Vary"], "Origin")

    def test_cors_other_origin_untouched(self):
        mw = CORSMiddleware(allow_origins=["https://a.example"])
        req = Request("GET", "/", headers={"Origin": "https://evil.example"})
        self.assertNotIn("Access-Control-Allow-Origin", mw(req, lambda r: Response("ok")).headers)

    def test_cors_preflight(self):
        mw = CORSMiddleware(allow_methods=["get", "put"])
        req = Request("OPTIONS", "/", headers={"Origin": "https://x", "Access-Control-Request-Method": "PUT"})
        response = mw(req, lambda r: self.fail("should not be called"))
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers["Access-Control-Allow-Methods"], "GET, PUT")
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")

    def test_app_middleware_runs_inside_error_handling(self):
        app = Wisp()
        seen = []

        class Spy(Middleware):
            def __call__(self, request, call_next):
                response = call_next(request)
                seen.append(response.status)
                return response

        app.add_middleware(Spy())
        self.assertEqual(app.handle(Request("GET", "/missing")).status, 404)
        self.assertEqual(seen, [])

if __name__ == "__main__":
    unittest.main()
