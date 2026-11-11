"""
What If service — saved what-if scenarios for Analysis (Phase 24, What If).

Table
  WhatIfScenarios  PK session_id, SK scenario_id
  GSI UserIdDateIndex  (user_id, date)   the "Compare days" range query

A scenario is one named what-if for one day's session: the edited price and quantity of the
trades' entries and exits, plus a small summary of the result. Several scenarios can exist
per session ("exit at bar close", "no averaging"); saving a scenario with the same name
replaces it. The edits only describe changes to a day that already happened: nothing here
touches a trade, an order or a label, and nothing is ever sent to a broker.

Created lazily like BehaviorMarks and VideoLinks, so deployments that never use it never get the
table. Deleting a session deletes its scenarios (session_cleanup_service).
"""
from __future__ import annotations

import logging
import math
import re
from datetime import datetime, timezone
from decimal import Decimal

logger = logging.getLogger(__name__)

TABLE = "WhatIfScenarios"
INDEX = "UserIdDateIndex"
ROLES = ("entry", "exit")
NAME_MAX_CHARS = 60
MAX_SCENARIOS_PER_SESSION = 20
MAX_EDITS = 400
MAX_RANGE_ROWS = 500
LEG_ID_MAX = 120
MAX_PRICE = 10_000_000
MAX_QUANTITY = 10_000_000
MAX_MONEY = 1_000_000_000_000
MAX_ROUND_TRIP = 100_000

_ENSURED = False


def _resource():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource()


def ensure_table() -> None:
    global _ENSURED
    if _ENSURED:
        return
    try:
        from app.services.db import get_dynamodb_client
        if TABLE not in set(_resource().meta.client.list_tables()["TableNames"]):
            client = get_dynamodb_client()
            client.create_table(
                TableName=TABLE, BillingMode="PAY_PER_REQUEST",
                KeySchema=[
                    {"AttributeName": "session_id", "KeyType": "HASH"},
                    {"AttributeName": "scenario_id", "KeyType": "RANGE"},
                ],
                AttributeDefinitions=[
                    {"AttributeName": "session_id", "AttributeType": "S"},
                    {"AttributeName": "scenario_id", "AttributeType": "S"},
                    {"AttributeName": "user_id", "AttributeType": "S"},
                    {"AttributeName": "date", "AttributeType": "S"},
                ],
                GlobalSecondaryIndexes=[{
                    "IndexName": INDEX,
                    "KeySchema": [
                        {"AttributeName": "user_id", "KeyType": "HASH"},
                        {"AttributeName": "date", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                }],
            )
            client.get_waiter("table_exists").wait(TableName=TABLE)
            logger.info("Created %s table", TABLE)
        _ENSURED = True
    except Exception:
        logger.exception("Failed to ensure %s table", TABLE)


def _table():
    ensure_table()
    return _resource().Table(TABLE)


def scenario_slug(name: str) -> str:
    """The scenario id: the name lower-cased, letters and digits, words joined by a hyphen."""
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40].strip("-")


def _finite(value, label: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise ValueError(f"{label} must be a number")
    number = float(value)
    if not math.isfinite(number) or number < low or number > high:
        raise ValueError(f"{label} is out of range")
    return number


def clean_edits(edits) -> list[dict]:
    """Validate the edited legs. One edit per leg; quantity 0 removes the leg from the what-if."""
    if not isinstance(edits, list):
        raise ValueError("Edits must be a list")
    if len(edits) > MAX_EDITS:
        raise ValueError(f"At most {MAX_EDITS} edited legs per scenario")
    cleaned, seen = [], set()
    for edit in edits:
        if not isinstance(edit, dict):
            raise ValueError("Each edit must be an object")
        leg_id = edit.get("leg_id")
        if not isinstance(leg_id, str) or not leg_id.strip() or len(leg_id) > LEG_ID_MAX:
            raise ValueError("Each edit needs a leg id")
        role = edit.get("role")
        if role not in ROLES:
            raise ValueError("The role of a leg must be entry or exit")
        round_trip = _finite(edit.get("round_trip"), "The round trip", 0, MAX_ROUND_TRIP)
        if round_trip != int(round_trip):
            raise ValueError("The round trip must be a whole number")
        quantity = _finite(edit.get("quantity"), "The quantity", 0, MAX_QUANTITY)
        if quantity != int(quantity):
            raise ValueError("The quantity must be a whole number")
        price = _finite(edit.get("price"), "The price", 0, MAX_PRICE)
        if price <= 0:
            raise ValueError("The price must be above zero")
        key = (int(round_trip), leg_id.strip(), role)
        if key in seen:
            raise ValueError("A leg can be edited only once")
        seen.add(key)
        cleaned.append({"round_trip": int(round_trip), "leg_id": leg_id.strip(), "role": role,
                        "price": round(price, 4), "quantity": int(quantity)})
    return cleaned


def clean_summary(summary) -> dict:
    """The result of the what-if, kept so a list of scenarios (Compare days) needs no recalculation."""
    if not isinstance(summary, dict):
        raise ValueError("The summary must be an object")
    out = {}
    for key in ("actual_pnl", "whatif_pnl", "delta"):
        out[key] = round(_finite(summary.get(key), key.replace("_", " "), -MAX_MONEY, MAX_MONEY), 2)
    pct = summary.get("delta_pct")
    out["delta_pct"] = None if pct is None else round(_finite(pct, "delta pct", -100_000, 100_000), 4)
    for key in ("trips_edited", "warnings"):
        out[key] = int(_finite(summary.get(key, 0), key.replace("_", " "), 0, MAX_ROUND_TRIP))
    return out


def _decimal(value):
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _decimal(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_decimal(v) for v in value]
    return value


def _plain(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def _serialize(row: dict, with_edits: bool = True) -> dict:
    out = {
        "session_id": row["session_id"],
        "scenario_id": row["scenario_id"],
        "name": row.get("name", ""),
        "date": row.get("date", ""),
        "symbol": row.get("symbol", ""),
        "session_type": row.get("session_type", ""),
        "instrument_type": row.get("instrument_type", ""),
        "summary": _plain(row.get("summary", {})),
        "version": int(row.get("version", 1)),
        "updated_at": row.get("updated_at", ""),
    }
    if with_edits:
        out["edits"] = _plain(row.get("edits", []))
    return out


def _query_all(table, **params) -> list[dict]:
    rows: list[dict] = []
    while True:
        page = table.query(**params)
        rows.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return rows
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def list_scenarios(session_id: str) -> list[dict]:
    """A day's scenarios with their edits, most recently saved first."""
    from boto3.dynamodb.conditions import Key
    rows = _query_all(_table(), KeyConditionExpression=Key("session_id").eq(session_id), ConsistentRead=True)
    return sorted((_serialize(r) for r in rows), key=lambda r: r["updated_at"], reverse=True)


def list_range(user_id: str, start_date: str | None = None, end_date: str | None = None) -> list[dict]:
    """The user's scenarios over a date range, summaries only (no edits), oldest day first: the Compare days view."""
    from boto3.dynamodb.conditions import Key
    condition = Key("user_id").eq(user_id)
    if start_date and end_date:
        condition = condition & Key("date").between(start_date, end_date)
    elif start_date:
        condition = condition & Key("date").gte(start_date)
    elif end_date:
        condition = condition & Key("date").lte(end_date)
    rows = _query_all(_table(), IndexName=INDEX, KeyConditionExpression=condition)
    rows = sorted(rows, key=lambda r: (r.get("date", ""), r.get("name", ""), r["session_id"]))[:MAX_RANGE_ROWS]
    return [_serialize(r, with_edits=False) for r in rows]


def save_scenario(user_id: str, session: dict, name: str, edits, summary) -> dict:
    """Store a scenario for the session, or replace the one with the same name. Date and symbol come from the session."""
    cleaned_name = " ".join((name or "").split())
    if not cleaned_name:
        raise ValueError("The scenario needs a name")
    if len(cleaned_name) > NAME_MAX_CHARS:
        raise ValueError(f"The name must be at most {NAME_MAX_CHARS} characters")
    scenario_id = scenario_slug(cleaned_name)
    if not scenario_id:
        raise ValueError("The name needs letters or numbers")
    cleaned_edits = clean_edits(edits)
    cleaned_summary = clean_summary(summary)
    session_id = session["session_id"]
    existing = list_scenarios(session_id)
    if len(existing) >= MAX_SCENARIOS_PER_SESSION and not any(r["scenario_id"] == scenario_id for r in existing):
        raise ValueError(f"At most {MAX_SCENARIOS_PER_SESSION} saved what-ifs per day; delete one first")
    item = {
        "session_id": session_id,
        "scenario_id": scenario_id,
        "user_id": user_id,
        "date": session.get("date") or "",
        "symbol": session.get("symbol") or "",
        "session_type": session.get("session_type") or "",
        "instrument_type": session.get("instrument_type") or "",
        "name": cleaned_name,
        "edits": cleaned_edits,
        "summary": cleaned_summary,
        "version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _table().put_item(Item=_decimal(item))
    return _serialize(item)


def delete_scenario(session_id: str, scenario_id: str) -> None:
    """Remove one saved what-if. Nothing else about the session changes."""
    key = {"session_id": session_id, "scenario_id": scenario_id}
    if not _table().get_item(Key=key, ConsistentRead=True).get("Item"):
        raise LookupError("Saved what-if not found")
    _table().delete_item(Key=key)
