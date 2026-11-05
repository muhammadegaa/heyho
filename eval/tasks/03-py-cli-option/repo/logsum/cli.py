"""Command-line interface."""

import argparse
import sys

from . import __version__
from .records import LEVELS, level_rank, read_records
from .render import render_json, render_text
from .summary import GROUP_KEYS, summarize


def positive_int(text):
    try:
        value = int(text)
    except ValueError:
        value = 0
    if value < 1:
        raise argparse.ArgumentTypeError(f"expected a positive whole number, got {text!r}")
    return value


def build_parser():
    parser = argparse.ArgumentParser(prog="logsum", description="Summarise application log files.")
    parser.add_argument("files", nargs="*", metavar="FILE", help="log files to read (default: stdin)")
    parser.add_argument(
        "--level",
        type=str.upper,
        choices=LEVELS,
        default="DEBUG",
        help="ignore entries below this level",
    )
    parser.add_argument("--by", choices=sorted(GROUP_KEYS), default="level", help="what to group entries by")
    parser.add_argument("--top", type=positive_int, metavar="N", help="show only the N largest groups")
    parser.add_argument("--format", choices=("text", "json"), default="text", help="output format")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        records, skipped = read_records(args.files)
    except OSError as exc:
        print(f"logsum: cannot read {exc.filename}: {exc.strerror}", file=sys.stderr)
        return 1

    minimum = level_rank(args.level)
    records = [record for record in records if level_rank(record.level) >= minimum]

    summary = summarize(records, by=args.by, top=args.top, skipped=skipped)
    render = render_json if args.format == "json" else render_text
    sys.stdout.write(render(summary))
    return 0
