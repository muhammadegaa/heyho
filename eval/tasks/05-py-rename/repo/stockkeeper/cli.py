"""Command line: ``python3 -m stockkeeper convert|report``."""

import argparse
import sys

from stockkeeper import quantities
from stockkeeper.importer import import_receipts
from stockkeeper.inventory import Inventory


def build_parser():
    parser = argparse.ArgumentParser(prog="stockkeeper")
    commands = parser.add_subparsers(dest="command", required=True)

    convert = commands.add_parser("convert", help="convert a quantity to another unit")
    convert.add_argument("amount", help='for example "1.5 kg"')
    convert.add_argument("--to", required=True, metavar="UNIT")

    report = commands.add_parser("report", help="import receipt CSVs and print stock levels")
    report.add_argument("files", nargs="+", metavar="CSV")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "convert":
        try:
            converted = quantities.parse_qty(args.amount).to(args.to)
        except ValueError as exc:
            print(f"stockkeeper: {exc}", file=sys.stderr)
            return 1
        print(converted)
        return 0

    inventory = Inventory()
    errors = []
    for path in args.files:
        with open(path, newline="", encoding="utf-8") as handle:
            errors += [f"{path}: {error}" for error in import_receipts(handle, inventory).errors]
    for (sku, location), quantity in sorted(inventory.levels().items()):
        print(f"{sku}\t{location}\t{quantity}")
    for error in errors:
        print(f"warning: {error}", file=sys.stderr)
    return 0
