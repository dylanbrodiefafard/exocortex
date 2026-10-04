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

EXPECTED_SEED_7 = {
    "lines": 34471,
    "entries": 29686,
    "unparsed": 317,
    "levels": {
        "DEBUG": 5366,
        "ERROR": 2279,
        "FATAL": 300,
        "INFO": 17916,
        "TRACE": 512,
        "WARN": 3313
    },
    "errors_by_service": {
        "auth": 357,
        "billing": 328,
        "edge-apac": 2,
        "edge-us": 16,
        "gateway": 363,
        "inventory": 330,
        "legacy-batch": 15,
        "notify": 376,
        "orders": 406,
        "payments-v2": 38,
        "search": 348
    },
    "top_error_codes": [
        ["E5000", 230],
        ["E5003", 225],
        ["E4040", 221],
        ["E2001", 219],
        ["E3100", 208]
    ],
    "exceptions": {
        "com.acme.billing.ChargeDeclinedException": 76,
        "com.acme.db.DeadlockException": 15,
        "com.acme.orders.OrderNotFoundException": 71,
        "java.io.IOException": 19,
        "java.lang.IllegalArgumentException": 79,
        "java.lang.IllegalStateException": 70,
        "java.lang.NullPointerException": 89,
        "java.net.ConnectException": 22,
        "java.net.SocketTimeoutException": 23,
        "java.sql.SQLTransientConnectionException": 16,
        "java.util.concurrent.TimeoutException": 77
    },
    "first_ts": "2026-03-14T00:00:00Z",
    "last_ts": "2026-03-14T03:45:42Z"
}

EXPECTED_SEED_23 = {
    "lines": 51695,
    "entries": 44515,
    "unparsed": 488,
    "levels": {
        "DEBUG": 7949,
        "ERROR": 3602,
        "FATAL": 445,
        "INFO": 26725,
        "TRACE": 907,
        "WARN": 4887
    },
    "errors_by_service": {
        "auth": 549,
        "billing": 608,
        "edge-apac": 4,
        "edge-us": 22,
        "gateway": 518,
        "inventory": 586,
        "legacy-batch": 35,
        "notify": 516,
        "orders": 555,
        "payments-v2": 77,
        "search": 577
    },
    "top_error_codes": [
        ["E1001", 341],
        ["E1203", 329],
        ["E1002", 326],
        ["E4040", 325],
        ["E2002", 322]
    ],
    "exceptions": {
        "com.acme.billing.ChargeDeclinedException": 119,
        "com.acme.db.DeadlockException": 19,
        "com.acme.orders.OrderNotFoundException": 130,
        "java.io.IOException": 24,
        "java.lang.IllegalArgumentException": 96,
        "java.lang.IllegalStateException": 103,
        "java.lang.NullPointerException": 125,
        "java.net.ConnectException": 29,
        "java.net.SocketTimeoutException": 27,
        "java.sql.SQLTransientConnectionException": 35,
        "java.util.concurrent.TimeoutException": 119
    },
    "first_ts": "2026-03-14T00:00:00Z",
    "last_ts": "2026-03-14T05:38:03Z"
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

    def test_seed_7_report(self):
        self.check(run_report(7), EXPECTED_SEED_7)

    def test_seed_23_report(self):
        self.check(run_report(23, entries=45000), EXPECTED_SEED_23)


if __name__ == "__main__":
    unittest.main()
