"""Product catalog and tag search."""

import warnings
from dataclasses import dataclass, field

from storefront._log import get_logger
from storefront.money import format_money

log = get_logger(__name__)


def normalize_tags(tags, into=[]):
    """Lower-case, strip and de-duplicate ``tags``, preserving first-seen order.

    Returns a new list unless ``into`` is given, in which case the tags are
    appended to it.
    """
    for tag in tags:
        tag = tag.strip().lower()
        if tag and tag not in into:
            into.append(tag)
    return into


@dataclass
class Product:
    sku: str
    name: str
    price: float
    cost: float = 0.0
    tags: list = field(default_factory=list)

    def __post_init__(self):
        if self.price < 0:
            raise ValueError(f"negative price for {self.sku}")
        self.tags = normalize_tags(self.tags)
        if self.cost and self.price < self.cost:
            log.warning("product %s priced below cost (%s < %s)", self.sku,
                        format_money(self.price), format_money(self.cost))

    @property
    def margin(self):
        if not self.price:
            return 0.0
        return (self.price - self.cost) / self.price

    def label(self):
        return f"{self.name} ({format_money(self.price)})"


class Catalog:
    def __init__(self):
        self._products = {}

    def add(self, product):
        if product.sku in self._products:
            raise KeyError(f"duplicate sku {product.sku}")
        log.debug("catalog add %r", product)
        self._products[product.sku] = product

    def get(self, sku):
        return self._products[sku]

    def __len__(self):
        return len(self._products)

    def __iter__(self):
        return iter(sorted(self._products.values(), key=lambda p: p.sku))

    def find(self, name):
        warnings.warn(
            f"Catalog.find({name!r}) is deprecated; use Catalog.search(text=...)",
            DeprecationWarning,
            stacklevel=2,
        )
        return self.search(text=name)

    def search(self, text="", tags=(), max_price=None):
        """Products whose name contains ``text`` (case-insensitive) and that carry
        every tag in ``tags`` (normalized like product tags)."""
        wanted = normalize_tags(tags)
        needle = text.lower()
        results = []
        for product in self:
            if needle and needle not in product.name.lower():
                continue
            if any(tag not in product.tags for tag in wanted):
                continue
            if max_price is not None and product.price > max_price:
                continue
            results.append(product)
        log.debug("search text=%r tags=%r max_price=%r -> %d results", text, wanted, max_price, len(results))
        return results
