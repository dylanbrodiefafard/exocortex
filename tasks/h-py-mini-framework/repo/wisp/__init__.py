"""wisp: a small, dependency-free web framework core.

wisp does not speak HTTP on a socket; it turns ``Request`` objects into
``Response`` objects. Use ``wisp.testing.TestClient`` to drive an app.
"""

from wisp.app import Wisp
from wisp.exceptions import BadRequest, Forbidden, HTTPError, MethodNotAllowed, NotFound
from wisp.request import Request
from wisp.response import HTMLResponse, JSONResponse, Response, redirect

__all__ = [
    "BadRequest",
    "Forbidden",
    "HTMLResponse",
    "HTTPError",
    "JSONResponse",
    "MethodNotAllowed",
    "NotFound",
    "Request",
    "Response",
    "Wisp",
    "redirect",
]
__version__ = "0.4.1"
