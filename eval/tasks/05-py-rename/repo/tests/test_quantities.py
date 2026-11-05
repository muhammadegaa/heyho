import unittest
from decimal import Decimal

from stockkeeper.quantities import Quantity, format_quantity, parse_qty, parse_qty_range


class ParseQuantityTests(unittest.TestCase):
    def test_numbers_with_units(self):
        self.assertEqual(parse_qty("2.5 kg"), Quantity(Decimal("2.5"), "kg"))
        self.assertEqual(parse_qty("250g"), Quantity(Decimal("250"), "g"))
        self.assertEqual(parse_qty("1,5 L"), Quantity(Decimal("1.5"), "l"))
        self.assertEqual(parse_qty("3 boxes"), Quantity(Decimal("3"), "box"))

    def test_bare_numbers_use_the_default_unit(self):
        self.assertEqual(parse_qty("12"), Quantity(Decimal("12"), "ea"))
        self.assertEqual(parse_qty(" 750 ", default_unit="ml"), Quantity(Decimal("750"), "ml"))

    def test_rejects_garbage(self):
        for text in ("", "kg", "two", "3 parsecs", "-1"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    parse_qty(text)


class RangeTests(unittest.TestCase):
    def test_unit_on_the_upper_end_applies_to_both(self):
        self.assertEqual(
            parse_qty_range("2-5 kg"),
            (Quantity(Decimal("2"), "kg"), Quantity(Decimal("5"), "kg")),
        )

    def test_lower_end_is_converted(self):
        low, high = parse_qty_range("100g to 1kg")
        self.assertEqual(low, Quantity(Decimal("0.100"), "kg"))
        self.assertEqual(high, Quantity(Decimal("1"), "kg"))

    def test_backwards_and_malformed(self):
        for text in ("5-2", "2 kg - 5 l", "between 2 and 5"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    parse_qty_range(text)


class FormatAndConvertTests(unittest.TestCase):
    def test_format(self):
        self.assertEqual(format_quantity(Quantity(Decimal("2.50"), "kg")), "2.5 kg")
        self.assertEqual(format_quantity(Quantity(Decimal("1E+3"), "g")), "1000 g")
        self.assertEqual(str(Quantity(Decimal("4"), "ea")), "4")

    def test_convert(self):
        self.assertEqual(Quantity(Decimal("1.5"), "kg").to("g"), Quantity(Decimal("1500.0"), "g"))
        with self.assertRaises(ValueError):
            Quantity(Decimal("1"), "kg").to("l")


if __name__ == "__main__":
    unittest.main()
