import argparse
import json
import sys

from wxetl.pipeline import run


def main(argv=None):
    ap = argparse.ArgumentParser(prog="wxetl", description="Aggregate hourly station observations by UTC day.")
    ap.add_argument("path")
    ap.add_argument("--out", help="write the JSON report here instead of stdout")
    args = ap.parse_args(argv)
    report = run(args.path)
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
