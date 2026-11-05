"""Import stock receipts from CSV exports.

Columns: ``sku`` and ``quantity`` are required; ``unit`` (used when the
quantity has none) and ``location`` are optional.
"""

import csv
from dataclasses import dataclass, field

from .quantities import parse_qty as qty

REQUIRED_COLUMNS = ("sku", "quantity")


@dataclass
class ImportResult:
    received: int = 0
    errors: list = field(default_factory=list)


def import_receipts(handle, inventory, default_location="main"):
    reader = csv.DictReader(handle)
    missing = [column for column in REQUIRED_COLUMNS if column not in (reader.fieldnames or [])]
    if missing:
        raise ValueError(f"missing columns: {', '.join(missing)}")

    result = ImportResult()
    for row_number, row in enumerate(reader, start=2):
        sku = (row["sku"] or "").strip()
        if not sku:
            result.errors.append(f"row {row_number}: no sku")
            continue
        try:
            quantity = qty(row["quantity"] or "", default_unit=(row.get("unit") or "ea").strip())
        except ValueError as exc:
            result.errors.append(f"row {row_number}: {exc}")
            continue
        location = (row.get("location") or "").strip() or default_location
        inventory.receive(sku, quantity, location)
        result.received += 1
    return result
