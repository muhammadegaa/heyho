import unittest
from decimal import Decimal

from stockkeeper import Inventory, OutOfStock, Quantity


def q(amount, unit):
    return Quantity(Decimal(amount), unit)


class InventoryTests(unittest.TestCase):
    def test_receive_keeps_the_first_unit(self):
        stock = Inventory()
        stock.receive("BEANS-1KG", q("20", "kg"))
        stock.receive("BEANS-1KG", q("500", "g"))
        self.assertEqual(stock.level("BEANS-1KG"), q("20.5", "kg"))

    def test_locations_are_separate(self):
        stock = Inventory()
        stock.receive("WIDGET-01", q("10", "ea"), "main")
        stock.receive("WIDGET-01", q("4", "ea"), "shop")
        self.assertEqual(stock.level("WIDGET-01", "shop"), q("4", "ea"))
        self.assertEqual(len(stock.levels()), 2)

    def test_take(self):
        stock = Inventory()
        stock.receive("MILK", q("2", "l"))
        self.assertEqual(stock.take("MILK", q("250", "ml")), q("1.75", "l"))
        with self.assertRaises(OutOfStock):
            stock.take("MILK", q("2", "l"))
        with self.assertRaises(OutOfStock):
            stock.take("MILK", q("1", "l"), "shop")


if __name__ == "__main__":
    unittest.main()
