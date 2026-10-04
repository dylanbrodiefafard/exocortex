"""Middleware wrap the application's dispatch: ``middleware(request, call_next)``."""

from wisp.middleware.base import Middleware, compose
from wisp.middleware.cors import CORSMiddleware
from wisp.middleware.errors import ErrorMiddleware
from wisp.middleware.timing import TimingMiddleware

__all__ = ["CORSMiddleware", "ErrorMiddleware", "Middleware", "TimingMiddleware", "compose"]
