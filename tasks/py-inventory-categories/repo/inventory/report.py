def summarize(store):
    """Totals for an inventory store."""
    items = store.items()
    return {
        "item_count": len(items),
        "total_quantity": sum(item.quantity for item in items),
        "total_value": round(sum(item.value for item in items), 2),
    }
