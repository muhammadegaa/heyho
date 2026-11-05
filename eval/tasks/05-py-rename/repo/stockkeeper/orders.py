"""Order lines written as ``3 x WIDGET-01`` or ``2.5 kg BEANS-1KG``."""

from dataclasses import dataclass

from .quantities import Quantity, parse_qty


@dataclass(frozen=True)
class OrderLine:
    sku: str
    quantity: Quantity


def parse_order_line(line):
    parts = line.split()
    if len(parts) < 2:
        raise ValueError(f"expected a quantity and a SKU: {line!r}")
    *amount, sku = parts
    if len(amount) > 1 and amount[-1] in ("x", "*"):
        amount = amount[:-1]
    return OrderLine(sku.upper(), parse_qty(" ".join(amount)))


def parse_order(text):
    """Parse one order line per row; blank rows and ``#`` comments are ignored."""
    lines = []
    for number, row in enumerate(text.splitlines(), start=1):
        row = row.split("#", 1)[0].strip()
        if not row:
            continue
        try:
            lines.append(parse_order_line(row))
        except ValueError as exc:
            raise ValueError(f"line {number}: {exc}") from None
    return lines
