"""Quantities and unit conversion.

Every unit belongs to a dimension (mass, volume or count) and converts to
that dimension's base unit: grams, millilitres, or pieces. Amounts are kept
as Fractions so scaling a recipe never introduces rounding error.
"""

from dataclasses import dataclass
from fractions import Fraction

from .recipe import Ingredient

# unit -> (dimension, size of one unit in the base unit)
UNITS = {
    "g": ("mass", Fraction(1)),
    "kg": ("mass", Fraction(1000)),
    "oz": ("mass", Fraction(2835, 100)),
    "lb": ("mass", Fraction(45359, 100)),
    "ml": ("volume", Fraction(1)),
    "l": ("volume", Fraction(1000)),
    "tsp": ("volume", Fraction(5)),
    "tbsp": ("volume", Fraction(15)),
    "cup": ("volume", Fraction(240)),
    "pc": ("count", Fraction(1)),
}

BASE_UNITS = {"mass": "g", "volume": "ml", "count": "pc"}


class UnitError(ValueError):
    """Raised for unknown units or for mixing dimensions."""


@dataclass(frozen=True)
class Quantity:
    amount: Fraction
    unit: str

    def __post_init__(self):
        if self.unit not in UNITS:
            raise UnitError(f"unknown unit {self.unit!r}")
        object.__setattr__(self, "amount", Fraction(self.amount))

    @property
    def dimension(self) -> str:
        return UNITS[self.unit][0]

    def to_base(self) -> "Quantity":
        """The same quantity expressed in its dimension's base unit."""
        factor = UNITS[self.unit][1]
        return Quantity(self.amount * factor, BASE_UNITS[self.dimension])

    def scaled(self, factor) -> "Quantity":
        return Quantity(self.amount * Fraction(factor), self.unit)

    def __add__(self, other: "Quantity") -> "Quantity":
        if not isinstance(other, Quantity):
            return NotImplemented
        if other.dimension != self.dimension:
            raise UnitError(f"cannot add {other.unit} to {self.unit}")
        if other.unit == self.unit:
            return Quantity(self.amount + other.amount, self.unit)
        return Quantity(self.to_base().amount + other.to_base().amount, BASE_UNITS[self.dimension])

    def __sub__(self, other: "Quantity") -> "Quantity":
        if not isinstance(other, Quantity):
            return NotImplemented
        return self + other.scaled(-1)


def _parse_amount(text: str) -> Fraction:
    parts = text.split()
    if not parts:
        raise ValueError("missing amount")
    total = Fraction(0)
    for part in parts:
        total += Fraction(part)
    return total


def parse_quantity(text: str) -> Quantity:
    """Parse "200 g", "1/2 cup", "1 1/2 tbsp" or a bare count like "3".

    A bare number is a count in pieces.
    """
    words = text.strip().split()
    if not words:
        raise ValueError("empty quantity")
    if words[-1].lower() in UNITS:
        unit = words[-1].lower()
        amount = _parse_amount(" ".join(words[:-1]))
    else:
        try:
            amount = _parse_amount(" ".join(words))
        except ValueError:
            raise UnitError(f"unknown unit {words[-1]!r}") from None
        unit = "pc"
    if amount <= 0:
        raise ValueError(f"quantity must be positive: {text!r}")
    return Quantity(amount, unit)


def normalize(ingredient: Ingredient) -> Ingredient:
    """A copy of the ingredient with its quantity in base units."""
    return Ingredient(ingredient.name, ingredient.quantity.to_base(), ingredient.optional)


def _number(amount: Fraction) -> str:
    rounded = round(amount, 1)
    if rounded == int(rounded):
        return str(int(rounded))
    return f"{float(rounded):.1f}"


def format_quantity(quantity: Quantity) -> str:
    """Human-readable form in base units, switching to kg / l from 1000 up.

    Amounts are rounded to one decimal place: "750 g", "1.5 kg", "3 pc".
    """
    base = quantity.to_base()
    amount, unit = base.amount, base.unit
    if unit == "g" and amount >= 1000:
        amount, unit = amount / 1000, "kg"
    elif unit == "ml" and amount >= 1000:
        amount, unit = amount / 1000, "l"
    return f"{_number(amount)} {unit}"
