"""
Traded patterns — the user's own labelled trades as pattern material (Phase 26, S10).

Every trade the user labels in Label Trades or in a live popup carries an expected and an actual (category, strategy). This
service reads those labels so the Pattern Library can list the strategies the user really trades, show the trades behind
one of them, and copy a trade's entry and exit into a pattern chart as marks.

Cost: ``summary`` reads labels only (one indexed query for the user). ``list_traded`` rebuilds round trips per session, so it
looks at one strategy at a time and at its newest ``limit`` labels only, one rebuild per session. Nothing is written except by
``save_traded``, which writes the same pattern chart record the Pattern Library does.
"""
from __future__ import annotations

import logging
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

MAX_LIMIT = 200
DEFAULT_LIMIT = 50
CHART_INTERVAL_MINUTES = 3  # a traded mark lands on the 3-minute bar the trade happened in


def setup_side(right: Optional[str], action: str) -> Optional[str]:
    """The side of a deep dive a position belongs to: the direction it profits from (the same rule as the screens).

    Long equity or index and CE bought are Buy, PE sold is Buy; short equity, CE sold and PE bought are Sell.
    """
    action = (action or "").upper()
    if action not in ("BUY", "SELL"):
        return None
    long = action == "BUY"
    put = (right or "").upper() == "PE"
    return "buy" if long != put else "sell"


def _matches(label: dict, category: str, strategy: str) -> Optional[str]:
    expected = (label["expected_category"], label["expected_strategy"]) == (category, strategy)
    actual = (label["actual_category"], label["actual_strategy"]) == (category, strategy)
    return "both" if expected and actual else "expected" if expected else "actual" if actual else None


def _user_labels(user_id: str, start_date: Optional[str], end_date: Optional[str]) -> list[dict]:
    """The user's labels (one per round trip), a linked real session counted once, normalised."""
    from app.services import trade_label_service as labels

    params: dict = {"IndexName": "UserIdDateIndex"}
    if start_date and end_date:
        params.update(KeyConditionExpression="user_id = :uid AND #dt BETWEEN :s AND :e", ExpressionAttributeNames={"#dt": "date"},
                      ExpressionAttributeValues={":uid": user_id, ":s": start_date, ":e": end_date})
    elif start_date:
        params.update(KeyConditionExpression="user_id = :uid AND #dt >= :s", ExpressionAttributeNames={"#dt": "date"},
                      ExpressionAttributeValues={":uid": user_id, ":s": start_date})
    elif end_date:
        params.update(KeyConditionExpression="user_id = :uid AND #dt <= :e", ExpressionAttributeNames={"#dt": "date"},
                      ExpressionAttributeValues={":uid": user_id, ":e": end_date})
    else:
        params.update(KeyConditionExpression="user_id = :uid", ExpressionAttributeValues={":uid": user_id})
    table = labels._table()
    items: list[dict] = []
    while True:
        page = table.query(**params)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            break
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return [labels._serialize_label(item) for item in labels.canonical_labels(items)]


def summary(user_id: str, start_date: Optional[str] = None, end_date: Optional[str] = None) -> list[dict]:
    """Every (category, strategy) the user has labelled a trade with, as expected or actual, most recent first."""
    groups: dict[tuple[str, str], dict] = {}
    for label in _user_labels(user_id, start_date, end_date):
        seen: set[tuple[str, str]] = set()
        for kind in ("expected", "actual"):
            category, strategy = label[f"{kind}_category"], label[f"{kind}_strategy"]
            if not strategy:
                continue
            group = groups.setdefault((category, strategy), {"category": category, "strategy": strategy, "expected": 0, "actual": 0,
                                                              "trades": 0, "last_date": "", "sessions": set()})
            group[kind] += 1
            if (category, strategy) not in seen:
                seen.add((category, strategy))
                group["trades"] += 1
                group["last_date"] = max(group["last_date"], label["date"])
                group["sessions"].add(label["session_id"])
    rows = [{**group, "sessions": len(group["sessions"])} for group in groups.values()]
    return sorted(rows, key=lambda r: (r["last_date"], r["trades"]), reverse=True)


def _volume_weighted(trades: list[dict]) -> tuple[float, int]:
    quantity = sum(int(t.get("quantity") or 0) for t in trades)
    if quantity <= 0:
        return float(trades[0].get("price") or 0), 0
    return sum(float(t.get("price") or 0) * int(t.get("quantity") or 0) for t in trades) / quantity, quantity


def trade_item(label: dict, trip: dict, matched_as: str) -> Optional[dict]:
    """One labelled round trip as the Pattern Library needs it: what was traded and when it went in and out."""
    entries, exits = trip.get("entry_trades") or [], trip.get("exit_trades") or []
    if not entries:
        return None
    action = str(entries[0].get("side", "")).upper()
    entry_price, entry_quantity = _volume_weighted(entries)
    item = {
        "session_id": label["session_id"], "round_trip_index": label["round_trip_index"], "date": label["date"],
        "symbol": label["symbol"], "session_type": label["session_type"], "instrument_type": label["instrument_type"],
        "right": trip.get("right"), "strike": trip.get("strike"), "expiry": trip.get("expiry"),
        "action": action, "side": setup_side(trip.get("right"), action), "state": trip.get("state", "closed"),
        "entry": {"time": int(entries[0]["timestamp"]), "price": round(entry_price, 2), "quantity": entry_quantity},
        "exit": None, "pnl": float(trip.get("pnl") or 0), "pnl_pct": trip.get("pnl_pct"),
        "expected": {"category": label["expected_category"], "strategy": label["expected_strategy"]},
        "actual": {"category": label["actual_category"], "strategy": label["actual_strategy"]},
        "matched_as": matched_as,
    }
    if exits:
        exit_price, exit_quantity = _volume_weighted(exits)
        item["exit"] = {"time": int(exits[-1]["timestamp"]), "price": round(exit_price, 2), "quantity": exit_quantity}
    return item


def _round_trips(session_id: str, cache: dict) -> Optional[dict]:
    from app.services import trade_label_service as labels

    if session_id not in cache:
        try:
            cache[session_id] = {int(trip["index"]): trip for trip in labels.compute_round_trips_for_session(session_id)}
        except Exception:
            logger.warning("traded patterns: round trips unavailable for session %s", session_id, exc_info=True)
            cache[session_id] = None
    return cache[session_id]


def list_traded(user_id: str, category: str, strategy: str, start_date: Optional[str] = None, end_date: Optional[str] = None,
                limit: int = DEFAULT_LIMIT) -> dict:
    """The user's trades labelled with this strategy (as expected or actual), newest first, with entry and exit.

    ``truncated`` says more labels exist than ``limit``; ``unavailable`` counts labels whose round trip could not be read.
    """
    limit = max(1, min(int(limit), MAX_LIMIT))
    matching = [(label, how) for label in _user_labels(user_id, start_date, end_date)
                if (how := _matches(label, category, strategy))]
    matching.sort(key=lambda pair: (pair[0]["date"], pair[0]["session_id"], pair[0]["round_trip_index"]), reverse=True)
    chosen = matching[:limit]
    cache: dict = {}
    trades, unavailable = [], 0
    for label, how in chosen:
        trips = _round_trips(label["session_id"], cache)
        trip = trips.get(label["round_trip_index"]) if trips else None
        item = trade_item(label, trip, how) if trip else None
        if item is None:
            unavailable += 1
        else:
            trades.append(item)
    return {"category": category, "strategy": strategy, "trades": trades, "total": len(matching),
            "truncated": len(matching) > len(chosen), "unavailable": unavailable}


def marks_for(item: dict, category: str, strategy: str) -> list[dict]:
    """A trade's entry and exit as pattern marks (type entry / exit) on the instrument that was traded, on its 3-minute bars."""
    instrument = item["right"] if item.get("right") in ("CE", "PE") else "underlying"
    bar = CHART_INTERVAL_MINUTES * 60
    marks = []
    for kind, leg in (("entry", item["entry"]), ("exit", item.get("exit"))):
        if not leg:
            continue
        marks.append({
            "id": str(uuid.uuid4()), "time": leg["time"] - leg["time"] % bar, "price": leg["price"], "type": kind,
            "instrument": instrument, "strategy_name": strategy, "category": category,
            "text": f"{category} — {strategy} ({kind} {instrument})",
        })
    return marks


def save_traded(user_id: str, session_id: str, round_trip_index: int, category: str, strategy: str) -> dict:
    """Copy one labelled trade's entry and exit into the pattern chart of its day, as marks of this strategy.

    The trade must be the user's own and labelled with this strategy (as expected or actual). The marks join the day's own
    pattern chart (merged by mark id) or start one; a chart on other strikes is refused. The user then edits it in Annotate.
    """
    from app.services import pattern_logger_service as patterns
    from app.services import trade_label_service as labels

    session = labels._load_session(session_id)
    if not session or session.get("user_id") != user_id:
        raise LookupError("Trade not found")
    label = next((row for row in map(labels._serialize_label, labels.get_labels_for_session(session_id))
                  if row["round_trip_index"] == int(round_trip_index)), None)
    if not label or not _matches(label, category, strategy):
        raise ValueError("This trade was not labelled with that strategy")
    trips = _round_trips(session_id, {})
    trip = trips.get(int(round_trip_index)) if trips else None
    item = trade_item(label, trip, _matches(label, category, strategy)) if trip else None
    if item is None:
        raise LookupError("The trade could not be read")
    marks = marks_for(item, category, strategy)
    strike = int(item["strike"]) if item.get("strike") else None
    return patterns.save_marks_to_chart(
        user_id, item["symbol"], item["date"], marks,
        strike_ce=strike if item["right"] == "CE" else None, strike_pe=strike if item["right"] == "PE" else None,
        interval_minutes=CHART_INTERVAL_MINUTES)
