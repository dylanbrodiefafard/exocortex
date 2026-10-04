"""The application object: routes + middleware + dispatch."""

from wisp.exceptions import HTTPError
from wisp.middleware.base import compose
from wisp.middleware.errors import ErrorMiddleware
from wisp.response import HTMLResponse, JSONResponse, Response
from wisp.routing import Router


class Wisp:
    def __init__(self, debug: bool = False, json_errors: bool = False):
        self.router = Router()
        self.debug = debug
        self._middleware: list = []
        self._error_middleware = ErrorMiddleware(debug=debug, json_errors=json_errors)
        self._handler = None

    def route(self, pattern: str, methods=("GET",), name: str | None = None):
        def decorator(fn):
            self.router.add(pattern, fn, methods=methods, name=name)
            return fn

        return decorator

    def get(self, pattern: str, name: str | None = None):
        return self.route(pattern, ("GET",), name)

    def post(self, pattern: str, name: str | None = None):
        return self.route(pattern, ("POST",), name)

    def add_middleware(self, middleware) -> None:
        self._middleware.append(middleware)
        self._handler = None

    def url_for(self, name: str, **params) -> str:
        return self.router.url_for(name, **params)

    def handle(self, request) -> Response:
        """Run ``request`` through middleware and the matched handler."""
        if self._handler is None:
            self._handler = compose([self._error_middleware, *self._middleware], self._endpoint)
        response = self._handler(request)
        if request.method == "HEAD":
            response.body = b""
        return response

    def _endpoint(self, request) -> Response:
        match = self.router.match(request.method, request.path)
        request.path_params = match.params
        result = match.route.handler(request, **match.params)
        return _coerce(result)


def _coerce(result) -> Response:
    if isinstance(result, Response):
        return result
    if isinstance(result, (dict, list)):
        return JSONResponse(result)
    if isinstance(result, str):
        return HTMLResponse(result)
    if result is None:
        return Response(b"", status=204)
    raise HTTPError(f"handler returned unsupported type {type(result).__name__}")
