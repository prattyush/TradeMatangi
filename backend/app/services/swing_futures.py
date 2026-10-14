"""Swing Futures lifecycle over existing owned portfolios, orders and cash journals."""

import asyncio
import math
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException

from app.models.schemas import (
    Order,
    OrderStatus,
    OrderType,
    SimulationState,
    Trade,
    TradeSide,
)
from app.services import futures_ledger as ledger
from app.services import futures_risk as risk
from app.services import order_service, swing_market, trading
from app.services import swing_portfolio_store as store


def restore(session):
    from boto3.dynamodb.conditions import Key

    from app.services.db import get_dynamodb_resource

    table = get_dynamodb_resource().Table("Orders")
    params = {
        "KeyConditionExpression": Key("session_id").eq(session.session_id),
        "ConsistentRead": True,
    }
    rows = []
    while True:
        page = table.query(**params)
        rows.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            break
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    order_service._orders[session.session_id] = {
        row["order_id"]: Order.model_validate(row) for row in rows
    }
    trading.reload_trades_from_db(session.session_id, strict=True)
    ledger.read(session)  # Ownership/evidence check before any execution can resume.


def is_exit(session, side, quantity):
    position = trading.get_position(
        session.session_id, session.symbol, expiry=session.expiry
    )
    return bool(
        position.quantity
        and quantity <= position.quantity
        and (
            (position.side == "LONG" and side == TradeSide.SELL)
            or (position.side == "SHORT" and side == TradeSide.BUY)
        )
    )


async def place(user, portfolio_id, req):
    from app.routers.swing import economic_instructions
    from app.services import swing_portfolio_service as service
    from app.services.futures_contracts import resolve_contract
    from app.services.futures_preview import preview

    current = await service.ensure(user, portfolio_id)
    parent = store.owned(user, portfolio_id)
    provider = parent.get("execution_broker") or parent.get("paper_broker") or "kite"
    key = f"{req.symbol}:futures:{req.expiry}"
    child = current.contexts.get(key)
    sid = parent["contexts"].get(key) or str(
        uuid.uuid5(uuid.NAMESPACE_URL, portfolio_id + ":" + key)
    )
    identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, sid + ":order:" + req.request_id))
    from app.services.db import get_dynamodb_resource
    from app.services.real_broker_state import active_partition

    saved = await asyncio.to_thread(
        lambda: (
            get_dynamodb_resource()
            .Table("Orders")
            .get_item(
                Key={
                    "session_id": active_partition(sid) or sid,
                    "order_id": identifier,
                },
                ConsistentRead=True,
            )
            .get("Item")
        )
    )
    if saved:
        from app.services.swing_funding_store import decode

        old = decode((saved.get("analytics") or {}).get("swing_request") or {})
        if economic_instructions(old) != economic_instructions(
            req.model_dump(mode="json")
        ):
            raise HTTPException(
                409, "Order identity was reused with different instructions"
            )
        return {"order_id": identifier, **service.snapshot(user, portfolio_id)}
    config = risk.settings()
    enabled = (
        config.paper_enabled
        if parent["mode"] == "paper"
        else getattr(config, f"{provider}_real_enabled")
    )
    if child is None and not enabled:
        raise HTTPException(403, "New Futures entries are disabled in Admin settings")
    if child is not None and parent["mode"] == "real":
        from app.services.swing_real import refresh

        await refresh(child)
    contract = (
        child.future_contract
        if child
        else await asyncio.to_thread(resolve_contract, req.symbol, req.expiry, provider)
    )
    if req.quantity % contract["lot_size"]:
        raise HTTPException(
            422, f"Futures quantity must be complete lots of {contract['lot_size']}"
        )
    if (
        abs(
            req.price / contract["tick_size"] - round(req.price / contract["tick_size"])
        )
        > 1e-6
    ):
        raise HTTPException(
            422, f"Price must be a multiple of tick {contract['tick_size']}"
        )
    exiting = child is not None and is_exit(child, req.side, req.quantity)
    if child and not exiting:
        position = trading.get_position(
            child.session_id, child.symbol, expiry=child.expiry
        )
        if position.quantity and (
            (position.side == "LONG" and req.side == TradeSide.SELL)
            or (position.side == "SHORT" and req.side == TradeSide.BUY)
        ):
            raise HTTPException(422, "Close the position before reversing direction")
    config = risk.settings()
    enabled = (
        config.paper_enabled
        if parent["mode"] == "paper"
        else getattr(config, f"{provider}_real_enabled")
    )
    if not exiting and not enabled:
        raise HTTPException(403, "New Futures entries are disabled in Admin settings")
    if req.order_type == OrderType.STOPLOSS and not exiting:
        raise HTTPException(
            422,
            "Stoploss protects a held Futures position; entries use Limit or Target",
        )
    if req.order_type == OrderType.TARGET and exiting:
        raise HTTPException(422, "Use Limit or Stoploss to close Futures")
    if (
        parent["mode"] == "real"
        and not exiting
        and not swing_market.window(swing_market.now())
    ):
        raise HTTPException(
            409,
            "Real Futures entries require the trading session; offline intentions are Paper only",
        )
    if not exiting and (
        not contract["entry_eligible"]
        or req.expiry < swing_market.today()
        or (
            req.expiry == swing_market.today()
            and swing_market.now() >= swing_market.closing(req.expiry) - 900
        )
    ):
        raise HTTPException(422, "This contract is outside the Futures entry window")
    if req.capital_pct is not None and exiting:
        raise HTTPException(422, "Use explicit quantity for Futures exits")
    estimate = (
        None if exiting else await asyncio.to_thread(preview, user, portfolio_id, req)
    )
    if estimate and estimate["quantity"] != req.quantity:
        raise HTTPException(409, "Futures size changed; review the preview")
    profile = config.fees[provider]
    from app.services.futures_preview import fee_hash

    if not exiting and req.fee_hash is not None and req.fee_hash != fee_hash(profile):
        raise HTTPException(409, "Fee profile changed; review the preview")
    if not exiting and (
        req.approved_budget is None or estimate["required_funds"] > req.approved_budget
    ):
        raise HTTPException(409, "Confirm a sufficient Futures margin budget first")
    child = service.attach_context(
        user,
        portfolio_id,
        req.symbol,
        "futures",
        expiry=req.expiry,
        future_contract=contract,
    )
    if parent["mode"] == "real":
        from app.services.swing_real import refresh

        await refresh(child)
        if is_exit(child, req.side, req.quantity) != exiting:
            raise HTTPException(
                409, "Broker position changed; review the Futures ticket"
            )
    from app.routers.orders import _session_edit_lock

    async with _session_edit_lock(child):
        # Recheck after awaited reads and per-context edits; cash reservation is a CAS transaction.
        service.require_entry_allowed(child, req.side, req.quantity, expiry=req.expiry)
        row = store.owned(user, portfolio_id)
        if (
            not exiting
            and req.capital_revision is not None
            and req.capital_revision != row["guardrail_epoch"]
        ):
            raise HTTPException(409, "Portfolio capital changed; review the preview")
        pending = order_service.get_open_orders(child.session_id)
        if exiting:
            held = trading.get_position(
                child.session_id, child.symbol, expiry=child.expiry
            ).quantity
            if (
                sum(
                    max(0, o.quantity - o.broker_filled_quantity)
                    for o in pending
                    if o.side == req.side
                )
                + req.quantity
                > held
            ):
                raise HTTPException(
                    409, "Existing exits already cover this Futures quantity"
                )
        elif any(o.side != req.side and o.execution_role == "entry" for o in pending):
            raise HTTPException(
                409,
                "Cancel the opposite entry before opening Futures in another direction",
            )
        from app.utils import is_trading_day

        now = swing_market.now()
        valid_day = datetime.fromtimestamp(now, UTC).date()
        if not is_trading_day(valid_day) or now >= swing_market.closing(
            valid_day.isoformat()
        ):
            valid_day += timedelta(days=1)
            while not is_trading_day(valid_day):
                valid_day += timedelta(days=1)
        valid_date = valid_day.isoformat()
        reserved = 0 if exiting else estimate["required_funds"]
        order = Order(
            order_id=identifier,
            session_id=child.session_id,
            user_id=user,
            symbol=child.symbol,
            side=req.side,
            order_type=req.order_type,
            quantity=req.quantity,
            trigger_price=req.price,
            limit_price=req.price,
            created_at=now,
            expiry=req.expiry,
            is_stoploss=req.order_type == OrderType.STOPLOSS,
            reserved_amount=reserved,
            trading_style="swing",
            portfolio_id=portfolio_id,
            wallet_ledger_id=child.wallet_ledger_id,
            wallet_ledger_kind=parent["mode"],
            execution_role="exit" if exiting else "entry",
            broker_product="NRML",
            source=f"{req.client}_swing_futures",
            reservation_margin_rate=reserved / (req.quantity * req.price)
            if reserved
            else 0,
            analytics={
                "capital": row["session_capital"],
                "sizing_method": "CAPITAL_PERCENT"
                if req.capital_pct is not None
                else "QUANTITY",
                "requested_pct": req.capital_pct * 100
                if req.capital_pct is not None
                else None,
                "entry_method": req.order_type.value if not exiting else None,
                "exit_method": req.order_type.value if exiting else None,
                "action_id": identifier,
                "swing_request": req.model_dump(mode="json"),
                "client": req.client,
                "futures": {
                    "contract": contract,
                    "fee_profile": profile.model_dump(mode="json"),
                    "provider": provider,
                    "approved_budget": req.approved_budget,
                    "valid_date": valid_date,
                    "margin": estimate["margin"] if estimate else 0,
                    "reserved_requirement": reserved,
                    "evidence": estimate["evidence"] if estimate else None,
                },
            },
        )
        if parent["mode"] == "paper":
            from app.services.swing_cash import move

            move(
                user,
                portfolio_id,
                -reserved,
                f"order:{identifier}:reserve",
                order=order,
            )
        else:
            from app.services.real_funding import reserve

            reserve(child, identifier, reserved)
            order_service._write_order_to_db(order, strict=True)
        order_service._orders.setdefault(child.session_id, {})[identifier] = order
        if parent["mode"] == "real":
            from app.services.broker_order_service import (
                submit_immediate_async,
                sync_order_edit_async,
            )

            try:
                if order.order_type == OrderType.LIMIT:
                    await submit_immediate_async(child, order)
                elif order.order_type == OrderType.STOPLOSS:
                    await sync_order_edit_async(child, order, OrderType.STOPLOSS, reprice=True)
            except Exception as exc:
                if (
                    order.recovery_state not in ("submitting", "unknown")
                    and not order.broker_order_id
                ):
                    order_service.cancel_order(
                        child.session_id, order.order_id, child.date
                    )
                raise HTTPException(
                    502,
                    "Broker Futures submission needs review; reconcile before retrying",
                ) from exc
    current.emit({"type": "portfolio_snapshot", **service.snapshot(user, portfolio_id)})
    return {"order_id": identifier, **service.snapshot(user, portfolio_id)}


async def settle_pending(session):
    from app.services.futures_settlements import official
    from app.utils import is_trading_day

    row = ledger.read(session)
    if not row["ledger"]["lots"]:
        session.futures_settlement_pending = False
        return
    beginning = min(
        datetime.fromtimestamp(lot["timestamp"], UTC).date()
        for lot in row["ledger"]["lots"]
    )
    until = datetime.fromtimestamp(swing_market.now(), UTC).date()
    if swing_market.now() < swing_market.closing(until.isoformat()) + 3600:
        until -= timedelta(days=1)
    last = max(row["ledger"]["settlements"], default="")
    day = (
        max(beginning, datetime.fromisoformat(last).date() + timedelta(days=1))
        if last
        else beginning
    )
    session.futures_settlement_pending = False
    while day <= until and day.isoformat() <= session.expiry:
        if is_trading_day(day):
            try:
                evidence = await asyncio.to_thread(
                    official, session.future_contract, day.isoformat()
                )
                row = ledger.read(session)
                state, movement = ledger.apply_settlement(
                    row["ledger"], day.isoformat(), evidence["price"]
                )
                state["settlements"][day.isoformat()]["source"] = evidence["source"]
                if session.session_type == "paper":
                    ledger.commit_paper(
                        session,
                        row,
                        state,
                        movement,
                        f"mtm:{session.session_id}:{day.isoformat()}",
                    )
                else:
                    from app.services.futures_real import save_ledger

                    save_ledger(session, row, state)
            except Exception as exc:  # noqa: BLE001 — financial failures retain pending/reconciliation state
                session.futures_settlement_pending = True
                session.futures_warning = f"Official Futures settlement pending for {day}: {type(exc).__name__}"
                return
        day += timedelta(days=1)
    session.futures_warning = ""


async def refresh_margin(session, price, timestamp):
    import time

    row = ledger.read(session)
    state = row["ledger"]
    if not state["lots"]:
        session.futures_margin_pending = False
        return
    if time.monotonic() < getattr(session, "futures_margin_check_after", 0):
        return
    session.futures_margin_check_after = time.monotonic() + 300
    if session.session_type == "real" and (
        session.real_recovery_pending
        or getattr(session, "broker_refresh_events", None) is not None
    ):
        return
    provider = (
        session.execution_broker
        if session.session_type == "real"
        else store.owned(session.user_id, session.portfolio_id).get("paper_broker")
        or "kite"
    )
    try:
        quantity = sum(lot["quantity"] for lot in state["lots"])
        side = "BUY" if state["lots"][0]["direction"] > 0 else "SELL"
        evidence = await asyncio.to_thread(
            risk.live_margin, session.future_contract, side, quantity, price, provider
        )
        fresh = ledger.read(session)
        if fresh["version"] != row["version"]:
            return  # A fill/settlement changed the held book during this read.
        held = sum(lot["margin"] for lot in state["lots"])
        if abs(evidence["margin"] - held) >= 0.01:
            changed, movement = ledger.revalue_margin(
                state, evidence["margin"], timestamp
            )
            if session.session_type == "paper":
                ledger.commit_paper(
                    session,
                    row,
                    changed,
                    movement,
                    f"margin:{session.session_id}:{row['version']}:{timestamp}",
                )
            else:
                from app.services.futures_real import save_ledger

                save_ledger(session, row, changed)
        session.futures_margin_pending = False
    except Exception as exc:  # noqa: BLE001 — financial failures retain pending/reconciliation state
        session.futures_margin_pending = True
        session.futures_margin_check_after = time.monotonic() + 15
        session.futures_warning = (
            f"Held Futures margin needs a usable broker quote: {type(exc).__name__}"
        )


async def on_quote(current, session, event):
    from app.services import swing_portfolio_service as service

    if (
        event.get("type") != "tick"
        or event.get("expiry", session.expiry) != session.expiry
    ):
        return
    from app.services.market_data import instrument_key

    expected = instrument_key(
        {"kind": "future", "underlying": session.symbol, "expiry": session.expiry}
    )
    group = getattr(session, "market_feed_group", None)
    if event.get("instrument_id") and event["instrument_id"] != expected:
        return
    if group and (
        event.get("provider")
        and event["provider"] != group.actual
        or event.get("feed_generation")
        and event["feed_generation"] != group.generation
    ):
        return
    now, price = int(event.get("time", 0)), float(event.get("close", 0))
    if (
        not math.isfinite(price)
        or price <= 0
        or not 0 <= swing_market.now() - now < 120
    ):
        return
    session.current_time = str(now)
    session.date = datetime.fromtimestamp(now, UTC).date().isoformat()
    service.update_current_mark(session, event, now)
    await service.persist_marks(session)
    await settle_pending(session)
    if not swing_market.window(now):
        return
    if not getattr(session, "futures_settlement_pending", False):
        await refresh_margin(session, price, now)
    if session.session_type == "real":
        from app.services.futures_real import on_quote as real_quote

        await real_quote(session, event)
        current.emit(
            {
                "type": "portfolio_snapshot",
                **service.snapshot(current.user, current.portfolio_id),
            }
        )
        return
    from app.routers.orders import _session_edit_lock

    async with _session_edit_lock(session):
        parent = store.owned(current.user, current.portfolio_id)
        expiry_close = (
            session.expiry == session.date
            and now >= swing_market.closing(session.date) - 900
        )
        if (
            parent["state"] == "closing"
            and now >= int(parent.get("updated_at", 0)) // 1000 + 19800
        ) or expiry_close:
            for order in list(order_service.get_open_orders(session.session_id)):
                order_service.cancel_order(
                    session.session_id, order.order_id, session.date
                )
            position = trading.get_position(
                session.session_id, session.symbol, expiry=session.expiry
            )
            if position.quantity:
                identifier = str(
                    uuid.uuid5(uuid.NAMESPACE_URL, f"{session.session_id}:close:{now}")
                )
                config = risk.settings()
                provider = parent.get("paper_broker") or "kite"
                order = Order(
                    order_id=identifier,
                    session_id=session.session_id,
                    user_id=session.user_id,
                    symbol=session.symbol,
                    side=TradeSide.SELL if position.side == "LONG" else TradeSide.BUY,
                    order_type=OrderType.LIMIT,
                    quantity=position.quantity,
                    trigger_price=price,
                    limit_price=price,
                    created_at=now,
                    expiry=session.expiry,
                    trading_style="swing",
                    portfolio_id=session.portfolio_id,
                    execution_role="exit",
                    broker_product="NRML",
                    wallet_ledger_id=session.wallet_ledger_id,
                    wallet_ledger_kind="paper",
                    source="swing_futures_close",
                    analytics={
                        "futures": {
                            "contract": session.future_contract,
                            "provider": provider,
                            "fee_profile": config.fees[provider].model_dump(
                                mode="json"
                            ),
                            "valid_date": session.date,
                        }
                    },
                )
                order_service._orders.setdefault(session.session_id, {})[identifier] = (
                    order
                )
        for order in list(order_service.get_open_orders(session.session_id)):
            info = (order.analytics or {}).get("futures", {})
            if (
                order.execution_role == "entry"
                and info.get("valid_date", session.date) < session.date
            ):
                order_service.cancel_order(
                    session.session_id, order.order_id, session.date
                )
                continue
            if order.swing_reconcile_pending:
                continue
            if order.order_type == OrderType.STOPLOSS:
                eligible = (
                    price <= order.trigger_price
                    if order.side == TradeSide.SELL
                    else price >= order.trigger_price
                )
            elif order.order_type == OrderType.TARGET:
                eligible = (
                    price >= order.trigger_price
                    if order.side == TradeSide.BUY
                    else price <= order.trigger_price
                )
            else:
                eligible = (
                    price <= order.limit_price
                    if order.side == TradeSide.BUY
                    else price >= order.limit_price
                )
            if not eligible:
                continue
            margin = 0.0
            profile = risk.FeeProfile.model_validate(info["fee_profile"])
            charges = risk.fees(
                profile,
                session.future_contract["exchange"],
                order.side.value,
                price,
                order.quantity,
            )
            if order.execution_role == "entry":
                try:
                    if not risk.settings().paper_enabled:
                        continue
                    service.require_entry_allowed(
                        session, order.side, order.quantity, expiry=session.expiry
                    )
                    capital_revision = (
                        (order.analytics or {})
                        .get("swing_request", {})
                        .get("capital_revision")
                    )
                    if (
                        capital_revision is not None
                        and capital_revision != parent["guardrail_epoch"]
                    ):
                        order.swing_reconcile_pending = True
                        order.swing_reconcile_reason = (
                            "Capital changed; cancel and review this intention"
                        )
                        order_service._write_order_to_db(order, strict=True)
                        continue
                    evidence = await asyncio.to_thread(
                        risk.live_margin,
                        session.future_contract,
                        order.side.value,
                        order.quantity,
                        price,
                        info["provider"],
                    )
                    if not 0 <= swing_market.now() - now <= 5:
                        continue  # Broker margin read was slow: wait for a new executable quote.
                    margin = evidence["margin"]
                    if margin + charges["total"] > info.get(
                        "approved_budget", order.reserved_amount
                    ):
                        order.swing_reconcile_pending = True
                        order.swing_reconcile_reason = "Actual margin exceeds the confirmed budget; cancel and review a new intention"
                        order_service._write_order_to_db(order, strict=True)
                        continue
                except Exception as exc:  # noqa: BLE001 — financial failures retain pending/reconciliation state
                    session.futures_warning = f"Entry waits for live margin/funding validation: {type(exc).__name__}"
                    continue  # Missing margin or guardrail: keep the confirmed intention pending.
            row = ledger.read(session)
            state, change = ledger.apply_fill(
                row["ledger"],
                order.order_id,
                order.side.value,
                order.quantity,
                price,
                margin,
                charges["total"],
                now,
            )
            filled = order.model_copy(
                update={
                    "status": OrderStatus.FILLED,
                    "filled_price": price,
                    "filled_at": now,
                    "reserved_amount": 0.0,
                }
            )
            analytics = {
                **(order.analytics or {}),
                "futures": {
                    **info,
                    "entry_margin": margin,
                    "fee_details": charges,
                    "lot_size": session.future_contract["lot_size"],
                    "settled_cash_change": change,
                },
            }
            filled.analytics = analytics
            trade = Trade(
                trade_id=order.order_id,
                user_id=session.user_id,
                symbol=session.symbol,
                side=order.side,
                quantity=order.quantity,
                price=price,
                timestamp=now,
                session_id=session.session_id,
                instrument_type="futures",
                expiry=session.expiry,
                commission=charges["total"],
                session_type="paper",
                trading_style="swing",
                portfolio_id=session.portfolio_id,
                source=order.source,
                execution_broker=info["provider"],
                analytics=analytics,
            )
            try:
                ledger.commit_paper(
                    session,
                    row,
                    state,
                    change + order.reserved_amount,
                    f"fill:{order.order_id}",
                    order=filled,
                    trade=trade,
                    allow_negative=order.execution_role == "exit",
                )
            except Exception as exc:
                from app.services.wallet_service import InsufficientFundsError

                if isinstance(exc, InsufficientFundsError):
                    order.swing_reconcile_pending = True
                    order.swing_reconcile_reason = (
                        "Available funds cannot cover current margin; cancel and review"
                    )
                    order_service._write_order_to_db(order, strict=True)
                    continue
                raise
            order_service._orders[session.session_id][order.order_id] = filled
            trading.ensure_session(session.session_id)
            if not any(
                t.trade_id == trade.trade_id
                for t in trading._trades[session.session_id]
            ):
                trading._trades[session.session_id].append(trade)
        result = service.snapshot(current.user, current.portfolio_id)
        if (
            parent.get("loss_limit_pct")
            and result["guardrail_pnl"] is not None
            and result["guardrail_pnl"]
            <= -parent["session_capital"] * parent["loss_limit_pct"]
        ):
            store.update(
                current.user,
                current.portfolio_id,
                {"guardrail_ban": True},
                parent["version"],
            )
        if (
            parent["state"] == "closing"
            and not result["positions"]
            and not result["open_orders"]
        ):
            store.finish_verified_close(current.user, current.portfolio_id)
            service.stop_runtime(current)
        current.emit(
            {
                "type": "portfolio_snapshot",
                **service.snapshot(current.user, current.portfolio_id),
            }
        )


async def consume(current, session):
    from app.services.market_data import FeedGroup, get_hub, selected_provider

    handle = None
    source = None
    try:
        while session.state != SimulationState.ENDED:
            parent = await asyncio.to_thread(
                store.owned, current.user, current.portfolio_id
            )
            if parent["state"] == "ended":
                return
            await settle_pending(session)
            from app.routers.orders import _session_edit_lock

            async with _session_edit_lock(session):
                for order in list(order_service.get_open_orders(session.session_id)):
                    valid = (order.analytics or {}).get("futures", {}).get("valid_date")
                    if (
                        order.execution_role == "entry"
                        and valid
                        and swing_market.now() >= swing_market.closing(valid)
                        and not order.broker_order_id
                        and order.recovery_state not in ("submitting", "unknown")
                    ):
                        order_service.cancel_order(
                            session.session_id, order.order_id, session.date
                        )
            needed = bool(
                trading.get_position(
                    session.session_id, session.symbol, expiry=session.expiry
                ).quantity
                or order_service.get_open_orders(session.session_id)
            )
            desired = (
                selected_provider()
                if needed and swing_market.window(swing_market.now())
                else None
            )
            if desired != source:
                if handle:
                    handle.close()
                handle = None
                source = None
                if desired:
                    group = FeedGroup(desired, session.session_type == "real")
                    session.market_feed_group = group
                    item = {
                        "kind": "future",
                        "underlying": session.symbol,
                        "exchange": session.future_contract["exchange"],
                        "expiry": session.expiry,
                    }
                    try:
                        handle = await get_hub().subscribe(
                            item, session.session_id, group, session.paper_tick_queue
                        )
                        source = desired
                        session.paper_stream_source = group.actual
                    except Exception as exc:  # noqa: BLE001 — financial failures retain pending/reconciliation state
                        session.futures_warning = (
                            f"Futures quote unavailable: {type(exc).__name__}"
                        )
            try:
                event = await asyncio.wait_for(
                    session.paper_tick_queue.get(), timeout=15
                )
            except TimeoutError:
                continue
            if handle:
                try:
                    if getattr(session, "swing_book_needs_repair", False):
                        restore(session)
                        session.swing_book_needs_repair = False
                    await on_quote(current, session, event)
                except Exception as exc:  # noqa: BLE001 — financial failures retain pending/reconciliation state
                    session.swing_book_needs_repair = True
                    session.futures_warning = (
                        f"Futures execution needs recovery: {type(exc).__name__}"
                    )
    finally:
        if handle:
            handle.close()
