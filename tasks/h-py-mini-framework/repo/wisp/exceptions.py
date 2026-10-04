"""HTTP errors that handlers and the router may raise."""


class HTTPError(Exception):
    status = 500
    reason = "Internal Server Error"

    def __init__(self, detail: str | None = None, headers: dict[str, str] | None = None):
        super().__init__(detail or self.reason)
        self.detail = detail or self.reason
        self.headers = dict(headers or {})


class BadRequest(HTTPError):
    status = 400
    reason = "Bad Request"


class Forbidden(HTTPError):
    status = 403
    reason = "Forbidden"


class NotFound(HTTPError):
    status = 404
    reason = "Not Found"


class MethodNotAllowed(HTTPError):
    status = 405
    reason = "Method Not Allowed"

    def __init__(self, allowed: list[str]):
        super().__init__(headers={"Allow": ", ".join(allowed)})
        self.allowed = list(allowed)
