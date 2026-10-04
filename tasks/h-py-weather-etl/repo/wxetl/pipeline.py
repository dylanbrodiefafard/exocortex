"""Reads an observations file, validates every record and aggregates daily statistics."""

import math

from wxetl.log import get_logger
from wxetl.records import FIELDS, RecordError, parse_record

log = get_logger("wxetl.pipeline")


class _Day:
    def __init__(self):
        self.obs = 0
        self.temps = []
        self.precip = 0.0
        self.trace_hours = 0
        self.wind_max = None

    def add(self, o):
        self.obs += 1
        if o.temp_c is not None:
            self.temps.append(o.temp_c)
        if o.precip_mm is not None:
            self.precip += o.precip_mm
        if o.trace:
            self.trace_hours += 1
        if o.wind_kph is not None and (self.wind_max is None or o.wind_kph > self.wind_max):
            self.wind_max = o.wind_kph

    def summary(self):
        temps = self.temps
        return {
            "obs": self.obs,
            "temp_min": min(temps) if temps else None,
            "temp_max": max(temps) if temps else None,
            "temp_mean": round(math.fsum(temps) / len(temps), 1) if temps else None,
            "precip_mm": round(self.precip, 1),
            "trace_hours": self.trace_hours,
            "wind_max_kph": self.wind_max,
        }


def _split(line):
    return line.split(",")


def run(path):
    """Processes the file at `path` and returns the report dict described in README.md."""
    total = 0
    rejected = []
    stations = {}
    with open(path, encoding="utf-8", newline="") as f:
        lines = f.read().split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    for lineno, raw in enumerate(lines, start=1):
        line = raw.rstrip("\r")
        if lineno == 1:
            if _split(line) != FIELDS:
                raise ValueError(f"{path}: unexpected header {line!r}")
            continue
        if not line.strip() or line.startswith("#"):
            continue
        total += 1
        try:
            obs = parse_record(_split(line))
        except RecordError as e:
            log.warning("line %d: rejected (%s): %s", lineno, e.reason, line)
            rejected.append({"line": lineno, "reason": e.reason})
            continue
        log.info("line %d: accepted %s %s temp=%s precip=%s", lineno, obs.station_id,
                 obs.time.strftime("%Y-%m-%dT%H:%MZ"), obs.temp_c, "T" if obs.trace else obs.precip_mm)
        station = stations.setdefault(obs.station_id, {"name": obs.station_name, "days": {}})
        day = station["days"].setdefault(obs.time.strftime("%Y-%m-%d"), _Day())
        day.add(obs)
    report = {
        "records": {"total": total, "accepted": total - len(rejected), "rejected": len(rejected)},
        "rejected": rejected,
        "stations": {
            sid: {"name": s["name"], "days": {d: s["days"][d].summary() for d in sorted(s["days"])}}
            for sid, s in sorted(stations.items())
        },
    }
    log.info("processed %d records: %d accepted, %d rejected", total, report["records"]["accepted"], len(rejected))
    return report
