import json
import os
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


if __name__ == "__main__":
    unittest.main()
