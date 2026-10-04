# wxetl

Nightly ETL for the regional weather-station network. Collectors dump a month of hourly
observations as CSV; `wxetl` validates every record and aggregates per-station daily
statistics for the forecasting team.

```
python3 -m wxetl data/observations.csv              # JSON report on stdout
python3 -m wxetl data/observations.csv --out r.json
```

`data/observations.csv` is not checked in. Generate the reference month with
`python3 tools/gen_obs.py --seed 11 > data/observations.csv`.

Run the tests with `python3 -m unittest discover -s tests -t .`.

## Input format

UTF-8 CSV (RFC 4180 quoting: fields containing commas are wrapped in double quotes), one
record per line. Line 1 is the header

```
station_id,station_name,timestamp,temp_c,humidity_pct,wind_kph,precip_mm,flags
```

Blank lines and lines starting with `#` are ignored and are not records. Every other line
is a record. Line numbers in the report are physical line numbers in the file (the header
is line 1).

A record is **accepted** if all of the following hold, and **rejected** otherwise. The
rejection reason is the name of the first offending field in the order below, or
`field_count`.

| Field | Rule |
|---|---|
| (all) | exactly 8 fields (`field_count`) |
| `station_id` | 4 characters, `A-Z` or `0-9` |
| `station_name` | not blank |
| `timestamp` | `YYYY-MM-DDTHH:MM:SS` followed by `Z` or a `±HH:MM` UTC offset, and a real date and time |
| `temp_c` | plain decimal (`-12`, `3.5`; no exponent, `nan`, `inf`, spaces or commas) in `-90..60`; `M` or empty means missing |
| `humidity_pct` | integer `0..100`; empty means missing |
| `wind_kph` | plain decimal `>= 0`; empty means missing |
| `precip_mm` | plain decimal `>= 0`; `T` means a trace (counts as 0.0 mm and as one trace hour); empty means missing |
| `flags` | zero or more of `A-Z` |

A record with missing values is still accepted; the missing values are just left out of
the statistics.

## Report

(abridged; these are the numbers for the reference month)

```json
{
  "records": {"total": 5952, "accepted": 5889, "rejected": 63},
  "rejected": [{"line": 140, "reason": "wind_kph"}, {"line": 282, "reason": "field_count"}, ...],
  "stations": {
    "KBOS": {
      "name": "Logan Intl Airport",
      "days": {
        "2024-03-01": {"obs": 24, "temp_min": -8.1, "temp_max": 6.2, "temp_mean": -0.7,
                        "precip_mm": 5.1, "trace_hours": 4, "wind_max_kph": 27.9},
        ...
      }
    }
  }
}
```

- Records are bucketed by their **UTC** date.
- `obs` counts accepted records; `temp_*` use the records with a temperature (`null` if
  none), `temp_mean` rounded to one decimal; `precip_mm` is the sum of the non-missing
  amounts rounded to one decimal; `wind_max_kph` is `null` if no record has wind.

## Logging

Every record is logged by the `wxetl.pipeline` logger: one INFO line per accepted record
and one WARNING line per rejected record, each starting with `line <n>:`. Ops audits these
logs line by line, so they must stay at those levels and must not be dropped or batched.
