"""Weekly meal plans."""

from .recipe import Recipe
from .units import normalize

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


class MealPlan:
    """An ordered set of (day, recipe, servings) slots."""

    def __init__(self):
        self._slots = []

    def add(self, day: str, recipe: Recipe, servings=None) -> None:
        """Plan a recipe for a day. servings defaults to the recipe's own."""
        day = day.lower()
        if day not in DAYS:
            raise ValueError(f"unknown day {day!r}")
        self._slots.append((day, recipe, servings if servings is not None else recipe.serves))

    def days(self):
        """Map of day -> list of recipe titles, in week order, skipping empty days."""
        out = {}
        for day in DAYS:
            titles = [r.title for d, r, _ in self._slots if d == day]
            if titles:
                out[day] = titles
        return out

    def ingredients(self):
        """Return a list of every ingredient the plan needs.

        Each slot's recipe is scaled to that slot's servings and every
        quantity is normalized to base units. Slots are visited in the order
        they were added.
        """
        for _day, recipe, servings in self._slots:
            yield from (normalize(i) for i in recipe.scaled(servings).ingredients)
