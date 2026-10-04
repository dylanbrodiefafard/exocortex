import unittest

from meal.planner import MealPlan
from meal.recipe import parse_recipe

from .fixtures import BREAD, OMELETTE, PANCAKES


class MealPlanTests(unittest.TestCase):
    def test_days_in_week_order(self):
        plan = MealPlan()
        plan.add("wed", parse_recipe(BREAD))
        plan.add("Mon", parse_recipe(PANCAKES))
        plan.add("mon", parse_recipe(OMELETTE))
        self.assertEqual(plan.days(), {"mon": ["Pancakes", "Omelette"], "wed": ["Country bread"]})

    def test_unknown_day(self):
        with self.assertRaises(ValueError):
            MealPlan().add("someday", parse_recipe(BREAD))

    def test_ingredients_scaled_and_normalized(self):
        plan = MealPlan()
        plan.add("sat", parse_recipe(OMELETTE), servings=2)
        names = [(i.name, str(i.quantity.amount), i.quantity.unit) for i in plan.ingredients()]
        self.assertEqual(names, [("egg", "6", "pc"), ("milk", "30", "ml"), ("butter", "40", "g")])


if __name__ == "__main__":
    unittest.main()
