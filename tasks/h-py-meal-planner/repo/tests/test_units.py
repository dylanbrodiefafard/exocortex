import unittest
from fractions import Fraction

from meal.units import Quantity, UnitError, format_quantity, parse_quantity


class ParseQuantityTests(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(parse_quantity("200 g"), Quantity(200, "g"))

    def test_fraction_and_mixed_number(self):
        self.assertEqual(parse_quantity("1/2 cup"), Quantity(Fraction(1, 2), "cup"))
        self.assertEqual(parse_quantity("1 1/2 tbsp"), Quantity(Fraction(3, 2), "tbsp"))

    def test_bare_number_is_count(self):
        self.assertEqual(parse_quantity("3"), Quantity(3, "pc"))

    def test_unknown_unit(self):
        with self.assertRaises(UnitError):
            parse_quantity("2 handfuls")

    def test_rejects_zero(self):
        with self.assertRaises(ValueError):
            parse_quantity("0 g")


class ArithmeticTests(unittest.TestCase):
    def test_to_base(self):
        self.assertEqual(Quantity(2, "tbsp").to_base(), Quantity(30, "ml"))
        self.assertEqual(Quantity(Fraction(3, 2), "kg").to_base(), Quantity(1500, "g"))

    def test_add_mixed_units(self):
        self.assertEqual(Quantity(1, "kg") + Quantity(250, "g"), Quantity(1250, "g"))

    def test_add_rejects_other_dimension(self):
        with self.assertRaises(UnitError):
            Quantity(1, "kg") + Quantity(1, "l")

    def test_format(self):
        self.assertEqual(format_quantity(Quantity(750, "g")), "750 g")
        self.assertEqual(format_quantity(Quantity(1500, "g")), "1.5 kg")
        self.assertEqual(format_quantity(Quantity(Fraction(1, 2), "cup")), "120 ml")
        self.assertEqual(format_quantity(Quantity(3, "pc")), "3 pc")


if __name__ == "__main__":
    unittest.main()
