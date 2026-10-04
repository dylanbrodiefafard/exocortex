"""Turn exceptions into responses."""

from wisp.exceptions import HTTPError
from wisp.middleware.base import Middleware
from wisp.response import JSONResponse, Response


class ErrorMiddleware(Middleware):
    """Converts ``HTTPError`` into a response; other exceptions become 500s.

    With ``debug=True`` unexpected exceptions propagate instead, which is what
    tests usually want.
    """

    def __init__(self, debug: bool = False, json_errors: bool = False):
        self.debug = debug
        self.json_errors = json_errors

    def __call__(self, request, call_next):
        try:
            return call_next(request)
        except HTTPError as exc:
            return self._render(exc.status, exc.detail, exc.headers)
        except Exception:
            if self.debug:
                raise
            return self._render(500, "Internal Server Error", {})

    def _render(self, status: int, detail: str, headers: dict) -> Response:
        if self.json_errors:
            return JSONResponse({"error": detail, "status": status}, status=status, headers=headers)
        return Response(detail, status=status, headers=headers)
