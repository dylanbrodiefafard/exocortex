import unittest
from datetime import datetime, timezone

from wxetl.records import RecordError, parse_record


def row(**over):
    base = {
        "station_id": "KBOS",
        "station_name": "Logan Intl Airport",
        "timestamp": "2024-03-01T12:00:00Z",
        "temp_c": "3.5",
        "humidity_pct": "70",
        "wind_kph": "12.0",
        "precip_mm": "0.0",
        "flags": "",
    }
    base.update(over)
    return list(base.values())


class ParseRecordTests(unittest.TestCase):
    def assertRejected(self, fields, reason):
        with self.assertRaises(RecordError) as ctx:
            parse_record(fields)
        self.assertEqual(ctx.exception.reason, reason)

    def test_valid(self):
        o = parse_record(row())
        self.assertEqual(o.station_id, "KBOS")
        self.assertEqual(o.time, datetime(2024, 3, 1, 12, tzinfo=timezone.utc))
        self.assertEqual(o.temp_c, 3.5)
        self.assertEqual(o.humidity_pct, 70)
        self.assertEqual(o.precip_mm, 0.0)
        self.assertFalse(o.trace)

    def test_offset_converted_to_utc(self):
        o = parse_record(row(timestamp="2024-03-01T21:30:00-05:00"))
        self.assertEqual(o.time, datetime(2024, 3, 2, 2, 30, tzinfo=timezone.utc))

    def test_missing_values(self):
        o = parse_record(row(temp_c="M", humidity_pct="", wind_kph="", precip_mm=""))
        self.assertIsNone(o.temp_c)
        self.assertIsNone(o.humidity_pct)
        self.assertIsNone(o.wind_kph)
        self.assertIsNone(o.precip_mm)
        self.assertIsNone(parse_record(row(temp_c="")).temp_c)

    def test_field_count(self):
        self.assertRejected(row()[:7], "field_count")
        self.assertRejected(row() + ["x"], "field_count")

    def test_station_id(self):
        self.assertRejected(row(station_id="kbos"), "station_id")
        self.assertRejected(row(station_id="KBOST"), "station_id")

    def test_timestamp_shape(self):
        for ts in ["yesterday", "", "2024-03-01 12:00:00Z", "2024-03-01T12:00:00", "2024-3-01T12:00:00Z"]:
            with self.subTest(ts=ts):
                self.assertRejected(row(timestamp=ts), "timestamp")

    def test_temperature(self):
        for t in ["--", "12,5", "1e3", "nan", "inf", "61.0", "-90.5", " 3.0"]:
            with self.subTest(t=t):
                self.assertRejected(row(temp_c=t), "temp_c")
        self.assertEqual(parse_record(row(temp_c="-12")).temp_c, -12.0)

    def test_humidity(self):
        for h in ["101", "-3", "50.5", "x"]:
            with self.subTest(h=h):
                self.assertRejected(row(humidity_pct=h), "humidity_pct")
        self.assertEqual(parse_record(row(humidity_pct="100")).humidity_pct, 100)

    def test_wind(self):
        self.assertRejected(row(wind_kph="-1.0"), "wind_kph")
        self.assertEqual(parse_record(row(wind_kph="0")).wind_kph, 0.0)

    def test_precip(self):
        self.assertRejected(row(precip_mm="-0.2"), "precip_mm")
        self.assertRejected(row(precip_mm="lots"), "precip_mm")
        self.assertEqual(parse_record(row(precip_mm="2.5")).precip_mm, 2.5)

    def test_impossible_timestamps(self):
        for ts in ["2024-02-30T01:00:00Z", "2024-03-07T25:00:00Z", "2024-13-01T00:00:00Z", "2024-03-01T12:60:00+01:00"]:
            with self.subTest(ts=ts):
                self.assertRejected(row(timestamp=ts), "timestamp")

    def test_trace_precip(self):
        o = parse_record(row(precip_mm="T"))
        self.assertTrue(o.trace)
        self.assertEqual(o.precip_mm, 0.0)
        self.assertFalse(parse_record(row(precip_mm="0.0")).trace)

    def test_flags(self):
        self.assertRejected(row(flags="a"), "flags")
        self.assertEqual(parse_record(row(flags="AE")).flags, "AE")


if __name__ == "__main__":
    unittest.main()
