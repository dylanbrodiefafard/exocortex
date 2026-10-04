import subprocess
import sys
import unittest
from pathlib import Path

from meal import MealPlan, Pantry, Quantity, build_list, parse_recipe
from meal.recipe import Ingredient

from .fixtures import BREAD, OMELETTE, PANCAKES

ROOT = Path(__file__).resolve().parent.parent


class ImportTests(unittest.TestCase):
    def test_each_module_imports_in_a_fresh_interpreter(self):
        for stmt in (
            "import meal.units",
            "import meal.recipe",
            "import meal.planner",
            "import meal.shopping",
            "from meal.units import normalize, Quantity, parse_quantity, format_quantity, UNITS",
            "from meal.recipe import Ingredient, Recipe, parse_recipe",
            "from meal import Ingredient, MealPlan, Pantry, build_list, normalize",
        ):
            proc = subprocess.run([sys.executable, "-c", stmt], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, f"{stmt}: {proc.stderr}")

    def test_ingredient_lives_in_recipe(self):
        self.assertEqual(Ingredient.__module__, "meal.recipe")

    def test_normalize_returns_recipe_ingredient(self):
        from meal.units import normalize

        got = normalize(Ingredient("flour", Quantity(1, "kg")))
        self.assertIsInstance(got, Ingredient)
        self.assertEqual(got, Ingredient("flour", Quantity(1000, "g")))


class PlanIngredientsTests(unittest.TestCase):
    def test_returns_a_reusable_list(self):
        plan = MealPlan()
        plan.add("mon", parse_recipe(PANCAKES))
        plan.add("tue", parse_recipe(OMELETTE))
        first = plan.ingredients()
        self.assertIsInstance(first, list)
        self.assertEqual(len(first), 7)
        self.assertEqual(plan.ingredients(), first)
        first.clear()
        self.assertEqual(len(plan.ingredients()), 7)


class PantryIndependenceTests(unittest.TestCase):
    def test_default_pantries_are_independent(self):
        a = Pantry()
        a.add("rice", Quantity(1, "kg"))
        b = Pantry()
        self.assertIsNone(b.available("rice"))
        self.assertIsNone(Pantry().available("rice"))

    def test_initial_mapping_is_copied(self):
        stock = {"flour": Quantity(1, "kg")}
        p = Pantry(stock)
        p.add("flour", Quantity(500, "g"))
        p.add("sugar", Quantity(100, "g"))
        self.assertEqual(stock, {"flour": Quantity(1, "kg")})
        self.assertEqual(p.available("flour"), Quantity(1500, "g"))

    def test_build_list_leaves_pantry_alone(self):
        p = Pantry({"flour": Quantity(2, "kg")})
        plan = MealPlan()
        plan.add("sun", parse_recipe(BREAD))
        build_list(plan, p)
        build_list(plan, p)
        self.assertEqual(p.available("flour"), Quantity(2000, "g"))


class BuildListTests(unittest.TestCase):
    def test_optional_first_does_not_drop_items(self):
        plan = MealPlan()
        plan.add("mon", parse_recipe("# Tea\nserves: 1\n- 1 tsp honey (optional)\n- 250 ml water\n- 2 g tea\n"))
        plan.add("tue", parse_recipe(OMELETTE))
        got = [str(i) for i in build_list(plan)]
        self.assertEqual(got, ["butter: 20 g", "egg: 3 pc", "milk: 15 ml", "tea: 2 g", "water: 250 ml"])
        got = [str(i) for i in build_list(plan, include_optional=True)]
        self.assertIn("honey: 5 ml", got)

    def test_scaled_week(self):
        plan = MealPlan()
        plan.add("sat", parse_recipe(PANCAKES), servings=8)
        plan.add("sun", parse_recipe(BREAD), servings=4)
        got = [str(i) for i in build_list(plan, Pantry({"egg": Quantity(1, "pc")}))]
        self.assertEqual(got, ["egg: 3 pc", "flour: 750 g", "milk: 240 ml", "salt: 5 ml", "water: 175 ml", "yeast: 3.5 g"])


if __name__ == "__main__":
    unittest.main()
