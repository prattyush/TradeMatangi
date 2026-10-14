"""Confirmed multi-day executions for delivery/overnight books.

Opening inventory is separate evidence, never a fabricated historical trade.
"""

from collections import defaultdict
from datetime import UTC, datetime

from app.services import broker_reports as reports


def merge_executions(previous, current):
    """Replace feed deltas only when the trade book covers their cumulative fill."""
    official = defaultdict(list)
    for row in current:
        official[(row.get("exchange", ""), reports.order_id(row))].append(row)
    retained = []
    for row in previous:
        group = official.get((row.get("exchange", ""), reports.order_id(row)), [])
        if row.get("_live_delta"):
            known = sum(
                r["quantity"]
                for r in previous
                if reports.order_id(r) == reports.order_id(row)
                and r.get("exchange", "") == row.get("exchange", "")
            )
            actual = sum(r["quantity"] for r in group)
            if group and actual >= known:
                continue
            # Retain the feed evidence while incomplete reports are catching up.
            continue_current = bool(group)
            if continue_current:
                official.pop((row.get("exchange", ""), reports.order_id(row)), None)
        retained.append(dict(row))
    retained.extend(row for group in official.values() for row in group)
    unique = {}
    for row in retained:
        key = (row.get("exchange", ""), reports.order_id(row), row["execution_id"])
        old = unique.get(key)
        if old and any(
            old.get(k) != row.get(k) for k in ("side", "quantity", "price", "timestamp")
        ):
            raise ValueError(
                "Conflicting execution evidence; manual reconciliation required"
            )
        unique[key] = dict(row)
    return list(unique.values())


def holding_positions(session, holdings, day_positions):
    """Add authoritative equity holdings to day delivery changes, without double counting."""
    if not isinstance(holdings, list):
        raise TypeError("Broker holdings report is unavailable")
    total, value = 0, 0.0
    for raw in holdings:
        symbol = (
            raw.get("tradingsymbol")
            or raw.get("displaySymbol")
            or raw.get("trdSym")
            or raw.get("symbol")
            or ""
        )
        candidate = {"symbol": symbol, "product": "CNC"}
        if not reports.in_book(session, candidate):
            continue
        if raw.get("quantity") in (None, "", "NA", "-", "--"):
            raise ValueError(
                "Broker holding quantity is unavailable; reconciliation is pending"
            )
        quantity = int(reports.number(raw.get("quantity"))) + int(
            reports.number(raw.get("t1_quantity"))
        )
        used = int(reports.number(raw.get("used_quantity")))
        if quantity < 0 or used < 0:
            raise ValueError("Invalid broker holdings quantity")
        # Kite quantity includes holdings sold today; positions.net contains the sale.
        # Kotak sellable quantity is authorization/availability, not economic quantity.
        total += quantity
        value += quantity * reports.number(
            raw.get("average_price", raw.get("averagePrice"))
        )
    day_net = sum(
        p["quantity"]
        * (1 if p["side"] == "LONG" else -1 if p["side"] == "SHORT" else 0)
        for p in day_positions
    )
    net = total + day_net
    if not total:
        return day_positions
    if net < 0:
        raise ValueError(
            "Delivery quantity is short; manual broker reconciliation required"
        )
    return [
        {
            "symbol": session.symbol,
            "product": "CNC",
            "broker_exchange": "nse_cm",
            "right": None,
            "strike": None,
            "expiry": None,
            "side": "LONG" if net else "FLAT",
            "quantity": net,
            "avg_entry_price": value / total if total else 0,
            "broker_opening_quantity": total,
            "broker_opening_avg_entry_price": value / total if total else 0,
        }
    ]


def today(row, date):
    return datetime.fromtimestamp(int(row["timestamp"]), UTC).date().isoformat() == date


def import_basis(session, positions, bundle):
    """Combine opening broker basis with confirmed day fills, without importing trades."""
    from copy import copy

    from app.services import fifo_positions

    if session.instrument_type != "equity" or not any(
        p.get("broker_opening_quantity") for p in positions
    ):
        return positions
    executions = [row for row in bundle.executions if reports.in_book(session, row)]
    expected = {"BUY": 0, "SELL": 0}
    for raw in bundle.positions:
        if reports.in_book(session, reports.normalize_order(raw)):
            for side, key in (("BUY", "flBuyQty"), ("SELL", "flSellQty")):
                if key in raw:
                    expected[side] += int(reports.number(raw[key]))
    actual = {
        side: sum(row["quantity"] for row in executions if row["side"] == side)
        for side in expected
    }
    if any(expected[side] != actual[side] for side in expected) and any(
        expected.values()
    ):
        raise ValueError(
            "Day execution history is incomplete; import basis cannot be verified"
        )
    context = copy(session)
    context.opening_positions = [
        {
            **p,
            "quantity": p["broker_opening_quantity"],
            "avg_entry_price": p["broker_opening_avg_entry_price"],
        }
        for p in positions
        if p.get("broker_opening_quantity")
    ]
    rebuilt = fifo_positions.verified_positions(context, executions, positions)
    return [
        {
            **row,
            "entry_commission": 0,
            "cost_basis": "broker_opening_plus_confirmed_day_fills",
        }
        for row in rebuilt
        if row["quantity"]
    ]
