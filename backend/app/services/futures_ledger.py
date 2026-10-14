"""Futures margin and MTM: notional is exposure, never cash or a NAV asset."""

from copy import deepcopy
from math import isfinite

from fastapi import HTTPException

from app.services import swing_funding_store as codec


def empty():
    return {
        "lots": [],
        "fees": 0.0,
        "economic_realized": 0.0,
        "cash_profit": 0.0,
        "settlements": {},
        "fills": {},
    }


def apply_fill(original, identity, side, quantity, price, margin, fee, timestamp):
    state = deepcopy(original)
    if identity in state["fills"]:
        old = state["fills"][identity]
        if (old["side"], old["quantity"], old["price"]) != (side, quantity, price):
            raise ValueError("Futures fill identity has conflicting evidence")
        return state, old["cash_change"]
    if (
        side not in ("BUY", "SELL")
        or quantity <= 0
        or not all(isfinite(v) for v in (price, margin, fee))
        or price <= 0
        or margin < 0
        or fee < 0
    ):
        raise ValueError("Invalid Futures fill evidence")
    direction = 1 if side == "BUY" else -1
    held = sum(lot["quantity"] for lot in state["lots"])
    closing = bool(state["lots"] and state["lots"][0]["direction"] != direction)
    cash_change, economic = -fee, 0.0
    if closing:
        if quantity > held:
            raise ValueError("Close the Futures position before reversing direction")
        remaining = quantity
        lots = []
        for lot in state["lots"]:
            used = min(remaining, lot["quantity"])
            released = lot["margin"] * used / lot["quantity"]
            economic += (price - lot["entry_price"]) * used * lot["direction"]
            movement = (price - lot["settlement_base"]) * used * lot["direction"]
            cash_change += released + movement
            state["cash_profit"] += movement
            remaining -= used
            if used < lot["quantity"]:
                lots.append(
                    {
                        **lot,
                        "quantity": lot["quantity"] - used,
                        "margin": lot["margin"] - released,
                        "entry_fee": lot.get("entry_fee", 0)
                        * (lot["quantity"] - used)
                        / lot["quantity"],
                    }
                )
        state["lots"] = lots
        state["economic_realized"] += economic
    else:
        if margin <= 0:
            raise ValueError("A positive Futures margin is required before entry")
        cash_change -= margin
        state["lots"].append(
            {
                "quantity": quantity,
                "direction": direction,
                "entry_price": price,
                "settlement_base": price,
                "margin": margin,
                "entry_fee": fee,
                "timestamp": timestamp,
            }
        )
    state["fees"] += fee
    cash_change = round(cash_change, 2)
    state["fills"][identity] = {
        "side": side,
        "quantity": quantity,
        "price": price,
        "fee": fee,
        "cash_change": cash_change,
        "economic_pnl": economic,
        "timestamp": timestamp,
    }
    return state, cash_change


def apply_settlement(original, date, price):
    state = deepcopy(original)
    if not isfinite(price) or price <= 0:
        raise ValueError("Official settlement price must be positive")
    existing = state["settlements"].get(date)
    if existing:
        if existing["price"] != price:
            raise ValueError("Official settlement changed; reconcile the correction")
        return state, 0.0
    if state["settlements"] and date < max(state["settlements"]):
        raise ValueError("Settle Futures dates in chronological order")
    movement = sum(
        (price - lot["settlement_base"]) * lot["quantity"] * lot["direction"]
        for lot in state["lots"]
    )
    for lot in state["lots"]:
        lot["settlement_base"] = price
    movement = round(movement, 2)
    state["cash_profit"] += movement
    state["settlements"][date] = {"price": price, "cash_change": movement}
    return state, movement


def values(state, price=None):
    held_margin = round(sum(lot["margin"] for lot in state["lots"]), 2)
    quantity = sum(lot["quantity"] for lot in state["lots"])
    direction = state["lots"][0]["direction"] if quantity else 0
    basis = (
        sum(lot["entry_price"] * lot["quantity"] for lot in state["lots"]) / quantity
        if quantity
        else 0
    )
    known = price is not None and isfinite(price) and price > 0
    economic_open = (
        sum(
            (price - lot["entry_price"]) * lot["quantity"] * lot["direction"]
            for lot in state["lots"]
        )
        if known
        else None
    )
    unsettled = (
        sum(
            (price - lot["settlement_base"]) * lot["quantity"] * lot["direction"]
            for lot in state["lots"]
        )
        if known
        else None
    )
    return {
        "held_margin": held_margin,
        "quantity": quantity,
        "side": "LONG" if direction > 0 else "SHORT" if direction < 0 else "FLAT",
        "avg_entry_price": basis,
        "unsettled_pnl": round(unsettled, 2) if unsettled is not None else None,
        "economic_open_pnl": round(
            economic_open - sum(lot.get("entry_fee", 0) for lot in state["lots"]), 2
        )
        if economic_open is not None
        else None,
        "economic_pnl": round(
            state["economic_realized"] + (economic_open or 0) - state["fees"], 2
        )
        if known or not quantity
        else None,
        "settled_mtm": round(
            sum(event["cash_change"] for event in state["settlements"].values()), 2
        ),
        "fees": round(state["fees"], 2),
        "cash_profit": round(state["cash_profit"], 2),
    }


def revalue_margin(original, margin, timestamp):
    state = deepcopy(original)
    if not isfinite(margin) or margin <= 0 or not state["lots"]:
        raise ValueError(
            "Margin revaluation requires a held position and positive evidence"
        )
    old = sum(lot["margin"] for lot in state["lots"])
    quantity = sum(lot["quantity"] for lot in state["lots"])
    for lot in state["lots"]:
        lot["margin"] = margin * lot["quantity"] / quantity
    state.setdefault("margin_adjustments", []).append(
        {"timestamp": timestamp, "before": old, "after": margin}
    )
    return state, round(old - margin, 2)


def read(session):
    from app.services.db import get_dynamodb_resource

    key = f"futures-ledger:{session.session_id}"
    row = (
        get_dynamodb_resource()
        .Table("Sessions")
        .get_item(Key={"session_id": key}, ConsistentRead=True)
        .get("Item")
    )
    if row and row.get("user_id") != session.user_id:
        raise HTTPException(404, "Futures ledger not found")
    return (
        codec.decode(row)
        if row
        else {
            "session_id": key,
            "user_id": session.user_id,
            "version": 0,
            "ledger": empty(),
        }
    )


def write_action(row, state):
    from boto3.dynamodb.types import TypeSerializer

    result = {
        **row,
        "version": row["version"] + 1,
        "ledger": state,
        "record_type": "futures_ledger",
    }
    serialize = lambda value: {
        key: TypeSerializer().serialize(v) for key, v in codec.encode(value).items()
    }
    return {
        "Put": {
            "TableName": "Sessions",
            "Item": serialize(result),
            "ConditionExpression": "attribute_not_exists(session_id)"
            if row["version"] == 0
            else "#v = :old",
            **(
                {}
                if row["version"] == 0
                else {
                    "ExpressionAttributeNames": {"#v": "version"},
                    "ExpressionAttributeValues": serialize({":old": row["version"]}),
                }
            ),
        }
    }


def commit_paper(
    session,
    row,
    state,
    amount,
    operation,
    *,
    order=None,
    trade=None,
    allow_negative=True,
):
    from app.services.swing_cash import move

    return move(
        session.user_id,
        session.portfolio_id,
        amount,
        operation,
        allow_negative=allow_negative,
        order=order,
        trade=trade,
        extra_actions=[write_action(row, state)],
    )
