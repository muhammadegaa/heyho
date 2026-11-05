import io
import unittest
from decimal import Decimal

from stockkeeper import Inventory, Quantity
from stockkeeper.importer import import_receipts

RECEIPTS = """\
sku,quantity,unit,location
BEANS-1KG,20 kg,,main
BEANS-1KG,500,g,main
MILK,6,l,shop
WIDGET-01,a dozen,,main
,4,,main
CUP-S,12,,
"""


class ImporterTests(unittest.TestCase):
    def test_import(self):
        stock = Inventory()
        result = import_receipts(io.StringIO(RECEIPTS), stock)
        self.assertEqual(result.received, 4)
        self.assertEqual(stock.level("BEANS-1KG"), Quantity(Decimal("20.5"), "kg"))
        self.assertEqual(stock.level("MILK", "shop"), Quantity(Decimal("6"), "l"))
        self.assertEqual(stock.level("CUP-S"), Quantity(Decimal("12"), "ea"))
        self.assertEqual(len(result.errors), 2)
        self.assertTrue(result.errors[0].startswith("row 5: not a quantity"))
        self.assertEqual(result.errors[1], "row 6: no sku")

    def test_missing_columns(self):
        with self.assertRaisesRegex(ValueError, "missing columns: quantity"):
            import_receipts(io.StringIO("sku,amount\nX,1\n"), Inventory())


if __name__ == "__main__":
    unittest.main()
