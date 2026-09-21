"""
Trade label service — CRUD over DynamoDB TradeLabels table.
Round-trip computation, label persistence, stats aggregation, tag listing.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict, deque, Counter
from datetime import datetime, timezone
from decimal import Decimal

logger = logging.getLogger(__name__)

TABLE_NAME = "TradeLabels"

_ENSURED = False


def _ensure_table() -> None:
    global _ENSURED
    if _ENSURED:
        return
    try:
        from app.services.db import get_dynamodb_resource, get_dynamodb_client
        existing = set(get_dynamodb_resource().meta.client.list_tables()["TableNames"])
        if TABLE_NAME in existing:
            _ENSURED = True
            return
        get_dynamodb_client().create_table(
            TableName=TABLE_NAME,
            KeySchema=[
                {"AttributeName": "session_id", "KeyType": "HASH"},
                {"AttributeName": "round_trip_index", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "session_id", "AttributeType": "S"},
                {"AttributeName": "round_trip_index", "AttributeType": "N"},
                {"AttributeName": "user_id", "AttributeType": "S"},
                {"AttributeName": "date", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "UserIdDateIndex",
                    "KeySchema": [
                        {"AttributeName": "user_id", "KeyType": "HASH"},
                        {"AttributeName": "date", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                    "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        _ENSURED = True
        logger.info("Created %s table", TABLE_NAME)
    except Exception:
        logger.exception("Failed to ensure %s table")


class _DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def _table():
    _ensure_table()
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table(TABLE_NAME)


def _safe_float(val) -> float:
    if isinstance(val, Decimal):
        return float(val)
    return float(val) if val is not None else 0.0


def _load_session(session_id: str) -> dict | None:
    """Load a session record from DynamoDB."""
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Sessions")
        resp = table.get_item(Key={"session_id": session_id})
        return resp.get("Item")
    except Exception:
        logger.exception("Failed to load session %s", session_id)
        return None


def _contract_identity(trade: dict) -> tuple[str | None, int | None, str | None]:
    """Keep option strikes separate when producing desktop round trips."""
    strike = trade.get("strike")
    return (
        trade.get("right"),
        int(strike) if strike is not None else None,
        trade.get("expiry"),
    )


def compute_round_trip_state(trades: list[dict]) -> tuple[list[dict], list[dict]]:
    """Return completed and still-open FIFO round trips with stable global ids.

    A label is saved when the entry fills, so an open trade needs an index before
    its closing trade exists. Allocating the index at the zero-to-nonzero
    transition makes that id stable through exit. The contract identity includes
    expiry and strike; CE alone is insufficient for a desktop session.
    """
    completed: list[dict] = []
    open_trips: list[dict] = []
    legs: dict[tuple[str | None, int | None, str | None], dict] = {}
    next_index = 0

    for trade in sorted(trades, key=lambda item: (int(item.get("timestamp", 0)), str(item.get("trade_id", "")))):
        quantity = int(trade.get("quantity", 0))
        if quantity <= 0:
            continue
        key = _contract_identity(trade)
        state = legs.get(key)
        side = trade.get("side", "BUY")
        signed = quantity if side == "BUY" else -quantity
        if state is None or state["net_qty"] == 0:
            state = {
                "index": next_index,
                "right": key[0],
                "strike": key[1],
                "expiry": key[2],
                "net_qty": 0,
                "entry_trades": [],
                "exit_trades": [],
            }
            next_index += 1
            legs[key] = state

        # A trade in the same direction extends the entry. A trade in the
        # opposite direction is an exit; Stepwise does not allow a single fill
        # to cross through flat, so that is sufficient for the current engine.
        if state["net_qty"] == 0 or (state["net_qty"] > 0 and signed > 0) or (state["net_qty"] < 0 and signed < 0):
            state["entry_trades"].append(trade)
        else:
            state["exit_trades"].append(trade)
        state["net_qty"] += signed

        if state["net_qty"] == 0:
            all_trades = state["entry_trades"] + state["exit_trades"]
            total_buy = sum(_safe_float(item.get("price")) * int(item.get("quantity", 0)) for item in all_trades if item.get("side") == "BUY")
            total_sell = sum(_safe_float(item.get("price")) * int(item.get("quantity", 0)) for item in all_trades if item.get("side") == "SELL")
            completed.append({
                "index": state["index"],
                "right": state["right"],
                "strike": state["strike"],
                "expiry": state["expiry"],
                "entry_trades": [_serialize_rt_trade(item) for item in state["entry_trades"]],
                "exit_trades": [_serialize_rt_trade(item) for item in state["exit_trades"]],
                "pnl": round(total_sell - total_buy - sum(_safe_float(item.get("commission")) for item in all_trades), 2),
            })
            legs.pop(key, None)

    for state in legs.values():
        open_trips.append({
            "index": state["index"],
            "right": state["right"],
            "strike": state["strike"],
            "expiry": state["expiry"],
            "entry_trades": [_serialize_rt_trade(item) for item in state["entry_trades"]],
            "exit_trades": [_serialize_rt_trade(item) for item in state["exit_trades"]],
            "pnl": 0.0,
        })
    return completed, open_trips


def _fifo_match_trades(trades: list[dict]) -> list[dict]:
    return compute_round_trip_state(trades)[0]


def _serialize_rt_trade(t: dict) -> dict:
    return {
        "trade_id": t.get("trade_id", ""),
        "side": t.get("side", ""),
        "quantity": int(t.get("quantity", 0)),
        "price": _safe_float(t.get("price")),
        "timestamp": int(t.get("timestamp", 0)),
        "right": t.get("right"),
        "strike": int(t.get("strike")) if t.get("strike") is not None else None,
        "commission": _safe_float(t.get("commission")),
    }


def compute_round_trips_for_session(session_id: str) -> list[dict]:
    """Compute FIFO round-trips for a session."""
    try:
        from app.services.analysis_service import get_trades_for_session
        trades = get_trades_for_session(session_id)
        if not trades:
            return []
        return _fifo_match_trades(trades)
    except Exception:
        logger.exception("Failed to compute round trips for session %s", session_id)
        return []


def save_labels(session_id: str, labels: list[dict], user_id: str) -> list[dict]:
    """Batch upsert labels. Denormalizes PnL and session metadata."""
    session = _load_session(session_id)
    if not session:
        raise ValueError(f"Session {session_id} not found")

    session_capital = _safe_float(session.get("session_capital", 100000))
    symbol = session.get("symbol", "")
    date = session.get("date", "")
    instrument_type = session.get("instrument_type", "equity")
    session_type = session.get("session_type", "sim")

    now = datetime.now(timezone.utc).isoformat()

    saved = []
    table = _table()

    for lbl in labels:
        rt_idx = int(lbl.get("round_trip_index", 0))
        expected_cat = str(lbl.get("expected_category", ""))
        expected_strat = str(lbl.get("expected_strategy", ""))
        actual_cat = str(lbl.get("actual_category", "") or expected_cat)
        actual_strat = str(lbl.get("actual_strategy", "") or expected_strat)
        entry_tag = str(lbl.get("entry_tag", "") or "AS_PER_PATTERN")
        exit_tag = str(lbl.get("exit_tag", "") or "AS_PER_PATTERN")

        round_trips = compute_round_trips_for_session(session_id)
        rt = next((r for r in round_trips if r["index"] == rt_idx), None)
        rt_pnl = rt["pnl"] if rt else 0.0
        rt_pnl_pct = round(rt_pnl / session_capital * 100, 4) if session_capital > 0 else 0.0

        existing = table.get_item(Key={"session_id": session_id, "round_trip_index": rt_idx}).get("Item")
        created_at = existing.get("created_at", "") if existing else now

        item = {
            "session_id": session_id,
            "round_trip_index": rt_idx,
            "user_id": user_id,
            "symbol": symbol,
            "date": date,
            "instrument_type": instrument_type,
            "session_type": session_type,
            "round_trip_pnl": Decimal(str(rt_pnl)),
            "round_trip_pnl_pct": Decimal(str(rt_pnl_pct)),
            "expected_category": expected_cat,
            "expected_strategy": expected_strat,
            "actual_category": actual_cat,
            "actual_strategy": actual_strat,
            "entry_tag": entry_tag,
            "exit_tag": exit_tag,
            "created_at": created_at,
            "updated_at": now,
        }
        table.put_item(Item=item)
        saved.append(item)

    return [_serialize_label(item) for item in saved]


def get_labels_for_session(session_id: str) -> list[dict]:
    """Return all labels for a session."""
    try:
        table = _table()
        resp = table.query(
            KeyConditionExpression="session_id = :sid",
            ExpressionAttributeValues={":sid": session_id},
        )
        return [_serialize_label(item) for item in resp.get("Items", [])]
    except Exception:
        logger.exception("Failed to get labels for session %s", session_id)
        return []


def update_label(session_id: str, round_trip_index: int, label_data: dict) -> dict | None:
    """Update a single label."""
    now = datetime.now(timezone.utc).isoformat()
    table = _table()

    existing = table.get_item(Key={"session_id": session_id, "round_trip_index": round_trip_index}).get("Item")
    if not existing:
        return None

    updates = {}
    for field in ("expected_category", "expected_strategy", "actual_category",
                   "actual_strategy", "entry_tag", "exit_tag"):
        if field in label_data and label_data[field] is not None:
            updates[field] = str(label_data[field])

    item = {**existing, **updates, "updated_at": now}
    table.put_item(Item=item)
    return _serialize_label(item)


def delete_label(session_id: str, round_trip_index: int) -> None:
    """Delete a single label."""
    table = _table()
    table.delete_item(Key={"session_id": session_id, "round_trip_index": round_trip_index})


def list_entry_tags(user_id: str) -> list[str]:
    """Distinct entry_tag values for a user (excluding AS_PER_PATTERN)."""
    try:
        table = _table()
        resp = table.query(
            IndexName="UserIdDateIndex",
            KeyConditionExpression="user_id = :uid",
            ExpressionAttributeValues={":uid": user_id},
        )
        tags = set()
        for item in resp.get("Items", []):
            tag = item.get("entry_tag", "")
            if tag and tag != "AS_PER_PATTERN":
                tags.add(tag)
        return sorted(tags)
    except Exception:
        logger.exception("Failed to list entry tags for user %s", user_id)
        return []


def list_exit_tags(user_id: str) -> list[str]:
    """Distinct exit_tag values for a user (excluding AS_PER_PATTERN)."""
    try:
        table = _table()
        resp = table.query(
            IndexName="UserIdDateIndex",
            KeyConditionExpression="user_id = :uid",
            ExpressionAttributeValues={":uid": user_id},
        )
        tags = set()
        for item in resp.get("Items", []):
            tag = item.get("exit_tag", "")
            if tag and tag != "AS_PER_PATTERN":
                tags.add(tag)
        return sorted(tags)
    except Exception:
        logger.exception("Failed to list exit tags for user %s", user_id)
        return []


def get_stats(
    user_id: str,
    symbol: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    instrument_type: str | None = None,
    session_type: str | None = None,
) -> dict:
    """Aggregated stats from TradeLabels using the UserIdDateIndex GSI."""
    try:
        table = _table()

        if start_date and end_date:
            resp = table.query(
                IndexName="UserIdDateIndex",
                KeyConditionExpression="user_id = :uid AND #dt BETWEEN :s AND :e",
                ExpressionAttributeNames={"#dt": "date"},
                ExpressionAttributeValues={
                    ":uid": user_id,
                    ":s": start_date,
                    ":e": end_date,
                },
            )
        else:
            resp = table.query(
                IndexName="UserIdDateIndex",
                KeyConditionExpression="user_id = :uid",
                ExpressionAttributeValues={":uid": user_id},
            )

        labels = resp.get("Items", [])

        if symbol:
            labels = [l for l in labels if l.get("symbol") == symbol]
        if instrument_type:
            labels = [l for l in labels if l.get("instrument_type") == instrument_type]
        if session_type:
            labels = [l for l in labels if l.get("session_type") == session_type]

        if not labels:
            return _empty_stats()

        return _compute_stats(labels)
    except Exception:
        logger.exception("Failed to compute stats for user %s", user_id)
        return _empty_stats()


def _empty_stats() -> dict:
    return {
        "total_trades": 0,
        "win_pct": 0.0,
        "avg_pnl_pct": 0.0,
        "pnl_95th_percentile": 0.0,
        "per_pattern": [],
        "mismatch": {
            "mismatch_pct": 0.0,
            "profit_pct_matched": 0.0,
            "profit_pct_mismatched": 0.0,
            "most_mismatched_expected": None,
            "most_mismatched_actual": None,
        },
        "by_entry_tag": [],
        "by_exit_tag": [],
    }


def _compute_stats(labels: list[dict]) -> dict:
    total = len(labels)
    wins = sum(1 for l in labels if _safe_float(l.get("round_trip_pnl", 0)) > 0)
    win_pct = round(wins / total * 100, 2)

    pnl_pcts = [_safe_float(l.get("round_trip_pnl_pct", 0)) for l in labels]
    avg_pnl_pct = round(sum(pnl_pcts) / total, 4)
    pnl_pcts_sorted = sorted(pnl_pcts)
    idx_95 = max(0, int(total * 0.95) - 1)
    pnl_95th = round(pnl_pcts_sorted[min(idx_95, total - 1)], 4)

    pattern_groups = defaultdict(list)
    for l in labels:
        key = (l.get("expected_category", ""), l.get("expected_strategy", ""))
        pattern_groups[key].append(l)

    per_pattern = []
    for (cat, strat), items in pattern_groups.items():
        n = len(items)
        w = sum(1 for x in items if _safe_float(x.get("round_trip_pnl", 0)) > 0)
        per_pattern.append({
            "category": str(cat),
            "strategy": str(strat),
            "count": n,
            "win_pct": round(w / n * 100, 2),
            "avg_pnl_pct": round(sum(_safe_float(x.get("round_trip_pnl_pct", 0)) for x in items) / n, 4),
        })

    mismatched = [
        l for l in labels
        if (l.get("expected_category"), l.get("expected_strategy")) !=
           (l.get("actual_category"), l.get("actual_strategy"))
    ]
    matched = [l for l in labels if l not in mismatched]
    mismatch_pct = round(len(mismatched) / total * 100, 2)

    profit_matched = round(
        sum(1 for l in matched if _safe_float(l.get("round_trip_pnl", 0)) > 0) /
        max(len(matched), 1) * 100, 2
    )
    profit_mismatched = round(
        sum(1 for l in mismatched if _safe_float(l.get("round_trip_pnl", 0)) > 0) /
        max(len(mismatched), 1) * 100, 2
    )

    expected_mismatch = Counter(
        (l.get("expected_category"), l.get("expected_strategy")) for l in mismatched
    )
    actual_mismatch = Counter(
        (l.get("actual_category"), l.get("actual_strategy")) for l in mismatched
    )

    most_mis_exp = None
    if expected_mismatch:
        (ec, es), cnt = expected_mismatch.most_common(1)[0]
        most_mis_exp = {"category": str(ec), "strategy": str(es), "count": cnt, "win_pct": 0, "avg_pnl_pct": 0}

    most_mis_act = None
    if actual_mismatch:
        (ac, as_), cnt = actual_mismatch.most_common(1)[0]
        most_mis_act = {"category": str(ac), "strategy": str(as_), "count": cnt, "win_pct": 0, "avg_pnl_pct": 0}

    entry_tag_groups = defaultdict(list)
    exit_tag_groups = defaultdict(list)
    for l in labels:
        et = l.get("entry_tag", "") or "AS_PER_PATTERN"
        xt = l.get("exit_tag", "") or "AS_PER_PATTERN"
        entry_tag_groups[et].append(l)
        exit_tag_groups[xt].append(l)

    by_entry_tag = []
    for tag, items in entry_tag_groups.items():
        n = len(items)
        by_entry_tag.append({
            "tag": tag,
            "count": n,
            "avg_pnl_pct": round(sum(_safe_float(x.get("round_trip_pnl_pct", 0)) for x in items) / n, 4),
        })

    by_exit_tag = []
    for tag, items in exit_tag_groups.items():
        n = len(items)
        by_exit_tag.append({
            "tag": tag,
            "count": n,
            "avg_pnl_pct": round(sum(_safe_float(x.get("round_trip_pnl_pct", 0)) for x in items) / n, 4),
        })

    return {
        "total_trades": total,
        "win_pct": win_pct,
        "avg_pnl_pct": avg_pnl_pct,
        "pnl_95th_percentile": pnl_95th,
        "per_pattern": per_pattern,
        "mismatch": {
            "mismatch_pct": mismatch_pct,
            "profit_pct_matched": profit_matched,
            "profit_pct_mismatched": profit_mismatched,
            "most_mismatched_expected": most_mis_exp,
            "most_mismatched_actual": most_mis_act,
        },
        "by_entry_tag": by_entry_tag,
        "by_exit_tag": by_exit_tag,
    }


def _serialize_label(item: dict) -> dict:
    return {
        "session_id": item.get("session_id", ""),
        "round_trip_index": int(item.get("round_trip_index", 0)),
        "user_id": item.get("user_id", ""),
        "symbol": item.get("symbol", ""),
        "date": item.get("date", ""),
        "instrument_type": item.get("instrument_type", "equity"),
        "session_type": item.get("session_type", "sim"),
        "expected_category": item.get("expected_category", ""),
        "expected_strategy": item.get("expected_strategy", ""),
        "actual_category": item.get("actual_category", ""),
        "actual_strategy": item.get("actual_strategy", ""),
        "entry_tag": item.get("entry_tag", "AS_PER_PATTERN"),
        "exit_tag": item.get("exit_tag", "AS_PER_PATTERN"),
        "round_trip_pnl": _safe_float(item.get("round_trip_pnl")),
        "round_trip_pnl_pct": _safe_float(item.get("round_trip_pnl_pct")),
        "created_at": item.get("created_at", ""),
        "updated_at": item.get("updated_at", ""),
    }
