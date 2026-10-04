"""Stock levels and reservations."""

from storefront._log import get_logger

log = get_logger(__name__)


class OutOfStock(Exception):
    def __init__(self, sku, requested, available):
        super().__init__(f"{sku}: requested {requested}, only {available} available")
        self.sku = sku
        self.requested = requested
        self.available = available


class Inventory:
    def __init__(self, low_stock_threshold=5):
        self.low_stock_threshold = low_stock_threshold
        self._on_hand = {}
        self._reserved = {}

    def receive(self, sku, quantity):
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        self._on_hand[sku] = self._on_hand.get(sku, 0) + quantity
        log.info("received %d x %s (on hand %d)", quantity, sku, self._on_hand[sku])

    def on_hand(self, sku):
        return self._on_hand.get(sku, 0)

    def reserved(self, sku):
        return self._reserved.get(sku, 0)

    def available(self, sku):
        return self.on_hand(sku) - self.reserved(sku)

    def reserve(self, sku, quantity):
        available = self.available(sku)
        if quantity > available:
            log.error("reservation failed: %s", OutOfStock(sku, quantity, available))
            raise OutOfStock(sku, quantity, available)
        self._reserved[sku] = self.reserved(sku) + quantity
        remaining = self.available(sku)
        if remaining <= self.low_stock_threshold:
            log.warning("low stock for %s: %d available after reserving %d", sku, remaining, quantity)
        return remaining

    def release(self, sku, quantity):
        if quantity > self.reserved(sku):
            raise ValueError(f"cannot release {quantity} of {sku}; only {self.reserved(sku)} reserved")
        self._reserved[sku] -= quantity

    def commit(self, sku, quantity):
        """Ship reserved stock: removes it from both reserved and on-hand."""
        self.release(sku, quantity)
        self._on_hand[sku] -= quantity
        log.info("committed %d x %s", quantity, sku)

    def try_reserve(self, sku, quantity):
        try:
            return self.reserve(sku, quantity)
        except OutOfStock:
            log.exception("try_reserve(%s, %d) could not be satisfied", sku, quantity)
            return None

    def snapshot(self):
        return {sku: (self.on_hand(sku), self.reserved(sku)) for sku in sorted(self._on_hand)}
