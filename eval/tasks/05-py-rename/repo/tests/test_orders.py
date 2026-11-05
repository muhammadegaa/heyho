import unittest
from decimal import Decimal

from stockkeeper import OrderLine, Quantity, parse_order


class OrderTests(unittest.TestCase):
    def test_parse_order(self):
        text = """
        # Monday restock
        3 x WIDGET-01
        2.5 kg beans-1kg   # loose
        12 * CUP-S
        6 BOX-7
        """
        self.assertEqual(
            parse_order(text),
            [
                OrderLine("WIDGET-01", Quantity(Decimal("3"), "ea")),
                OrderLine("BEANS-1KG", Quantity(Decimal("2.5"), "kg")),
                OrderLine("CUP-S", Quantity(Decimal("12"), "ea")),
                OrderLine("BOX-7", Quantity(Decimal("6"), "ea")),
            ],
        )

    def test_errors_name_the_line(self):
        with self.assertRaisesRegex(ValueError, "^line 2: "):
            parse_order("1 WIDGET-01\nlots WIDGET-02\n")
        with self.assertRaisesRegex(ValueError, "^line 1: expected a quantity and a SKU"):
            parse_order("WIDGET-01")


if __name__ == "__main__":
    unittest.main()
