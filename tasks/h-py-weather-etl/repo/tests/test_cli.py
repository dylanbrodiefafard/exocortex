import json
import os
import tempfile
import unittest

from wxetl.__main__ import main

SMALL = os.path.join(os.path.dirname(__file__), "fixtures", "small.csv")


class CliTests(unittest.TestCase):
    def test_writes_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "report.json")
            with self.assertLogs("wxetl.pipeline", level="INFO"):
                self.assertEqual(main([SMALL, "--out", out]), 0)
            with open(out, encoding="utf-8") as f:
                report = json.load(f)
        self.assertEqual(report["records"], {"total": 6, "accepted": 4, "rejected": 2})
        self.assertEqual(report["rejected"], [{"line": 8, "reason": "temp_c"}, {"line": 9, "reason": "field_count"}])
        days = report["stations"]["KBOS"]["days"]
        self.assertEqual(sorted(days), ["2024-03-01", "2024-03-02"])
        self.assertEqual(days["2024-03-01"], {
            "obs": 2, "temp_min": 2.0, "temp_max": 4.0, "temp_mean": 3.0,
            "precip_mm": 1.2, "trace_hours": 0, "wind_max_kph": 12.5,
        })
        self.assertEqual(days["2024-03-02"], {
            "obs": 2, "temp_min": -1.5, "temp_max": -1.5, "temp_mean": -1.5,
            "precip_mm": 0.4, "trace_hours": 0, "wind_max_kph": 7.0,
        })

    def test_logs_every_record(self):
        with self.assertLogs("wxetl.pipeline", level="INFO") as logs:
            main([SMALL, "--out", os.devnull])
        per_line = [r for r in logs.records if r.getMessage().startswith("line ")]
        accepted = [r for r in per_line if r.levelname == "INFO" and "accepted" in r.getMessage()]
        rejected = [r for r in per_line if r.levelname == "WARNING" and "rejected" in r.getMessage()]
        self.assertEqual(len(accepted), 4)
        self.assertEqual(len(rejected), 2)
        self.assertIn("line 8", rejected[0].getMessage())


if __name__ == "__main__":
    unittest.main()
