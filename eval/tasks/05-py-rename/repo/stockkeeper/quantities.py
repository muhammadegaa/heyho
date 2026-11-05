"""Quantities with units: parsing, conversion and formatting."""

import re
from dataclasses import dataclass
from decimal import Decimal

UNIT_ALIASES = {
    "ea": "ea",
    "each": "ea",
    "pc": "ea",
    "pcs": "ea",
    "x": "ea",
    "g": "g",
    "gram": "g",
    "grams": "g",
    "kg": "kg",
    "kilo": "kg",
    "kilos": "kg",
    "ml": "ml",
    "l": "l",
    "litre": "l",
    "litres": "l",
    "liter": "l",
    "box": "box",
    "boxes": "box",
}

CONVERSIONS = {
    ("kg", "g"): Decimal(1000),
    ("g", "kg"): Decimal("0.001"),
    ("l", "ml"): Decimal(1000),
    ("ml", "l"): Decimal("0.001"),
}

_QUANTITY = re.compile(r"(?P<amount>\d+(?:[.,]\d+)?)\s*(?P<unit>[A-Za-z]*)")
_RANGE = re.compile(r"(?P<low>.+?)\s*(?:-|\bto\b)\s*(?P<high>.+)")


@dataclass(frozen=True)
class Quantity:
    amount: Decimal
    unit: str

    def to(self, unit):
        """Convert to another unit; raises ValueError if the units are unrelated."""
        if unit == self.unit:
            return self
        factor = CONVERSIONS.get((self.unit, unit))
        if factor is None:
            raise ValueError(f"cannot convert {self.unit} to {unit}")
        return Quantity(self.amount * factor, unit)

    def __str__(self):
        return format_quantity(self)


def parse_qty(text, default_unit="ea"):
    """Parse a quantity such as ``3``, ``2.5 kg``, ``250g`` or ``1,5 l``.

    A bare number gets ``default_unit``. Raises ValueError for anything else.
    """
    match = _QUANTITY.fullmatch(text.strip())
    if match is None:
        raise ValueError(f"not a quantity: {text!r}")
    unit_text = match["unit"].lower()
    unit = UNIT_ALIASES.get(unit_text) if unit_text else default_unit
    if unit is None:
        raise ValueError(f"unknown unit {match['unit']!r} in {text!r}")
    return Quantity(Decimal(match["amount"].replace(",", ".")), unit)


def parse_qty_range(text, default_unit="ea"):
    """Parse a range like ``2-5 kg`` or ``100g to 1kg`` into ``(low, high)``.

    Each end is read with :func:`parse_qty`. A unit written only on the upper
    end applies to both, and the lower end is converted to the upper end's unit.
    """
    match = _RANGE.fullmatch(text.strip())
    if match is None:
        raise ValueError(f"not a quantity range: {text!r}")
    high = parse_qty(match["high"], default_unit)
    low = parse_qty(match["low"], high.unit).to(high.unit)
    if low.amount > high.amount:
        raise ValueError(f"range goes backwards: {text!r}")
    return low, high


def format_quantity(quantity):
    text = f"{quantity.amount.normalize():f}"
    return text if quantity.unit == "ea" else f"{text} {quantity.unit}"
