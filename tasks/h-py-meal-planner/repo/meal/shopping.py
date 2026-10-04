"""Turning a meal plan into a shopping list."""

from dataclasses import dataclass

from .units import Quantity, format_quantity


@dataclass(frozen=True)
class ShoppingItem:
    name: str
    quantity: Quantity

    def __str__(self):
        return f"{self.name}: {format_quantity(self.quantity)}"


class Pantry:
    """What is already in the kitchen.

    stock is an optional initial mapping of ingredient name -> Quantity. The
    pantry keeps its own copy; changing the pantry never changes the mapping
    that was passed in, and every Pantry() starts out independent.
    """

    def __init__(self, stock={}):
        self._stock = stock
        for name, qty in list(self._stock.items()):
            self._stock[name] = qty.to_base()

    def add(self, name: str, quantity: Quantity) -> None:
        name = name.lower()
        have = self._stock.get(name)
        self._stock[name] = quantity.to_base() if have is None else have + quantity

    def available(self, name: str):
        """The quantity on hand (in base units), or None."""
        return self._stock.get(name.lower())


def build_list(plan, pantry=None, include_optional=False):
    """The shopping list for a plan.

    Quantities of the same ingredient are summed across all recipes (in base
    units), then whatever the pantry already holds is subtracted; items that
    are fully covered are left out. Optional ingredients are skipped unless
    include_optional is true. The pantry is not modified. The list is sorted
    by ingredient name.
    """
    items = plan.ingredients()
    if not include_optional and any(i.optional for i in items):
        items = [i for i in items if not i.optional]

    totals = {}
    for ing in items:
        have = totals.get(ing.name)
        totals[ing.name] = ing.quantity if have is None else have + ing.quantity

    out = []
    for name in sorted(totals):
        need = totals[name]
        if pantry is not None:
            have = pantry.available(name)
            if have is not None and have.dimension == need.dimension:
                need = need - have
        if need.amount > 0:
            out.append(ShoppingItem(name, need))
    return out
