"""Shopping carts, discounts and totals."""

import warnings
from dataclasses import dataclass

from storefront import tax
from storefront._log import get_logger
from storefront.money import cents, format_money

log = get_logger(__name__)


@dataclass(frozen=True)
class LineItem:
    sku: str
    unit_price: float
    quantity: int

    @property
    def subtotal(self):
        return cents(self.unit_price * self.quantity) / 100


class Cart:
    def __init__(self, region, catalog=None, inventory=None):
        self.region = region
        self.catalog = catalog
        self.inventory = inventory
        self._lines = {}
        self._discounts = []

    def add(self, sku, quantity=1, unit_price=None):
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        if unit_price is None:
            if self.catalog is None:
                raise ValueError("unit_price required when the cart has no catalog")
            unit_price = self.catalog.get(sku).price
        if self.inventory is not None:
            self.inventory.reserve(sku, quantity)
        existing = self._lines.get(sku)
        if existing:
            quantity += existing.quantity
        self._lines[sku] = LineItem(sku, unit_price, quantity)
        log.debug("cart %s: %r", self.region, self._lines[sku])

    def remove(self, sku):
        line = self._lines.pop(sku)
        if self.inventory is not None:
            self.inventory.release(sku, line.quantity)

    def lines(self):
        return [self._lines[sku] for sku in sorted(self._lines)]

    def apply_discount(self, percent=0, amount=0.0, code=None):
        if not 0 <= percent <= 100:
            raise ValueError("percent must be between 0 and 100")
        if amount < 0:
            raise ValueError("amount must be >= 0")
        self._discounts.append((percent, amount, code))
        log.info("discount %s applied: %s%% / %s", code or "(manual)", percent, format_money(amount))

    def apply_coupon(self, code):
        warnings.warn(
            f"Cart.apply_coupon({code!r}) is deprecated; use Cart.apply_discount(code=...)",
            DeprecationWarning,
            stacklevel=2,
        )
        percent = int(code[-2:]) if code[-2:].isdigit() else 0
        self.apply_discount(percent=percent, code=code)

    @property
    def subtotal(self):
        return cents(sum(line.subtotal for line in self._lines.values())) / 100

    @property
    def discount_total(self):
        subtotal = self.subtotal
        total = 0.0
        for percent, amount, _code in self._discounts:
            total += subtotal * percent / 100 + amount
        return min(cents(total) / 100, subtotal)

    @property
    def taxable(self):
        return cents(self.subtotal - self.discount_total) / 100

    @property
    def tax(self):
        return tax.tax_for(self.taxable, self.region)

    @property
    def total(self):
        return cents(self.taxable + self.tax) / 100

    def summary(self):
        return {
            "lines": len(self._lines),
            "items": sum(line.quantity for line in self._lines.values()),
            "subtotal": format_money(self.subtotal),
            "discounts": format_money(self.discount_total),
            "tax": format_money(self.tax),
            "total": format_money(self.total),
        }
