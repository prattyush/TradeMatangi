"""Shared Real account allocations and reservations; actual broker cash stays authoritative."""

import hashlib
import json
import uuid

from fastapi import HTTPException

from app.config import EQUITY_MIS_MARGIN_RATE
from app.services import swing_accounting as rules
from app.services import swing_funding_store as store


def identity(session):
    return (
        session.portfolio_id if session.trading_style == "swing" else session.session_id
    )


def pool(session):
    row = store.owned_participant(
        session.user_id,
        session.execution_broker,
        session.broker_account_id,
        session.trading_style,
        identity(session),
    )
    if row["period_id"] != session.real_funding_period:
        raise HTTPException(
            409,
            "Real funding period changed; recover the original book without resetting its capital",
        )
    return row


def require_entry(session):
    if not getattr(session, "real_funding_period", None):
        return
    row = pool(session)
    status = row.get("funding_status")
    if any(
        p.get("reconciliation_pending")
        for p in row["participants"].values()
        if p.get("active")
    ):
        raise HTTPException(
            409, "Account funding needs reconciliation; exits remain available"
        )
    if (
        status
        and status.get("entries_allowed")
        and getattr(session, "real_engine_lease_required", False) is True
    ):
        row = verify_available(session, row)
        status = row.get("funding_status")
    if not status or not status.get("entries_allowed"):
        raise HTTPException(
            409,
            "Account funding needs reconciliation; new entries are blocked, exits remain available",
        )


def verify_available(session, row):
    """Read current broker cash once per submission burst; never rely on stale UI funds."""
    import time

    checked = getattr(session, "_real_funds_checked_at", 0)
    if time.monotonic() - checked < 1:
        return row
    from app.services import execution_broker, real_accounting

    try:
        limits = execution_broker.get_service(session).get_limits()
        available = real_accounting.required_number(limits.get("Net"), "Net")
    except Exception as exc:
        mark_pending(session)
        raise HTTPException(
            503, "Broker funds could not be verified; exits remain available"
        ) from exc

    def mutate(current):
        coherent = not any(
            p.get("reconciliation_pending")
            for p in current["participants"].values()
            if p.get("active")
        )
        current["funding_status"] = rules.status(
            current["funding"], available, coherent=coherent
        )
        if any(
            rules.mode_available(current["funding"], mode) < -0.01
            for mode, p in current["participants"].items()
            if p.get("active")
        ):
            current["funding_status"]["entries_allowed"] = False
            if current["funding_status"]["state"] == "verified":
                current["funding_status"]["state"] = "allocation_shortfall"

    result = store.apply(
        session.user_id,
        session.execution_broker,
        session.broker_account_id,
        row["period_id"],
        str(uuid.uuid4()),
        "broker_funds_check",
        {"available": available},
        mutate,
        extra_actions=lambda _: ownership_actions(session),
    )
    session._real_funds_checked_at = time.monotonic()
    return result


def ownership_actions(session):
    """Funding snapshots from an expired engine cannot overwrite recovered state."""
    token = getattr(session, "real_claim_token", None)
    if not token:
        return []  # Legacy/test books without engine claims retain their existing path.
    import time

    from app.services import real_session_slots as slots

    return [
        {
            "ConditionCheck": {
                "TableName": "WalletLedgers",
                "Key": slots.serialize(
                    slots.key(
                        session.execution_broker,
                        session.broker_account_id,
                        session.trading_style,
                    )
                ),
                "ConditionExpression": "owner_user_id = :owner AND session_id = :sid AND operation_id = :token AND engine_until >= :now AND #state <> :closed",
                "ExpressionAttributeNames": {"#state": "state"},
                "ExpressionAttributeValues": slots.serialize(
                    {
                        ":owner": session.user_id,
                        ":sid": identity(session),
                        ":token": token,
                        ":now": int(time.time()),
                        ":closed": "closed",
                    }
                ),
            }
        }
    ]


def reserve(session, order_id, amount, *, owner="local"):
    row = pool(session)
    ticket = f"{session.session_id}:{order_id}"
    amount = rules.money(amount)
    old = row["funding"].get("reservations", {}).get(ticket)
    if old and old["amount"] == amount and old["owner"] == owner:
        return row

    def mutate(current):
        participant = current["participants"].get(session.trading_style)
        if (
            not participant
            or participant.get("owner_user_id") != session.user_id
            or participant["identity"] != identity(session)
            or not participant.get("active")
        ):
            raise HTTPException(409, "Funding ownership changed")
        if amount:
            existing = current["funding"].get("reservations", {}).get(ticket)
            available = rules.mode_available(
                current["funding"], session.trading_style
            ) + (existing["amount"] if existing else 0)
            status = current.get("funding_status")
            if status and status.get("entries_allowed"):
                local_reserved = sum(
                    ticket_row["amount"]
                    for ticket_row in current["funding"]
                    .get("reservations", {})
                    .values()
                    if ticket_row["owner"] == "local"
                )
                broker_available = (
                    status["available"]
                    - local_reserved
                    + (existing["amount"] if existing else 0)
                )
                available = min(available, broker_available)
            if amount > available:
                from app.services.wallet_service import InsufficientFundsError

                raise InsufficientFundsError(available, amount)
            current["funding"] = rules.reserve(
                current["funding"], session.trading_style, ticket, amount, owner=owner
            )
        else:
            current["funding"] = rules.release(
                current["funding"], session.trading_style, ticket
            )

    return store.apply(
        session.user_id,
        session.execution_broker,
        session.broker_account_id,
        row["period_id"],
        str(uuid.uuid4()),
        "reservation",
        {"ticket": ticket, "amount": amount, "owner": owner},
        mutate,
        extra_actions=lambda _: ownership_actions(session),
    )


def reconcile(session, available, *, coherent=True):
    """Rebase one owned book from its durable executions; never debit fills twice."""
    from app.services import order_service, simulation, trading

    row = pool(session)
    participant = row["participants"][session.trading_style]
    sessions = [session]
    if session.trading_style == "swing":
        sessions = [
            s
            for s in simulation._sessions.values()
            if s.portfolio_id == session.portfolio_id and s.session_type == "real"
        ]
    if session.trading_style == "swing":
        coherent = coherent and not any(
            child.real_recovery_pending for child in sessions
        )
    invested, cash, commissions = 0.0, 0.0, 0.0
    tickets = {}
    for child in sessions:
        cash -= getattr(child, "opening_inventory_cost", 0)
        for trade in trading.get_trades(child.session_id):
            cash += (
                trade.quantity * trade.price * (1 if trade.side.value == "SELL" else -1)
            )
            commissions += trade.commission
        contracts = (
            trading.get_open_option_contracts(child.session_id, child.symbol)
            if child.instrument_type == "options"
            else [{"right": None, "strike": None, "expiry": None}]
        )
        for contract in contracts:
            position = trading.get_position(
                child.session_id,
                child.symbol,
                **{k: contract[k] for k in ("right", "strike", "expiry")},
            )
            if position.side == "SHORT":
                coherent = False if child.trading_style == "swing" else coherent
            principal = position.quantity * position.avg_entry_price
            cash += principal * (1 if position.side == "LONG" else -1)
            rate = (
                EQUITY_MIS_MARGIN_RATE
                if child.trading_style == "intraday"
                and child.instrument_type == "equity"
                else 1
            )
            invested += principal * rate
        for order in order_service.get_open_orders(child.session_id):
            if order.reserved_amount:
                tickets[f"{child.session_id}:{order.order_id}"] = {
                    "mode": session.trading_style,
                    "amount": order.reserved_amount,
                    "owner": "broker"
                    if order.broker_order_id
                    or order.recovery_state in ("submitting", "unknown")
                    else "local",
                }
    realized = rules.money(cash - commissions)
    baseline = participant.get(
        "baseline_balance",
        row["funding"]["modes"][session.trading_style]["expected_balance"],
    )
    target = rules.money(baseline + min(realized, 0) - invested)
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "target": target,
                "realized": realized,
                "tickets": tickets,
                "available": available,
                "coherent": coherent,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    if participant.get("snapshot_fingerprint") == fingerprint:
        return row

    def mutate(current):
        active = current["participants"][session.trading_style]
        if (
            not active.get("active")
            or active.get("owner_user_id") != session.user_id
            or active["identity"] != identity(session)
        ):
            raise HTTPException(409, "Funding ownership changed during reconciliation")
        mode = current["funding"]["modes"][session.trading_style]
        mode["expected_balance"] = target
        mode["realized_pnl"] = rules.money(
            active.get("baseline_realized_pnl", 0) + realized
        )
        mode["ignored_profit"] = rules.money(
            active.get("baseline_profit", 0) + max(realized, 0)
        )
        reservations = {
            k: v
            for k, v in current["funding"].get("reservations", {}).items()
            if v["mode"] != session.trading_style
        }
        reservations.update(tickets)
        current["funding"]["reservations"] = reservations
        active["snapshot_fingerprint"] = fingerprint
        active["reconciliation_pending"] = not coherent
        shared_coherent = coherent and not any(
            p.get("reconciliation_pending")
            for p in current["participants"].values()
            if p.get("active")
        )
        current["funding_status"] = rules.status(
            current["funding"], available, coherent=shared_coherent
        )
        deficit = rules.money(
            sum(
                max(0, -rules.mode_available(current["funding"], mode_name))
                for mode_name, participant in current["participants"].items()
                if participant.get("active")
            )
        )
        if shared_coherent and deficit > 0.01:
            current["funding_status"]["allocation_shortfall"] = deficit
            current["funding_status"]["entries_allowed"] = False
            if current["funding_status"]["state"] == "verified":
                current["funding_status"]["state"] = "allocation_shortfall"

    return store.apply(
        session.user_id,
        session.execution_broker,
        session.broker_account_id,
        row["period_id"],
        str(uuid.uuid4()),
        "book_snapshot",
        {"fingerprint": fingerprint},
        mutate,
        extra_actions=lambda _: ownership_actions(session),
    )


def mark_pending(session):
    """Unconfirmed broker effects block entries for both account participants."""
    row = pool(session)

    def mutate(current):
        participant = current["participants"].get(session.trading_style)
        if (
            not participant
            or not participant.get("active")
            or participant.get("owner_user_id") != session.user_id
            or participant["identity"] != identity(session)
        ):
            raise HTTPException(
                409, "Funding ownership changed during broker preparation"
            )
        available = (current.get("funding_status") or {}).get("available", 0)
        current["funding_status"] = rules.status(
            current["funding"], available, coherent=False
        )
        current["participants"][session.trading_style]["reconciliation_pending"] = True
        current["participants"][session.trading_style].pop("snapshot_fingerprint", None)

    return store.apply(
        session.user_id,
        session.execution_broker,
        session.broker_account_id,
        row["period_id"],
        str(uuid.uuid4()),
        "broker_operation_pending",
        {},
        mutate,
        extra_actions=lambda _: ownership_actions(session),
    )
