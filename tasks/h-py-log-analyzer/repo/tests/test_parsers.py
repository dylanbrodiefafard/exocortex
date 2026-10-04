import unittest

from logscan.report import build_report

TEXT = "2026-03-14T00:00:01.400Z WARN  [gateway] slow query code=E1001 latency_ms=2661"
KV = 'ts=2026-03-14T00:00:02.181Z level=error service=gateway msg="charge declined" user=dave code=E2002 dur=23ms'
JSON = '{"ts": "2026-03-14T00:00:06.584Z", "level": "ERROR", "service": "search", "msg": "x", "code": "E5000"}'


def report(text):
    return build_report(text.split("\n"))


class TextEntryTest(unittest.TestCase):
    def test_counts_entry_and_level(self):
        r = report(TEXT)
        self.assertEqual(r["lines"], 1)
        self.assertEqual(r["entries"], 1)
        self.assertEqual(r["unparsed"], 0)
        self.assertEqual(r["levels"], {"WARN": 1})
        self.assertEqual(r["errors_by_service"], {})

    def test_error_code_from_message(self):
        r = report("2026-03-14T00:00:01.400Z ERROR [billing] charge declined code=E2001 latency_ms=3")
        self.assertEqual(r["errors_by_service"], {"billing": 1})
        self.assertEqual(r["top_error_codes"], [["E2001", 1]])

    def test_timestamps(self):
        r = report(TEXT + "\n2026-03-14T00:10:00.999Z INFO  [auth] ok")
        self.assertEqual(r["first_ts"], "2026-03-14T00:00:01Z")
        self.assertEqual(r["last_ts"], "2026-03-14T00:10:00Z")


class KeyValueEntryTest(unittest.TestCase):
    def test_quoted_values(self):
        r = report(KV)
        self.assertEqual(r["entries"], 1)
        self.assertEqual(r["levels"], {"ERROR": 1})
        self.assertEqual(r["errors_by_service"], {"gateway": 1})
        self.assertEqual(r["top_error_codes"], [["E2002", 1]])

    def test_quoted_value_with_equals(self):
        line = 'ts=2026-03-14T00:00:02.181Z level=warn service=search msg="slow (limit=5)" dur=1ms'
        r = report(line)
        self.assertEqual(r["levels"], {"WARN": 1})
        self.assertEqual(r["unparsed"], 0)


class JsonEntryTest(unittest.TestCase):
    def test_json_entry(self):
        r = report(JSON)
        self.assertEqual(r["entries"], 1)
        self.assertEqual(r["errors_by_service"], {"search": 1})
        self.assertEqual(r["top_error_codes"], [["E5000", 1]])

    def test_truncated_json_is_unparsed(self):
        r = report('{"ts": "2026-03-14T00:00:06.584Z", "lev')
        self.assertEqual(r["entries"], 0)
        self.assertEqual(r["unparsed"], 1)
        self.assertIsNone(r["first_ts"])


class StackTraceTest(unittest.TestCase):
    def test_trace_lines_attach_to_entry(self):
        log = "\n".join([
            "2026-03-14T00:00:01.400Z ERROR [orders] unhandled exception code=E5000",
            "java.lang.IllegalStateException: boom",
            "\tat com.acme.orders.Handler.handle(Handler.java:42)",
            "\tat java.base/java.lang.Thread.run(Thread.java:840)",
            TEXT,
        ])
        r = report(log)
        self.assertEqual(r["lines"], 5)
        self.assertEqual(r["entries"], 2)
        self.assertEqual(r["unparsed"], 0)
        self.assertEqual(r["exceptions"], {"java.lang.IllegalStateException": 1})


class GarbageTest(unittest.TestCase):
    def test_garbage_lines(self):
        r = report("\n".join(["-- MARK --", "", TEXT, "Connection reset by peer"]))
        self.assertEqual(r["lines"], 4)
        self.assertEqual(r["entries"], 1)
        self.assertEqual(r["unparsed"], 3)


if __name__ == "__main__":
    unittest.main()
