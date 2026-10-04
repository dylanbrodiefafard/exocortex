"""In-process test client."""

import json as _json

from wisp.request import Request


class TestClient:
    __test__ = False  # not a test case

    def __init__(self, app, default_headers=None):
        self.app = app
        self.default_headers = dict(default_headers or {})

    def request(self, method: str, target: str, *, headers=None, body: bytes | str = b"", json=None, form=None):
        all_headers = {**self.default_headers, **(headers or {})}
        if json is not None:
            body = _json.dumps(json)
            all_headers.setdefault("Content-Type", "application/json")
        elif form is not None:
            from wisp.utils.encoding import quote

            body = "&".join(f"{quote(k)}={quote(str(v))}" for k, v in form.items())
            all_headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        if isinstance(body, str):
            body = body.encode("utf-8")
        return self.app.handle(Request(method, target, headers=all_headers, body=body))

    def get(self, target: str, **kw):
        return self.request("GET", target, **kw)

    def post(self, target: str, **kw):
        return self.request("POST", target, **kw)

    def head(self, target: str, **kw):
        return self.request("HEAD", target, **kw)

    def options(self, target: str, **kw):
        return self.request("OPTIONS", target, **kw)
