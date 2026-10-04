from dataclasses import dataclass


@dataclass(frozen=True)
class Item:
    sku: str
    name: str
    quantity: int
    unit_price: float

    @property
    def value(self):
        return self.quantity * self.unit_price
