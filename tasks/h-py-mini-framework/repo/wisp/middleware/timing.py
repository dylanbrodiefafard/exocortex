"""Adds a ``Server-Timing`` header and records request durations."""

import time

from wisp.middleware.base import Middleware


class TimingMiddleware(Middleware):
    def __init__(self, clock=time.perf_counter, log: list | None = None):
        self.clock = clock
        self.log = log if log is not None else []

    def __call__(self, request, call_next):
        start = self.clock()
        response = call_next(request)
        elapsed_ms = (self.clock() - start) * 1000
        response.headers["Server-Timing"] = f"app;dur={elapsed_ms:.1f}"
        self.log.append((request.method, request.path, response.status, round(elapsed_ms, 1)))
        return response
