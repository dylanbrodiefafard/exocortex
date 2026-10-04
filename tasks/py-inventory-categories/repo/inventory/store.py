from inventory.models import Item


class Store:
    def __init__(self):
        self._items = {}

    def add(self, sku, name, quantity, unit_price):
        if quantity < 0:
            raise ValueError("quantity must be >= 0")
        if sku in self._items:
            raise KeyError(f"duplicate sku: {sku}")
        self._items[sku] = Item(sku, name, quantity, unit_price)

    def get(self, sku):
        return self._items[sku]

    def items(self):
        return list(self._items.values())
