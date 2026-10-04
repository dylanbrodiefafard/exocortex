import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXPECTED_SEED_1 = {
    "lines": 34416,
    "entries": 29705,
    "unparsed": 298,
    "levels": {
        "DEBUG": 5305,
        "ERROR": 2361,
        "FATAL": 285,
        "INFO": 17854,
        "TRACE": 580,
        "WARN": 3320
    },
    "errors_by_service": {
        "auth": 404,
        "billing": 380,
        "edge-apac": 3,
        "edge-us": 12,
        "gateway": 361,
        "inventory": 355,
        "legacy-batch": 19,
        "notify": 345,
        "orders": 342,
        "payments-v2": 43,
        "search": 382
    },
    "top_error_codes": [
        ["E1203", 242],
        ["E4040", 227],
        ["E5003", 223],
        ["E5000", 221],
        ["E1001", 220]
    ],
    "exceptions": {
        "com.acme.billing.ChargeDeclinedException": 78,
        "com.acme.db.DeadlockException": 14,
        "com.acme.orders.OrderNotFoundException": 73,
        "java.io.IOException": 18,
        "java.lang.IllegalArgumentException": 84,
        "java.lang.IllegalStateException": 66,
        "java.lang.NullPointerException": 65,
        "java.net.ConnectException": 24,
        "java.net.SocketTimeoutException": 20,
        "java.sql.SQLTransientConnectionException": 20,
        "java.util.concurrent.TimeoutException": 79
    },
    "first_ts": "2026-03-14T00:00:00Z",
    "last_ts": "2026-03-14T03:44:55Z"
}


def run_report(seed, entries=30000):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "app.log")
        with open(path, "wb") as fh:
            subprocess.run(
                [sys.executable, os.path.join(ROOT, "tools", "gen_logs.py"),
                 "--seed", str(seed), "--entries", str(entries)],
                stdout=fh, check=True,
            )
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "analyze.py"), path, "--json"],
            capture_output=True, text=True, cwd=ROOT,
        )
    if proc.returncode != 0:
        raise AssertionError("analyze.py exited %d:\n%s" % (proc.returncode, proc.stderr[-2000:]))
    return json.loads(proc.stdout)


class EndToEndTest(unittest.TestCase):
    maxDiff = None

    def check(self, actual, expected):
        for key in expected:
            with self.subTest(key=key):
                self.assertEqual(actual.get(key), expected[key])

    def test_seed_1_report(self):
        self.check(run_report(1), EXPECTED_SEED_1)


if __name__ == "__main__":
    unittest.main()
