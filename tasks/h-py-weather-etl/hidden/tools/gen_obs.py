"""Generate a deterministic month of hourly station observations as CSV (stdout)."""

import argparse
import csv
import random
import sys
from datetime import datetime, timedelta, timezone

STATIONS = [
    ("KBOS", "Logan Intl Airport", 0),
    ("KMWN", "Mount Washington, NH", -5),
    ("KBHL", "Blue Hill Observatory, Milton, MA", 0),
    ("KPVD", "T.F. Green Airport", -5),
    ("KORH", "Worcester Regional", 0),
    ("KACK", "Nantucket Memorial, MA", 0),
    ("KBDL", "Bradley Intl", -4),
    ("KCON", "Concord Municipal", 0),
]

HEADER = ["station_id", "station_name", "timestamp", "temp_c", "humidity_pct", "wind_kph", "precip_mm", "flags"]

BAD_TIMESTAMPS = ["2024-03-1T05:00:00Z", "2024-02-30T01:00:00Z", "yesterday", "2024-03-05 07:00:00Z", "", "2024-03-07T25:00:00Z"]
BAD_TEMPS = ["--", "12,5", "warm", "1e999", "nan"]


def fmt_ts(t, offset_h):
    local = t.astimezone(timezone(timedelta(hours=offset_h)))
    if offset_h == 0:
        return local.strftime("%Y-%m-%dT%H:%M:%SZ")
    return local.isoformat()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--days", type=int, default=31)
    args = ap.parse_args(argv)
    rng = random.Random(args.seed)
    out = csv.writer(sys.stdout, lineterminator="\n")
    out.writerow(HEADER)
    start = datetime(2024, 3, 1, tzinfo=timezone.utc)
    base = {sid: rng.uniform(-6.0, 8.0) for sid, _, _ in STATIONS}
    for hour in range(args.days * 24):
        t = start + timedelta(hours=hour)
        if rng.random() < 0.01:
            sys.stdout.write("# collector restarted at " + t.strftime("%Y-%m-%dT%H:%MZ") + "\n")
        if rng.random() < 0.01:
            sys.stdout.write("\n")
        for sid, name, offset in STATIONS:
            diurnal = 4.0 * (1 if 12 <= t.hour <= 20 else -1)
            temp = round(base[sid] + diurnal + rng.gauss(0, 2.5), 1)
            humidity = rng.randint(25, 100)
            wind = round(abs(rng.gauss(14, 9)), 1)
            r = rng.random()
            if r < 0.70:
                precip = "0.0"
            elif r < 0.80:
                precip = "T"
            elif r < 0.84:
                precip = ""
            else:
                precip = f"{rng.expovariate(1 / 1.8):.1f}"
            flags = rng.choice(["", "", "", "", "A", "E", "AE"])
            row = [sid, name, fmt_ts(t, offset), f"{temp}", str(humidity), f"{wind}", precip, flags]
            if rng.random() < 0.02:
                row[3] = "M" if rng.random() < 0.5 else ""
            if rng.random() < 0.012:
                kind = rng.randrange(6)
                if kind == 0:
                    row[2] = rng.choice(BAD_TIMESTAMPS)
                elif kind == 1:
                    row[3] = rng.choice(BAD_TEMPS)
                elif kind == 2:
                    row[4] = str(rng.choice([101, 130, -3]))
                elif kind == 3:
                    row = row[: rng.randint(2, 6)]
                elif kind == 4:
                    row = row + ["extra"]
                else:
                    row[5] = "-" + row[5] if row[5] != "0.0" else "-1.0"
            out.writerow(row)
    return 0


if __name__ == "__main__":
    sys.exit(main())
