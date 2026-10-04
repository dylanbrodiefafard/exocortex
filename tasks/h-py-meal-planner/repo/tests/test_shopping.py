import unittest

from meal import MealPlan, Pantry, Quantity, build_list, parse_recipe

from .fixtures import BREAD, OMELETTE, PANCAKES


def week():
    plan = MealPlan()
    plan.add("sat", parse_recipe(PANCAKES))
    plan.add("sun", parse_recipe(BREAD))
    plan.add("sun", parse_recipe(OMELETTE), servings=2)
    return plan


class PantryTests(unittest.TestCase):
    def test_add_accumulates_in_base_units(self):
        p = Pantry()
        p.add("Flour", Quantity(200, "g"))
        p.add("flour", Quantity("0.3", "kg"))
        self.assertEqual(p.available("flour"), Quantity(500, "g"))

    def test_unknown_item(self):
        self.assertIsNone(Pantry().available("saffron"))


class ShoppingListTests(unittest.TestCase):
    def test_sums_across_recipes(self):
        got = [str(item) for item in build_list(week())]
        self.assertEqual(
            got,
            [
                "butter: 40 g",
                "egg: 8 pc",
                "flour: 750 g",
                "milk: 150 ml",
                "salt: 10 ml",
                "water: 350 ml",
                "yeast: 7 g",
            ],
        )

    def test_include_optional(self):
        got = {item.name for item in build_list(week(), include_optional=True)}
        self.assertIn("sugar", got)
        self.assertIn("egg", got)

    def test_plan_without_optional_items(self):
        plan = MealPlan()
        plan.add("mon", parse_recipe(OMELETTE))
        self.assertEqual([str(i) for i in build_list(plan)], ["butter: 20 g", "egg: 3 pc", "milk: 15 ml"])

    def test_empty_pantry_changes_nothing(self):
        self.assertEqual(build_list(week(), Pantry()), build_list(week()))

    def test_pantry_is_subtracted(self):
        pantry = Pantry({"flour": Quantity(1, "kg"), "egg": Quantity(6, "pc")})
        pantry.add("milk", Quantity(100, "ml"))
        got = [str(item) for item in build_list(week(), pantry)]
        self.assertEqual(
            got,
            ["butter: 40 g", "egg: 2 pc", "milk: 50 ml", "salt: 10 ml", "water: 350 ml", "yeast: 7 g"],
        )


if __name__ == "__main__":
    unittest.main()
