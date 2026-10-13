"""Confirmed Real Futures evidence over the existing Swing broker journal and lease."""

import asyncio
from datetime import UTC, datetime

from app.models.schemas import Trade, TradeSide
from app.services import futures_ledger as ledger
from app.services import futures_risk as risk
from app.services import order_service, trading


def confirmed_trades(session, executions, orders):
    """Keep individual fills/FIFO while allocating one broker-order fee only once."""
    owned = {
        order.broker_order_id: order
        for order in orders.values()
        if (order.analytics or {}).get("futures")
    }
    grouped = {}
    for row in executions:
        identifier = row["broker_order_id"]
        if identifier not in owned:
            raise ValueError("Unowned Futures execution needs broker reconciliation")
        grouped.setdefault(identifier, []).append(row)
    result = []
    for identifier, rows in grouped.items():
        order = owned[identifier]
        info = order.analytics["futures"]
        profile = risk.FeeProfile.model_validate(info["fee_profile"])
        quantity = sum(row["quantity"] for row in rows)
        notional = sum(row["price"] * row["quantity"] for row in rows)
        whole = risk.fees(
            profile,
            session.future_contract["exchange"],
            rows[0]["side"],
            notional / quantity,
            quantity,
        )
        assigned = 0.0
        for index, row in enumerate(rows):
            fee = (
                round(whole["total"] * row["quantity"] / quantity, 2)
                if index < len(rows) - 1
                else round(whole["total"] - assigned, 2)
            )
            assigned += fee
            margin = float(info.get("margin", 0)) * row["quantity"] / order.quantity
            result.append(
                Trade(
                    trade_id=f"{session.execution_broker}:{session.broker_account_id}:{row['exchange']}:{row['execution_id']}",
                    session_id=session.session_id,
                    user_id=session.user_id,
                    symbol=session.symbol,
                    side=TradeSide(row["side"]),
                    quantity=row["quantity"],
                    price=row["price"],
                    timestamp=row["timestamp"],
                    instrument_type="futures",
                    expiry=session.expiry,
                    session_type="real",
                    trading_style="swing",
                    portfolio_id=session.portfolio_id,
                    source="broker",
                    commission=fee,
                    broker_order_id=identifier,
                    execution_broker=session.execution_broker,
                    broker_account_id=session.broker_account_id,
                    broker_exchange=row["exchange"],
                    broker_execution_ids=[row["execution_id"]],
                    execution_sort_time=row.get("execution_sort_time"),
                    analytics={
                        **order.analytics,
                        "futures": {
                            **info,
                            "entry_margin": margin,
                            "fee_source": "captured broker fee estimate",
                            "fee_details": whole,
                        },
                    },
                )
            )
    return sorted(
        result,
        key=lambda trade: (
            trade.execution_sort_time or trade.timestamp * 1_000_000,
            trade.trade_id,
        ),
    )


def save_ledger(session, row, state):
    from app.services.db import get_dynamodb_client
    from app.services.swing_real import ownership_check

    get_dynamodb_client().transact_write_items(
        TransactItems=[ledger.write_action(row, state), ownership_check(session)]
    )


def rebuild(session):
    row = ledger.read(session)
    state = ledger.empty()
    events = []
    for trade in trading.get_trades(session.session_id):
        events.append(
            (
                trade.timestamp * 1_000_000
                if trade.execution_sort_time is None
                else trade.execution_sort_time,
                0,
                trade,
            )
        )
    for adjustment in row["ledger"].get("margin_adjustments", []):
        events.append((adjustment["timestamp"] * 1_000_000, 2, adjustment))
    for day, evidence in row["ledger"]["settlements"].items():
        stamp = (
            int(
                datetime.fromisoformat(day + "T15:30:00")
                .replace(tzinfo=UTC)
                .timestamp()
            )
            * 1_000_000
        )
        events.append((stamp, 1, (day, evidence)))
    for _, kind, event in sorted(events, key=lambda event: (event[0], event[1])):
        if kind == 0:
            info = (event.analytics or {}).get("futures", {})
            state, _ = ledger.apply_fill(
                state,
                event.trade_id,
                event.side.value,
                event.quantity,
                event.price,
                info.get("entry_margin", 0),
                event.commission,
                event.timestamp,
            )
        elif kind == 2:
            if state["lots"]:
                state, _ = ledger.revalue_margin(
                    state, event["after"], event["timestamp"]
                )
        else:
            day, evidence = event
            state, _ = ledger.apply_settlement(state, day, evidence["price"])
            state["settlements"][day].update(source=evidence.get("source"))
    if state != row["ledger"]:
        save_ledger(session, row, state)


async def on_quote(session, event):
    from app.services.swing_futures import settle_pending
    from app.services.swing_real import renew_protection_on_quote

    if (
        getattr(session, "broker_refresh_events", None) is not None
        or session.real_recovery_pending
    ):
        return
    await settle_pending(session)
    from app.models.schemas import OrderType
    from app.services import execution_broker
    from app.services import swing_portfolio_service as service
    from app.services.broker_order_service import submit_immediate_async

    for order in order_service.get_open_orders(session.session_id):
        if (
            order.order_type != OrderType.TARGET
            or order.broker_order_id
            or order.recovery_state in ("submitting", "unknown")
            or order.swing_reconcile_pending
        ):
            continue
        reached = (
            event["close"] >= order.trigger_price
            if order.side == TradeSide.BUY
            else event["close"] <= order.trigger_price
        )
        if not reached:
            continue
        try:
            if not getattr(risk.settings(), f"{session.execution_broker}_real_enabled"):
                continue
            service.require_entry_allowed(
                session, order.side, order.quantity, expiry=session.expiry
            )
            info = order.analytics["futures"]
            from app.services.swing_portfolio_store import owned

            revision = (
                (order.analytics or {}).get("swing_request", {}).get("capital_revision")
            )
            if (
                revision is not None
                and revision
                != owned(session.user_id, session.portfolio_id)["guardrail_epoch"]
            ):
                order.swing_reconcile_pending = True
                order.swing_reconcile_reason = (
                    "Portfolio capital changed; cancel and review the Futures intention"
                )
                order_service._write_order_to_db(order, strict=True)
                continue
            margin = await asyncio.to_thread(
                risk.live_margin,
                session.future_contract,
                order.side.value,
                order.quantity,
                order.limit_price,
                session.execution_broker,
                broker=execution_broker.get_service(session),
            )
            from app.services.protection_recovery import fresh_quote

            current_price = fresh_quote(session, order)
            if not (
                current_price >= order.trigger_price
                if order.side == TradeSide.BUY
                else current_price <= order.trigger_price
            ):
                continue
            service.require_entry_allowed(
                session, order.side, order.quantity, expiry=session.expiry
            )
            fee = risk.fees(
                info["fee_profile"],
                session.future_contract["exchange"],
                order.side.value,
                order.limit_price,
                order.quantity,
            )["total"]
            if margin["margin"] + fee > info["approved_budget"]:
                order.swing_reconcile_pending = True
                order.swing_reconcile_reason = "Triggered Futures margin exceeds approved budget; cancel and review"
                order_service._write_order_to_db(order, strict=True)
                continue
            from app.services.real_funding import reserve

            reserve(session, order.order_id, margin["margin"] + fee)
            order.reserved_amount = margin["margin"] + fee
            info.update(
                margin=margin["margin"], reserved_requirement=order.reserved_amount
            )
            order_service._write_order_to_db(order, strict=True)
            await submit_immediate_async(session, order)
        except Exception as exc:  # noqa: BLE001 — financial failures retain pending/reconciliation state
            session.futures_warning = (
                f"Futures trigger submission needs review: {type(exc).__name__}"
            )
            if order.recovery_state == "failed" and not order.broker_order_id:
                order_service.cancel_order(
                    session.session_id, order.order_id, session.date
                )
    # Renewal uses existing durable attempts and deterministic order identities.
    await renew_protection_on_quote(session, event)
    if session.expiry <= session.date:
        session.futures_warning = "Futures expiry: manually exit/roll and reconcile any broker settlement or delivery obligations"


async def refresh_after_event(session):
    from app.services import execution_broker, kotak_reports, swing_real
    from app.services import swing_portfolio_service as service

    session.real_recovery_pending = True
    try:
        kotak_reports.invalidate(execution_broker.get_service(session))
        await swing_real.refresh(session)
    except Exception as exc:  # noqa: BLE001 — financial failures retain pending/reconciliation state
        session.real_recovery_pending = True
        session.futures_warning = (
            f"Broker Futures execution needs reconciliation: {type(exc).__name__}"
        )
    current = service.runtime(session.user_id, session.portfolio_id)
    current.emit(
        {
            "type": "portfolio_snapshot",
            **service.snapshot(session.user_id, session.portfolio_id),
        }
    )


def exit_belongs_to_position(session, order):
    """A prior exit cannot protect a position closed/reopened after that intention.

    Use the already-confirmed in-memory journal, without a historical DB scan.
    Same-second flat transitions are deliberately ambiguous and require review.
    """
    net = 0
    fills = sorted(
        (
            trade
            for trade in trading.get_trades(session.session_id)
            if trade.instrument_type == "futures"
            and trade.symbol == session.symbol
            and trade.expiry == order.expiry
        ),
        key=lambda trade: (
            trade.execution_sort_time or trade.timestamp * 1_000_000,
            trade.trade_id,
        ),
    )
    for trade in fills:
        after = net + trade.quantity * (1 if trade.side == TradeSide.BUY else -1)
        if (
            net
            and (not after or net * after < 0)
            and trade.timestamp >= order.created_at
        ):
            return False
        net = after
    return bool(
        net
        and (
            (net > 0 and order.side == TradeSide.SELL)
            or (net < 0 and order.side == TradeSide.BUY)
        )
    )


async def renew_exit(session, old, quantity, identifier, event):
    from app.models.schemas import OrderStatus, OrderType
    from app.services.broker_order_service import (
        submit_immediate_async,
        sync_order_edit_async,
    )
    from app.services.execution_price_service import limit_price
    from app.services.kite_execution import KiteExecutionService

    renewed = old.model_copy(
        deep=True,
        update={
            "order_id": identifier,
            "quantity": quantity,
            "created_at": int(event["time"]),
            "status": OrderStatus.PENDING,
            "broker_order_id": None,
            "kotak_order_id": None,
            "broker_filled_quantity": 0,
            "broker_filled_value": 0.0,
            "filled_at": None,
            "filled_price": None,
            "reserved_amount": 0.0,
            "recovery_state": None,
            "cancellation_status": None,
            "cancellation_reason": None,
            "cancel_request_id": None,
            "broker_conversion": None,
            "split_operation": None,
            "swing_reconcile_pending": False,
            "swing_reconcile_reason": None,
            "swing_attempts": [],
            "source": "swing_futures_renewal",
        },
    )
    renewed.analytics["futures"]["fee_profile"] = (
        risk.settings().fees[session.execution_broker].model_dump(mode="json")
    )
    renewed.analytics["futures"]["valid_date"] = session.date
    crossed = renewed.order_type == OrderType.STOPLOSS and (
        event["close"] <= renewed.trigger_price
        if renewed.side == TradeSide.SELL
        else event["close"] >= renewed.trigger_price
    )
    if crossed:
        renewed.order_type = OrderType.LIMIT
        renewed.is_stoploss = False
        renewed.limit_price = KiteExecutionService._price(
            limit_price(
                renewed.side, event["close"], 0.03, session.future_contract["tick_size"]
            ),
            session.future_contract["tick_size"],
        )
    order_service._write_order_to_db(renewed, strict=True)
    order_service._orders[session.session_id][identifier] = renewed
    old.swing_attempts.append(
        {
            "state": "renewed",
            "date": session.date,
            "order_id": identifier,
            "quantity": quantity,
        }
    )
    order_service._write_order_to_db(old, strict=True)
    if renewed.order_type == OrderType.STOPLOSS:
        await sync_order_edit_async(session, renewed, OrderType.STOPLOSS, reprice=True)
    else:
        await submit_immediate_async(session, renewed)


def delivery_review_contexts(current):
    from app.services import swing_market

    result = []
    for child in current.contexts.values():
        if (
            child.instrument_type != "futures"
            or child.future_contract.get("category") == "index"
        ):
            continue
        if swing_market.now() < swing_market.closing(child.expiry):
            continue
        if (
            ledger.values(ledger.read(child)["ledger"])["quantity"]
            or child.real_recovery_pending
        ):
            result.append(child.session_id)
    return result
