"""Plain-text reports printed by the nightly jobs."""

from storefront.money import format_money
from storefront.text import truncate


def sales_table(rows, width=40):
    """Render ``[(name, quantity, revenue), ...]`` as a fixed-width table."""
    lines = [f"{'product':<{width}} {'qty':>5} {'revenue':>14}", "-" * (width + 21)]
    total_qty = 0
    total_revenue = 0.0
    for name, quantity, revenue in rows:
        lines.append(f"{truncate(name, width):<{width}} {quantity:>5} {format_money(revenue):>14}")
        total_qty += quantity
        total_revenue += revenue
    lines.append("-" * (width + 21))
    lines.append(f"{'TOTAL':<{width}} {total_qty:>5} {format_money(total_revenue):>14}")
    return "\n".join(lines)


def print_sales(rows, width=40):
    table = sales_table(rows, width)
    print(table)
    return table


def inventory_dump(inventory):
    snapshot = inventory.snapshot()
    for sku, (on_hand, reserved) in snapshot.items():
        print(f"INVENTORY {sku}: on_hand={on_hand} reserved={reserved} available={on_hand - reserved}")
    return snapshot
