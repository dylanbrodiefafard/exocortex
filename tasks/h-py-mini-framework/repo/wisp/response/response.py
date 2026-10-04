"""Response classes."""

import json

from wisp.request.headers import Headers
from wisp.response.status import is_redirect, reason_phrase


class Response:
    default_content_type = "text/plain; charset=utf-8"

    def __init__(self, body: bytes | str = b"", status: int = 200, headers=None, content_type: str | None = None):
        self.status = status
        self.headers = Headers.coerce(headers)
        self.body = body.encode("utf-8") if isinstance(body, str) else bytes(body)
        if "Content-Type" not in self.headers and status != 204:
            self.headers["Content-Type"] = content_type or self.default_content_type

    @property
    def reason(self) -> str:
        return reason_phrase(self.status)

    @property
    def text(self) -> str:
        return self.body.decode("utf-8")

    def json(self):
        return json.loads(self.body)

    def set_cookie(self, name: str, value: str, *, path: str = "/", http_only: bool = True, max_age: int | None = None):
        parts = [f"{name}={value}", f"Path={path}"]
        if max_age is not None:
            parts.append(f"Max-Age={max_age}")
        if http_only:
            parts.append("HttpOnly")
        self.headers.add("Set-Cookie", "; ".join(parts))

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.status}>"


class HTMLResponse(Response):
    default_content_type = "text/html; charset=utf-8"


class JSONResponse(Response):
    default_content_type = "application/json"

    def __init__(self, data, status: int = 200, headers=None):
        super().__init__(json.dumps(data, sort_keys=True, ensure_ascii=False), status, headers)


def redirect(location: str, status: int = 302) -> Response:
    if not is_redirect(status):
        raise ValueError(f"{status} is not a redirect status")
    return Response(b"", status=status, headers={"Location": location})
