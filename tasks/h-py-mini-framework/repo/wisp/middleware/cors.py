"""Minimal CORS support."""

from wisp.middleware.base import Middleware
from wisp.response import Response


class CORSMiddleware(Middleware):
    def __init__(self, allow_origins=("*",), allow_methods=("GET", "POST"), max_age: int = 600):
        self.allow_origins = tuple(allow_origins)
        self.allow_methods = tuple(m.upper() for m in allow_methods)
        self.max_age = max_age

    def _origin_allowed(self, origin: str) -> bool:
        return "*" in self.allow_origins or origin in self.allow_origins

    def __call__(self, request, call_next):
        origin = request.headers.get("Origin")
        if origin is None or not self._origin_allowed(origin):
            return call_next(request)
        if request.method == "OPTIONS" and request.headers.get("Access-Control-Request-Method"):
            response = Response(b"", status=204)
            response.headers["Access-Control-Allow-Methods"] = ", ".join(self.allow_methods)
            response.headers["Access-Control-Max-Age"] = str(self.max_age)
        else:
            response = call_next(request)
        response.headers["Access-Control-Allow-Origin"] = "*" if "*" in self.allow_origins else origin
        if "*" not in self.allow_origins:
            response.headers.add("Vary", "Origin")
        return response
