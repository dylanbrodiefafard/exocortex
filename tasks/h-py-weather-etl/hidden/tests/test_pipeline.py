import json
import os
import subprocess
import sys
import tempfile
import unittest

from wxetl.pipeline import run

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data", "observations.csv")


class FullMonthTests(unittest.TestCase):
    """Runs the pipeline over the generated month in data/ (see README.md)."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(HERE, "expected_report.json"), encoding="utf-8") as f:
            cls.expected = json.load(f)
        cls.report = run(DATA)

    def test_record_counts(self):
        self.assertEqual(self.report["records"], self.expected["records"])

    def test_rejected_lines(self):
        got = [(r["line"], r["reason"]) for r in self.report["rejected"]]
        want = [(r["line"], r["reason"]) for r in self.expected["rejected"]]
        self.assertEqual(got, want)

    def test_stations(self):
        got = {sid: s["name"] for sid, s in self.report["stations"].items()}
        want = {sid: s["name"] for sid, s in self.expected["stations"].items()}
        self.assertEqual(got, want)

    def test_daily_summaries(self):
        for sid, station in self.expected["stations"].items():
            for day, want in station["days"].items():
                with self.subTest(station=sid, day=day):
                    got = self.report["stations"].get(sid, {}).get("days", {}).get(day)
                    self.assertEqual(got, want)

    def test_days_are_utc(self):
        for sid, station in self.report["stations"].items():
            with self.subTest(station=sid):
                self.assertEqual(sorted(station["days"]), sorted(self.expected["stations"][sid]["days"]))


    def test_every_record_is_logged(self):
        with self.assertLogs("wxetl.pipeline", level="INFO") as logs:
            report = run(DATA)
        per_line = [r for r in logs.records if r.getMessage().startswith("line ")]
        accepted = [r for r in per_line if r.levelname == "INFO" and "accepted" in r.getMessage()]
        rejected = [r for r in per_line if r.levelname == "WARNING" and "rejected" in r.getMessage()]
        self.assertEqual(len(accepted), report["records"]["accepted"])
        self.assertEqual(len(rejected), report["records"]["rejected"])
        self.assertEqual(len(per_line), report["records"]["total"])


class OtherSeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(HERE, "expected_seed5.json"), encoding="utf-8") as f:
            cls.expected = json.load(f)
        root = os.path.join(HERE, "..")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "obs.csv")
            with open(path, "w", encoding="utf-8") as out:
                subprocess.run([sys.executable, os.path.join(root, "tools", "gen_obs.py"), "--seed", "5"],
                               stdout=out, check=True)
            cls.report = run(path)

    def test_report_matches(self):
        self.assertEqual(self.report["records"], self.expected["records"])
        self.assertEqual(self.report["rejected"], self.expected["rejected"])
        self.assertEqual(self.report["stations"], self.expected["stations"])


if __name__ == "__main__":
    unittest.main()
