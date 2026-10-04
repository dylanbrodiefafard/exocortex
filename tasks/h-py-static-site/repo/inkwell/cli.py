"""Command line interface.

Errors the user can fix are printed as ``inkwell: error: <message>`` and
exit with status 1. Usage errors exit with status 2.
"""

import argparse
import sys
from pathlib import Path

from inkwell import __version__
from inkwell.config import default_config, load_config
from inkwell.errors import InkwellError
from inkwell.filters import all_filters
from inkwell.site.builder import build_site
from inkwell.template import Environment, FileLoader


def _parser():
    parser = argparse.ArgumentParser(prog="inkwell", description="A small static site generator.")
    parser.add_argument("--version", action="version", version=f"inkwell {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="render the site into the output directory")
    build.add_argument("--config", default="site.ini", help="path to site.ini (default: ./site.ini)")
    build.add_argument("--drafts", action="store_true", help="include pages marked draft")

    check = sub.add_parser("check", help="validate site.ini and parse every template")
    check.add_argument("--config", default="site.ini", help="path to site.ini (default: ./site.ini)")

    sub.add_parser("filters", help="list the filters available in templates")
    return parser


def _config(path):
    if path == "site.ini" and not Path(path).exists():
        return default_config()
    return load_config(path)


def cmd_build(args, out):
    config = _config(args.config)
    if args.drafts:
        config = config.with_drafts(True)
    result = build_site(config)
    print(f"wrote {len(result.written)} files to {config.output_dir}", file=out)
    return 0


def cmd_check(args, out):
    config = _config(args.config)
    loader = FileLoader(config.template_dir)
    env = Environment(config, loader)
    names = loader.names()
    for name in names:
        env.get_template(name)
    print(f"ok: {config.source}, {len(names)} templates", file=out)
    return 0


def cmd_filters(args, out):
    for spec in all_filters():
        print(f"{spec.name:<14} {spec.summary}".rstrip(), file=out)
    return 0


COMMANDS = {"build": cmd_build, "check": cmd_check, "filters": cmd_filters}


def main(argv=None, out=None, err=None):
    out = out or sys.stdout
    err = err or sys.stderr
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    try:
        return COMMANDS[args.command](args, out)
    except InkwellError as exc:
        print(f"inkwell: error: {exc}", file=err)
        return 1
