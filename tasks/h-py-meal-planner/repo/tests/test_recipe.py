import unittest
from fractions import Fraction

from meal.recipe import Ingredient, Recipe, RecipeError, parse_recipe
from meal.units import Quantity, normalize

from .fixtures import PANCAKES


class ParseRecipeTests(unittest.TestCase):
    def test_parses_pancakes(self):
        r = parse_recipe(PANCAKES)
        self.assertEqual(r.title, "Pancakes")
        self.assertEqual(r.serves, 4)
        self.assertEqual(
            r.ingredients,
            [
                Ingredient("flour", Quantity(250, "g")),
                Ingredient("egg", Quantity(2, "pc")),
                Ingredient("milk", Quantity(Fraction(1, 2), "cup")),
                Ingredient("sugar", Quantity(1, "tbsp"), optional=True),
            ],
        )

    def test_missing_serves(self):
        with self.assertRaises(RecipeError):
            parse_recipe("# Toast\n- 2 bread\n")

    def test_bad_line_reports_line_number(self):
        with self.assertRaisesRegex(RecipeError, "line 3"):
            parse_recipe("# Toast\nserves: 1\n- lots of bread\n")


class ScaleTests(unittest.TestCase):
    def test_scaled(self):
        r = parse_recipe(PANCAKES).scaled(6)
        self.assertEqual(r.serves, 6)
        self.assertEqual(r.ingredients[0], Ingredient("flour", Quantity(375, "g")))
        self.assertEqual(r.ingredients[2].quantity, Quantity(Fraction(3, 4), "cup"))

    def test_scaled_does_not_change_original(self):
        r = parse_recipe(PANCAKES)
        r.scaled(2)
        self.assertEqual(r.ingredients[0].quantity, Quantity(250, "g"))

    def test_normalize(self):
        ing = Ingredient("milk", Quantity(Fraction(1, 2), "cup"), optional=True)
        self.assertEqual(normalize(ing), Ingredient("milk", Quantity(120, "ml"), optional=True))

    def test_recipe_is_plain_data(self):
        self.assertEqual(Recipe("x", 1).ingredients, [])


if __name__ == "__main__":
    unittest.main()
