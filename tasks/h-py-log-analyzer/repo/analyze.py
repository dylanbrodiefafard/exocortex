"""Summarize a service log file.

    python3 analyze.py logs/app.log          # human-readable summary
    python3 analyze.py logs/app.log --json   # machine-readable report
"""

import argparse
import json
import sys

from logscan.report import analyze_file


def render_text(report):
    out = [
        "lines:     %d" % report["lines"],
        "entries:   %d" % report["entries"],
        "unparsed:  %d" % report["unparsed"],
        "window:    %s .. %s" % (report["first_ts"], report["last_ts"]),
        "",
        "levels:",
    ]
    out += ["  %-6s %d" % (level, n) for level, n in report["levels"].items()]
    out += ["", "errors by service:"]
    out += ["  %-14s %d" % (svc, n) for svc, n in report["errors_by_service"].items()]
    out += ["", "top error codes:"]
    out += ["  %-8s %d" % (code, n) for code, n in report["top_error_codes"]]
    out += ["", "exceptions (root cause):"]
    out += ["  %-45s %d" % (cls, n) for cls, n in report["exceptions"].items()]
    return "\n".join(out)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Summarize a service log file.")
    parser.add_argument("path")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args(argv)
    report = analyze_file(args.path)
    if args.json:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(render_text(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
