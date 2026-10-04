"""Parsing and validation of single observation records."""

import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone

FIELDS = ["station_id", "station_name", "timestamp", "temp_c", "humidity_pct", "wind_kph", "precip_mm", "flags"]

_STATION = re.compile(r"[A-Z0-9]{4}")
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})")
_NUMBER = re.compile(r"-?\d+(\.\d+)?")
_INTEGER = re.compile(r"-?\d+")
_FLAGS = re.compile(r"[A-Z]*")


class RecordError(ValueError):
    """A record that must be rejected. `reason` names the offending field."""

    def __init__(self, reason, detail=""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason


@dataclass(frozen=True)
class Observation:
    station_id: str
    station_name: str
    time: datetime  # aware, UTC
    temp_c: float | None
    humidity_pct: int | None
    wind_kph: float | None
    precip_mm: float | None
    trace: bool
    flags: str


def parse_timestamp(text):
    if not _TIMESTAMP.fullmatch(text):
        raise RecordError("timestamp", repr(text))
    t = datetime.strptime(text.replace("Z", "+00:00"), "%Y-%m-%dT%H:%M:%S%z")
    return t.astimezone(timezone.utc)


def _number(field, text, lo=None, hi=None):
    if not _NUMBER.fullmatch(text):
        raise RecordError(field, repr(text))
    value = float(text)
    if not math.isfinite(value) or (lo is not None and value < lo) or (hi is not None and value > hi):
        raise RecordError(field, repr(text))
    return value


def parse_record(fields):
    """Validates one CSV row (already split into fields) and returns an Observation."""
    if len(fields) != len(FIELDS):
        raise RecordError("field_count", f"expected {len(FIELDS)} fields, got {len(fields)}")
    sid, name, ts, temp, hum, wind, precip, flags = fields
    if not _STATION.fullmatch(sid):
        raise RecordError("station_id", repr(sid))
    if not name.strip():
        raise RecordError("station_name", "empty")
    time = parse_timestamp(ts)

    temp_c = None if temp in ("", "M") else _number("temp_c", temp, -90.0, 60.0)

    humidity = None
    if hum != "":
        if not _INTEGER.fullmatch(hum) or not 0 <= int(hum) <= 100:
            raise RecordError("humidity_pct", repr(hum))
        humidity = int(hum)

    wind_kph = None if wind == "" else _number("wind_kph", wind, 0.0)

    trace = False
    if precip == "":
        precip_mm = None
    else:
        precip_mm = _number("precip_mm", precip, 0.0)

    if not _FLAGS.fullmatch(flags):
        raise RecordError("flags", repr(flags))
    return Observation(sid, name, time, temp_c, humidity, wind_kph, precip_mm, trace, flags)
