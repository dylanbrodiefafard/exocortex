"""The request object handed to every handler."""

import json
from functools import cached_property

from wisp.exceptions import BadRequest
from wisp.request.cookies import parse_cookie_header
from wisp.request.forms import parse_urlencoded
from wisp.request.headers import Headers


class Request:
    """An HTTP request.

    ``target`` is the request-target exactly as it appeared on the request
    line, e.g. ``/books/12?format=json``. It is split into ``path`` (still
    percent-encoded) and ``query_string`` (everything after the first ``?``,
    without the ``?``; empty when absent).
    """

    def __init__(self, method: str, target: str, headers=None, body: bytes = b""):
        self.method = method.upper()
        self.target = target
        path, _, query_string = target.partition("?")
        self.path = path or "/"
        self.query_string = query_string
        self.headers = Headers.coerce(headers)
        self.body = body
        #: Parameters captured by the router; filled in by the application.
        self.path_params: dict = {}
        #: Free-form per-request storage for middleware.
        self.state: dict = {}

    def __repr__(self) -> str:
        return f"<Request {self.method} {self.target}>"

    @property
    def content_type(self) -> str:
        value = self.headers.get("Content-Type", "") or ""
        return value.split(";", 1)[0].strip().lower()

    @cached_property
    def cookies(self) -> dict[str, str]:
        return parse_cookie_header(self.headers.get("Cookie"))

    @cached_property
    def form(self):
        if self.content_type != "application/x-www-form-urlencoded":
            raise BadRequest("expected a form body")
        return parse_urlencoded(self.body)

    def json(self):
        if self.content_type != "application/json":
            raise BadRequest("expected a JSON body")
        try:
            return json.loads(self.body or b"null")
        except ValueError as exc:
            raise BadRequest(f"invalid JSON: {exc}") from None
