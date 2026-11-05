"""Stock levels per SKU and location."""

from .quantities import Quantity


class OutOfStock(Exception):
    pass


class Inventory:
    """Stock levels keyed by ``(sku, location)``.

    Each level keeps the unit it was first received in; later movements are
    converted to that unit.
    """

    def __init__(self):
        self._levels = {}

    def level(self, sku, location="main"):
        return self._levels.get((sku, location))

    def levels(self):
        return dict(self._levels)

    def receive(self, sku, quantity, location="main"):
        current = self._levels.get((sku, location))
        if current is None:
            self._levels[(sku, location)] = quantity
            return quantity
        added = quantity.to(current.unit)
        updated = Quantity(current.amount + added.amount, current.unit)
        self._levels[(sku, location)] = updated
        return updated

    def take(self, sku, quantity, location="main"):
        current = self._levels.get((sku, location))
        if current is None:
            raise OutOfStock(f"no {sku} at {location}")
        taken = quantity.to(current.unit)
        if taken.amount > current.amount:
            raise OutOfStock(f"only {current} of {sku} at {location}, wanted {quantity}")
        updated = Quantity(current.amount - taken.amount, current.unit)
        self._levels[(sku, location)] = updated
        return updated
