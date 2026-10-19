"""Preserve fractional strikes while retaining legacy integer cache/key formats."""

from math import isfinite


def strike_number(value):
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("Strike must be numeric")
    parsed = float(value)
    if not isfinite(parsed):
        raise ValueError("Strike must be finite")
    return int(parsed) if parsed.is_integer() else parsed
