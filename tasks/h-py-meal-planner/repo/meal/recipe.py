"""Recipes and the plain-text recipe format.

A recipe file looks like::

    # Pancakes
    serves: 4
    - 250 g flour
    - 2 egg
    - 1/2 cup milk
    - 1 tbsp sugar (optional)

The first line is the title. Ingredient lines start with "- ", then a
quantity (see units.parse_quantity), then the ingredient name. A trailing
"(optional)" marks the ingredient optional.
"""

from dataclasses import dataclass, field
from fractions import Fraction

from .units import UNITS, Quantity, parse_quantity


@dataclass(frozen=True)
class Ingredient:
    name: str
    quantity: Quantity
    optional: bool = False


@dataclass
class Recipe:
    title: str
    serves: int
    ingredients: list = field(default_factory=list)

    def scaled(self, servings) -> "Recipe":
        """A new recipe with every quantity scaled from self.serves to servings."""
        if servings is None or servings == self.serves:
            return Recipe(self.title, self.serves, list(self.ingredients))
        if servings <= 0:
            raise ValueError("servings must be positive")
        factor = Fraction(servings, self.serves)
        return Recipe(
            self.title,
            servings,
            [Ingredient(i.name, i.quantity.scaled(factor), i.optional) for i in self.ingredients],
        )


class RecipeError(ValueError):
    """A malformed recipe file. The message includes the line number."""


def _split_ingredient(body: str):
    words = body.split()
    for cut in range(len(words) - 1, 0, -1):
        if words[cut - 1].lower() in UNITS:
            return " ".join(words[:cut]), " ".join(words[cut:])
    for cut in range(len(words) - 1, 0, -1):
        try:
            Fraction(words[cut - 1])
        except ValueError:
            continue
        return " ".join(words[:cut]), " ".join(words[cut:])
    raise ValueError("expected a quantity followed by a name")


def parse_recipe(text: str) -> Recipe:
    lines = text.splitlines()
    title = None
    serves = None
    ingredients = []
    for lineno, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line:
            continue
        if title is None:
            if not line.startswith("# "):
                raise RecipeError(f"line {lineno}: expected '# Title'")
            title = line[2:].strip()
        elif line.lower().startswith("serves:"):
            try:
                serves = int(line.split(":", 1)[1])
            except ValueError:
                raise RecipeError(f"line {lineno}: serves must be a whole number") from None
            if serves <= 0:
                raise RecipeError(f"line {lineno}: serves must be positive")
        elif line.startswith("- "):
            body = line[2:].strip()
            optional = body.lower().endswith("(optional)")
            if optional:
                body = body[: -len("(optional)")].strip()
            try:
                qty_text, name = _split_ingredient(body)
                quantity = parse_quantity(qty_text)
            except ValueError as exc:
                raise RecipeError(f"line {lineno}: {exc}") from None
            ingredients.append(Ingredient(name.lower(), quantity, optional))
        else:
            raise RecipeError(f"line {lineno}: unexpected {line!r}")
    if title is None:
        raise RecipeError("empty recipe")
    if serves is None:
        raise RecipeError("missing 'serves:' line")
    return Recipe(title, serves, ingredients)
