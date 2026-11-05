import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from decimal import Decimal

import stockkeeper
from stockkeeper import cli, importer, orders, quantities
from stockkeeper import parse_quantity as exported_parse_quantity
from stockkeeper.quantities import Quantity, parse_qty_range, parse_quantity

OLD_NAME = "parse_" + "qty"


class RenamedApiTests(unittest.TestCase):
    def test_new_name_is_exported(self):
        self.assertIs(exported_parse_quantity, parse_quantity)
        self.assertIn("parse_quantity", stockkeeper.__all__)
        for name in stockkeeper.__all__:
            self.assertTrue(hasattr(stockkeeper, name), name)

    def test_old_name_is_gone(self):
        self.assertNotIn(OLD_NAME, stockkeeper.__all__)
        for module in (stockkeeper, quantities, orders, importer, cli):
            self.assertFalse(hasattr(module, OLD_NAME), module.__name__)

    def test_other_names_are_unchanged(self):
        self.assertIn("parse_qty_range", stockkeeper.__all__)
        self.assertIs(stockkeeper.parse_qty_range, parse_qty_range)
        self.assertFalse(hasattr(quantities, "parse_quantity_range"))
        self.assertEqual(parse_quantity.__name__, "parse_quantity")

    def test_behaviour_is_unchanged(self):
        self.assertEqual(parse_quantity("2.5 kg"), Quantity(Decimal("2.5"), "kg"))
        self.assertEqual(parse_quantity("12"), Quantity(Decimal("12"), "ea"))
        self.assertEqual(parse_quantity("750", default_unit="ml"), Quantity(Decimal("750"), "ml"))
        self.assertEqual(parse_quantity("1,5 litres"), Quantity(Decimal("1.5"), "l"))
        with self.assertRaises(ValueError):
            parse_quantity("3 parsecs")

    def test_range_still_works(self):
        self.assertEqual(
            parse_qty_range("250 to 500 g"),
            (Quantity(Decimal("250"), "g"), Quantity(Decimal("500"), "g")),
        )

    def test_orders_use_it(self):
        self.assertEqual(
            orders.parse_order("4 x WIDGET-01\n1.5kg BEANS-1KG"),
            [
                orders.OrderLine("WIDGET-01", Quantity(Decimal("4"), "ea")),
                orders.OrderLine("BEANS-1KG", Quantity(Decimal("1.5"), "kg")),
            ],
        )

    def test_importer_uses_it(self):
        stock = stockkeeper.Inventory()
        result = importer.import_receipts(io.StringIO("sku,quantity,unit\nMILK,2,l\nMILK,250ml,\n"), stock)
        self.assertEqual(result.received, 2)
        self.assertEqual(stock.level("MILK"), Quantity(Decimal("2.25"), "l"))

    def test_cli_uses_it(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(["convert", "2 kilos", "--to", "g"])
        self.assertEqual((code, out.getvalue(), err.getvalue()), (0, "2000 g\n", ""))


if __name__ == "__main__":
    unittest.main()
