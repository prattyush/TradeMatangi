"""Read-time correction of legacy website event snapshots.

Before ``capture_v`` 2 the website captured a fill snapshot *before* the fill had been
applied to its position / trade state, so every ``order_filled`` snapshot showed the
state from just before the fill.  Stored data is never rewritten: this module re-derives
the post-fill state when snapshots are read, from the snapshot's own pre-fill state plus
the trade itself, using only the prices already recorded in that snapshot.
"""
from __future__ import annotations

import copy
import logging
from collections import deque
from typing import Any, Callable

logger = logging.getLogger(__name__)

FILL_EVENT = "order_filled"
_PRICE_EPS = 0.011
_TYPE_RANK = {"order_placed": 0, FILL_EVENT: 2}


def sort_key(item: dict) -> tuple:
    """Chronological key: tick time, then wall-clock capture time, then seq, then type."""
    snap = item.get("snapshot") or {}
    event = item.get("event") or {}
    return (
        item.get("timestamp", 0),
        snap.get("event_timestamp") or 0,
        snap.get("seq") or 0,
        _TYPE_RANK.get(event.get("type"), 1),
        item.get("event_id", ""),
    )


def is_legacy_website(item: dict) -> bool:
    snap = item.get("snapshot") or {}
    return bool(snap) and "capture_v" not in snap and "positions_by_contract" not in snap


def needs_correction(item: dict) -> bool:
    return is_legacy_website(item) and (item.get("event") or {}).get("type") == FILL_EVENT


def _fifo_position(trades: list[dict]) -> tuple[str, int, float]:
    """FIFO-match trades into the still-open lots; mirrors trading.get_position."""
    longs: deque = deque()
    shorts: deque = deque()
    for t in trades:
        remaining = int(t.get("quantity") or 0)
        price = float(t.get("price") or 0)
        opposite, same = (shorts, longs) if t.get("side") == "BUY" else (longs, shorts)
        while remaining > 0 and opposite:
            lot_price, lot_qty = opposite[0]
            matched = min(remaining, lot_qty)
            remaining -= matched
            if matched == lot_qty:
                opposite.popleft()
            else:
                opposite[0] = (lot_price, lot_qty - matched)
        if remaining > 0:
            same.append((price, remaining))
    lots, side = (longs, "LONG") if longs else (shorts, "SHORT") if shorts else (None, "FLAT")
    if not lots:
        return "FLAT", 0, 0.0
    qty = sum(q for _, q in lots)
    return side, qty, sum(p * q for p, q in lots) / qty


def _leg_pnl(side: str, qty: int, avg: float, price: float) -> tuple[float, float]:
    if side == "FLAT" or qty == 0:
        return 0.0, 0.0
    pnl = (1 if side == "LONG" else -1) * (price - avg) * qty
    invested = avg * qty
    return pnl, (round(pnl / invested * 100, 2) if invested > 0 else 0.0)


def _mtm(side: str, qty: int, price: float) -> float:
    if side == "FLAT" or qty == 0 or price <= 0:
        return 0.0
    return (1 if side == "LONG" else -1) * qty * price


def summarize_positions(capital: float, legs: list[dict]) -> dict:
    """Summary-bar figures shared by website (legacy correction) and desktop snapshots.

    ``legs`` are position dicts (side, quantity, avg_entry_price, pnl). P&L is open
    positions only and gross of brokerage; wallet is capital + that open P&L.
    """
    open_legs = [p for p in legs if p.get("side") != "FLAT"]
    combined = sum(p.get("pnl", 0) for p in open_legs)
    invested = sum(p["quantity"] * p["avg_entry_price"] for p in open_legs)
    return {
        "combined_pnl": round(combined, 2),
        "combined_pnl_pct": round(combined / invested * 100, 2) if invested > 0 else 0,
        "wallet_balance": round(capital + combined, 2),
        "wallet_used_pct": round(invested / capital * 100, 2) if capital > 0 else 0,
        "active_positions": len(open_legs),
    }


def _matches(trade: dict, details: dict) -> bool:
    if trade.get("side") != details.get("side"):
        return False
    if (trade.get("right") or None) != (details.get("right") or None):
        return False
    if int(trade.get("quantity") or 0) != int(details.get("quantity") or 0):
        return False
    return abs(float(trade.get("price") or 0) - float(details.get("filled_price") or 0)) <= _PRICE_EPS


def _find_fill_trade(items: list[dict], index: int, used: set[str]) -> dict | None:
    """The trade this fill created: first one in a later snapshot that this one lacks."""
    snap = items[index]["snapshot"]
    details = (items[index].get("event") or {}).get("details") or {}
    have = {t.get("trade_id") for t in snap.get("filled_trades") or []}
    for later in items[index + 1:]:
        for t in (later.get("snapshot") or {}).get("filled_trades") or []:
            tid = t.get("trade_id")
            if tid in have or tid in used:
                continue
            if _matches(t, details):
                return t
    return None


def _details_trade(item: dict) -> dict | None:
    """Fallback for the last event: build the trade from the event's own details."""
    snap, details = item["snapshot"], (item.get("event") or {}).get("details") or {}
    if not details.get("side") or not details.get("filled_price") or not details.get("quantity"):
        return None
    existing = snap.get("filled_trades") or []
    if existing and _matches(existing[-1], details):
        return None  # the fill was already present when the snapshot was taken
    right = details.get("right") or None
    return {
        "trade_id": f"legacy:{item.get('event_id')}", "side": details["side"],
        "price": float(details["filled_price"]), "quantity": int(details["quantity"]),
        "right": right, "strike": snap.get("strike_ce") if right == "CE" else snap.get("strike_pe") if right == "PE" else None,
        "expiry": snap.get("expiry"), "timestamp": int(item.get("timestamp") or 0),
    }


def _drop_filled_order(open_orders: list[dict], trade: dict, details: dict) -> list[dict]:
    tid = trade.get("trade_id")
    if any(o.get("order_id") == tid for o in open_orders):
        return [o for o in open_orders if o.get("order_id") != tid]
    trigger = details.get("trigger_price")
    for i, o in enumerate(open_orders):
        if (o.get("side") == details.get("side") and (o.get("right") or None) == (details.get("right") or None)
                and int(o.get("quantity") or 0) == int(details.get("quantity") or 0)
                and (trigger is None or abs(float(o.get("trigger_price") or o.get("limit_price") or 0) - float(trigger)) <= _PRICE_EPS)):
            return open_orders[:i] + open_orders[i + 1:]
    return open_orders


def _apply_fill(item: dict, trade: dict, commission: float) -> dict:
    out = copy.deepcopy(item)
    snap, event = out["snapshot"], out.setdefault("event", {})
    details = event.get("details") or {}
    capital = float(snap.get("session_capital") or 0)
    is_options = out.get("instrument_type") == "options"
    right = trade.get("right") or None
    price_of = {None: snap.get("current_price"), "CE": snap.get("current_price_ce"), "PE": snap.get("current_price_pe")}
    leg_key = {None: "position", "CE": "position_ce", "PE": "position_pe"}[right]
    price = float(price_of[right] or 0)

    old = snap.get(leg_key) or {}
    old_side, old_qty = old.get("side", "FLAT"), int(old.get("quantity") or 0)
    trades_after = list(snap.get("filled_trades") or []) + [trade]
    leg_trades = [t for t in trades_after if (t.get("right") or None) == right
                  and (right is None or t.get("strike") == trade.get("strike"))]
    side, qty, avg = _fifo_position(leg_trades)
    pnl, pnl_pct = _leg_pnl(side, qty, avg, price)
    snap[leg_key] = {"side": side, "quantity": qty, "avg_entry_price": avg, "pnl": pnl, "pnl_pct": pnl_pct}

    # Session P&L moves by the fill's cash flow + change in open-lot value - its commission.
    counted = (is_options and right is not None) or (not is_options and right is None)
    delta = -commission
    if counted:
        value = float(trade["price"]) * int(trade["quantity"])
        delta += (value if trade.get("side") == "SELL" else -value) + _mtm(side, qty, price) - _mtm(old_side, old_qty, price)
    session_pnl = round(float(snap.get("session_pnl") or 0) + delta, 2)

    legs = [snap["position"]] + ([snap["position_ce"], snap["position_pe"]] if is_options else [])
    summary = summarize_positions(capital, legs)
    combined_pct, active = summary["combined_pnl_pct"], summary["active_positions"]
    snap.update({
        **summary,
        "session_pnl": session_pnl,
        "session_pnl_pct": round(session_pnl / capital * 100, 2) if capital > 0 else 0,
        "filled_trades": trades_after,
        "open_orders": _drop_filled_order(list(snap.get("open_orders") or []), trade, details),
        "legacy_corrected": True,
    })
    details.update({
        "_walletBalance": snap["wallet_balance"], "_combinedPnl": snap["combined_pnl"], "_combinedPnlPct": combined_pct,
        "_sessionPnl": session_pnl, "_sessionPnlPct": snap["session_pnl_pct"], "_activePositions": active,
        "_openOrderCount": len([o for o in snap["open_orders"] if o.get("status") == "PENDING"]),
        "_positionEquity": f"{snap['position']['side']} {snap['position']['quantity']}",
    })
    event["details"] = details
    return out


def _load_commissions(session_id: str) -> dict[str, float]:
    from app.services.db import get_dynamodb_resource
    from app.services.performance_service import query_all
    items = query_all(get_dynamodb_resource().Table("Trades"), KeyConditionExpression="session_id = :s",
                      ExpressionAttributeValues={":s": session_id}, ConsistentRead=True)
    return {str(i["trade_id"]): float(i.get("commission") or 0) for i in items}


def correct(session_id: str, items: list[dict], commissions: Callable[[str], dict[str, float]] | None = None) -> list[dict]:
    """Return ``items`` (already chronologically sorted) with legacy fill events corrected.

    Never raises: on any failure the stored snapshots are returned unchanged.
    """
    if not any(needs_correction(i) for i in items):
        return items
    try:
        comm = (commissions or _load_commissions)(session_id)
        used: set[str] = set()
        result: list[Any] = []
        for index, item in enumerate(items):
            if not needs_correction(item):
                result.append(item)
                continue
            trade = _find_fill_trade(items, index, used)
            if trade is None and index == len(items) - 1:
                trade = _details_trade(item)
            if trade is None:
                result.append(item)
                continue
            used.add(trade.get("trade_id"))
            commission = trade.get("commission")
            if commission is None:
                commission = comm.get(str(trade.get("trade_id")))
            if commission is None:
                from app.models.schemas import TradeSide
                from app.services.trading import compute_commission
                commission = compute_commission(TradeSide(trade["side"]), float(trade["price"]), int(trade["quantity"]))
            result.append(_apply_fill(item, trade, float(commission)))
        return result
    except Exception:
        logger.exception("Legacy snapshot correction failed for session %s; returning stored snapshots", session_id)
        return items
