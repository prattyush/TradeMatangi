"""Read-only strategy price projection shared by chart clients."""
def strategy_line_price(instance) -> float | None:
    metadata = instance.metadata
    price = None
    if instance.strategy_type in ("TargetProfit", "UnderlyingTargetProfit"):
        value = metadata.get("target_profit_value")
        if value is not None and not metadata.get("target_profit_is_pct", False):
            price = float(value)
    elif instance.strategy_type == "LockProfit":
        value = metadata.get("lock_profit_price", metadata.get("lock_profit_value"))
        if value is not None and not metadata.get("lock_profit_is_pct", False):
            price = float(value)
    elif instance.strategy_type == "UnderlyingStoploss":
        value = metadata.get("underlying_sl_price")
        if value is not None:
            price = float(value)
    return price
