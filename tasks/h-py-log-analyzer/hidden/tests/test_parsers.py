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


class LevelAliasTest(unittest.TestCase):
    def test_aliases_and_case(self):
        log = "\n".join([
            "ts=2026-03-14T00:00:00.000Z level=Warning service=a msg=x",
            "ts=2026-03-14T00:00:00.000Z level=err service=a msg=x code=E1",
            '{"ts": "2026-03-14T00:00:00.000Z", "level": "Critical", "service": "b", "msg": "x", "code": "E1"}',
            "2026-03-14T00:00:00.000Z WARNING [c] x",
            "2026-03-14T00:00:00.000Z info [c] x",
        ])
        r = report(log)
        self.assertEqual(r["levels"], {"WARN": 2, "ERROR": 1, "FATAL": 1, "INFO": 1})
        self.assertEqual(r["errors_by_service"], {"a": 1, "b": 1})
        self.assertEqual(r["top_error_codes"], [["E1", 2]])


class KeyValueEdgeCasesTest(unittest.TestCase):
    def test_apostrophe_in_unquoted_value(self):
        r = report("ts=2026-03-14T00:00:00.000Z level=error service=api user=o'hara msg=failed code=E7")
        self.assertEqual(r["entries"], 1)
        self.assertEqual(r["errors_by_service"], {"api": 1})
        self.assertEqual(r["top_error_codes"], [["E7", 1]])

    def test_unquoted_value_with_quote_chars(self):
        r = report('ts=2026-03-14T00:00:00.000Z level=info q=it\'s"odd service=api msg=ok')
        self.assertEqual(r["entries"], 1)
        self.assertEqual(r["levels"], {"INFO": 1})

    def test_escaped_quotes_in_quoted_value(self):
        line = r'ts=2026-03-14T00:00:00.000Z level=error msg="bad \"code=E9\" here" service=api code=E2'
        r = report(line)
        self.assertEqual(r["errors_by_service"], {"api": 1})
        self.assertEqual(r["top_error_codes"], [["E2", 1]])


class JsonNestedCodeTest(unittest.TestCase):
    def test_nested_error_code(self):
        line = ('{"ts": "2026-03-14T00:00:00.000Z", "level": "ERROR", "service": "pay", "msg": "x", '
                '"error": {"code": "E42", "type": "Timeout"}}')
        self.assertEqual(report(line)["top_error_codes"], [["E42", 1]])

    def test_top_level_code_wins(self):
        line = ('{"ts": "2026-03-14T00:00:00.000Z", "level": "FATAL", "service": "pay", "msg": "x", '
                '"code": "E1", "error": {"code": "E2"}}')
        self.assertEqual(report(line)["top_error_codes"], [["E1", 1]])


class ContinuationTest(unittest.TestCase):
    def test_any_indented_line_continues(self):
        log = "\n".join([
            "2026-03-14T00:00:01.400Z ERROR [orders] unhandled exception",
            "com.acme.X: boom",
            "    at com.acme.orders.Handler.handle(Handler.java:42)",
            "\tat com.acme.orders.Handler.handle(Handler.java:43)",
            "Caused by: java.io.IOException: disk full",
            "  at com.acme.Disk.write(Disk.java:9)",
            "\t... 12 more",
            "\t",
            "",
        ])
        r = report(log)
        self.assertEqual(r["lines"], 9)
        self.assertEqual(r["entries"], 1)
        self.assertEqual(r["unparsed"], 2)

    def test_continuation_before_first_entry_is_unparsed(self):
        r = report("\tat com.acme.Foo.bar(Foo.java:1)\njava.lang.Error: x")
        self.assertEqual(r["unparsed"], 2)
        self.assertEqual(r["exceptions"], {})


class RootCauseTest(unittest.TestCase):
    def test_last_caused_by_wins(self):
        log = "\n".join([
            "2026-03-14T00:00:01.400Z ERROR [orders] unhandled exception",
            "java.lang.IllegalStateException: boom",
            "\tat com.acme.A.a(A.java:1)",
            "Caused by: java.net.SocketTimeoutException: timed out",
            "\tat com.acme.B.b(B.java:2)",
            "\t... 3 more",
            "Caused by: java.net.ConnectException",
            "\t... 7 more",
            "2026-03-14T00:00:02.400Z FATAL [orders] crash",
            "java.lang.OutOfMemoryError: heap",
            "\tat com.acme.C.c(C.java:3)",
        ])
        r = report(log)
        self.assertEqual(r["exceptions"], {"java.net.ConnectException": 1, "java.lang.OutOfMemoryError": 1})


class TimestampTest(unittest.TestCase):
    def test_offsets_are_normalized_to_utc(self):
        log = "\n".join([
            "2026-03-14T01:00:00.500Z INFO  [a] x",
            "2026-03-13T17:30:00.000-07:00 INFO  [edge] earliest",
            '{"ts": "2026-03-14T08:15:59.999+05:30", "level": "INFO", "service": "apac", "msg": "x"}',
            "ts=2026-03-14T03:00:00.000Z level=info service=a msg=latest",
        ])
        r = report(log)
        self.assertEqual(r["first_ts"], "2026-03-14T00:30:00Z")
        self.assertEqual(r["last_ts"], "2026-03-14T03:00:00Z")

    def test_offset_entry_can_be_first_or_last(self):
        log = "\n".join([
            "2026-03-14T01:00:00.000Z INFO  [a] x",
            "2026-03-13T17:59:59.000-07:00 INFO  [edge] x",
            "2026-03-14T07:00:01.250+05:30 INFO  [apac] x",
        ])
        r = report(log)
        self.assertEqual(r["first_ts"], "2026-03-14T00:59:59Z")
        self.assertEqual(r["last_ts"], "2026-03-14T01:30:01Z")


class InvalidUtf8Test(unittest.TestCase):
    def test_cli_survives_invalid_bytes(self):
        import json
        import os
        import subprocess
        import sys
        import tempfile

        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.log")
            with open(path, "wb") as fh:
                fh.write(TEXT.encode() + b"\n")
                fh.write(b"\xff\xfe\x00junk \xc3\x28\n")
                fh.write(b"2026-03-14T00:00:02.000Z ERROR [caf\xc3\xa9] bad \xe9 byte code=E3\n")
            proc = subprocess.run(
                [sys.executable, os.path.join(root, "analyze.py"), path, "--json"],
                capture_output=True, text=True, cwd=root,
            )
        self.assertEqual(proc.returncode, 0, proc.stderr[-1000:])
        r = json.loads(proc.stdout)
        self.assertEqual((r["lines"], r["entries"], r["unparsed"]), (3, 2, 1))
        self.assertEqual(r["errors_by_service"], {"café": 1})
        self.assertEqual(r["top_error_codes"], [["E3", 1]])


if __name__ == "__main__":
    unittest.main()
