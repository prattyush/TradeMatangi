"""Persistent Paper Swing execution contexts and shared portfolio controls."""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import logging
import uuid
from types import SimpleNamespace
from fastapi import HTTPException
from app.models.schemas import SimulationState, OrderType, TradeSide
from app.services import simulation, trading, order_service, strategy_service
from app.services import swing_portfolio_store as store, swing_cash


@dataclass
class Runtime:
    user: str
    portfolio_id: str
    contexts: dict = field(default_factory=dict)
    tasks: dict = field(default_factory=dict)
    subscribers: list = field(default_factory=list)

    def emit(self, event):
        for queue in list(self.subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # Replace obsolete snapshots, never grow a stalled screen's queue.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "portfolio_refresh_required"})


_runtimes = {}
_startup_task = None
logger = logging.getLogger(__name__)


def runtime(user, portfolio_id):
    current = _runtimes.get(portfolio_id)
    if current and current.user != user:
        raise HTTPException(404, "Swing portfolio not found")
    if current is None:
        store.owned(user, portfolio_id)
        current = Runtime(user, portfolio_id)
        _runtimes[portfolio_id] = current
    return current


def snapshot(user, portfolio_id):
    row = store.owned(user, portfolio_id)
    current = runtime(user, portfolio_id)
    positions, orders, executions = [], [], []
    net = 0.0
    complete = True
    for session in current.contexts.values():
        executions.extend(trading.get_trades(session.session_id))
        orders.extend(order_service.get_open_orders(session.session_id))
        contracts = (
            trading.get_open_option_contracts(session.session_id, session.symbol)
            if session.instrument_type == "options"
            else [{"right": None, "strike": None, "expiry": None}]
        )
        for contract in contracts:
            contract = {key: contract[key] for key in ("right", "strike", "expiry")}
            position = trading.get_position(
                session.session_id, session.symbol, **contract
            )
            if not position.quantity:
                continue
            quote_key = f"{session.symbol}:{contract['expiry']}:{contract['strike']}:{contract['right']}"
            quote = getattr(session, "desktop_contract_quotes", {}).get(quote_key, {})
            price = (
                quote.get("price")
                if contract["right"]
                else (
                    session.last_price
                    if getattr(session, "swing_quote_seen", False)
                    else None
                )
            )
            if not price or price <= 0:
                complete = False
                price = None
            else:
                net += (
                    position.quantity * price * (1 if position.side == "LONG" else -1)
                )
            positions.append(
                {
                    "session_id": session.session_id,
                    "symbol": session.symbol,
                    **contract,
                    **position.model_dump(mode="json"),
                    "mark_price": price,
                }
            )
    for trade in executions:
        net += (
            trade.price * trade.quantity * (1 if trade.side == TradeSide.SELL else -1)
            - trade.commission
        )
    pnl = round(net, 2) if complete else None
    return {
        "portfolio": row,
        "wallet_balance": swing_cash.read(user, portfolio_id)["current_balance"],
        "positions": positions,
        "open_orders": [o.model_dump(mode="json") for o in orders],
        "trades": [t.model_dump(mode="json") for t in executions],
        "contexts": [
            {
                "session_id": s.session_id,
                "symbol": s.symbol,
                "instrument_type": s.instrument_type,
                "date": s.date,
                "feed": getattr(s, "paper_stream_source", None),
            }
            for s in current.contexts.values()
        ],
        "pnl": pnl,
        "pnl_pct": round(pnl / row["session_capital"] * 100, 4)
        if pnl is not None
        else None,
        "guardrail_pnl": round(pnl - row["guardrail_start_pnl"], 2)
        if pnl is not None
        else None,
    }


def require_entry_allowed(
    session, side, quantity, right=None, strike=None, expiry=None
):
    position = trading.get_position(
        session.session_id, session.symbol, right, strike, expiry
    )
    exit_order = (
        side == TradeSide.SELL
        and position.side == "LONG"
        and quantity <= position.quantity
    )
    if exit_order:
        return
    if expiry and session.session_type != "real":
        from app.config import get_market_close

        stamp = int(session.current_time or 0)
        cutoff = (
            int(
                datetime.fromisoformat(
                    session.date + "T" + get_market_close(session.date)
                )
                .replace(tzinfo=timezone.utc)
                .timestamp()
            )
            - 900
        )
        if expiry < session.date or (expiry == session.date and stamp >= cutoff):
            raise HTTPException(
                400, "Paper Swing option entries are closed for this expiry"
            )
    if side != TradeSide.BUY:
        raise HTTPException(
            400,
            "Swing supports long positions only; SELL quantity cannot exceed the held position",
        )
    row = store.owned(session.user_id, session.portfolio_id)
    if (
        row["state"] != "running"
        or row["entries_paused"]
        or row.get("guardrail_ban")
        or getattr(session, "swing_entries_paused", False)
    ):
        raise HTTPException(
            403, "Swing entries are paused; positions and exits remain manageable"
        )


def attach_context(
    user,
    portfolio_id,
    symbol,
    instrument_type="equity",
    strike=None,
    expiry=None,
    right=None,
    *,
    subscribe=True,
):
    from app.config import SUPPORTED_SYMBOLS

    row = store.owned(user, portfolio_id)
    if row["mode"] != "paper":
        raise HTTPException(409, "This execution context requires a Paper portfolio")
    if row["state"] == "ended" or (
        row["state"] == "closing"
        and f"{symbol}:{instrument_type}" not in row["contexts"]
    ):
        raise HTTPException(409, "Cannot attach a new context while closing")
    definition = SUPPORTED_SYMBOLS.get(symbol)
    if not definition or instrument_type not in ("equity", "options"):
        raise HTTPException(422, "Unsupported portfolio instrument")
    if instrument_type == "equity" and definition.get("options_only"):
        raise HTTPException(422, "An index cannot be bought as equity")
    if instrument_type == "options" and (
        "options_exchange_code" not in definition
        or right not in ("CE", "PE")
        or not strike
        or strike <= 0
        or not expiry
    ):
        raise HTTPException(
            422, "Listed options require an exact right, strike and expiry"
        )
    current = runtime(user, portfolio_id)
    key = f"{symbol}:{instrument_type}"
    session = current.contexts.get(key)
    if session is None:
        sid = row["contexts"].get(key) or str(
            uuid.uuid5(uuid.NAMESPACE_URL, portfolio_id + ":" + key)
        )
        from app.services.db import get_dynamodb_resource

        saved = (
            get_dynamodb_resource()
            .Table("Sessions")
            .get_item(Key={"session_id": sid}, ConsistentRead=True)
            .get("Item")
        )
        if saved:
            session = simulation.rebuild_session_from_db(saved, user, read_only=False)
        else:
            session = simulation.SimulationSession(
                sid,
                symbol,
                row["date"],
                "09:15:00",
                1,
                user_id=user,
                instrument_type=instrument_type,
                strike=strike,
                expiry=expiry,
                right=right,
                strike_ce=strike if right == "CE" else None,
                strike_pe=strike if right == "PE" else None,
                session_type="paper",
                trading_style="swing",
                portfolio_id=portfolio_id,
                session_capital=row["session_capital"],
                wallet_ledger_id=f"swing:{portfolio_id}",
            )
            simulation._upsert_session_to_db(session, strict=True)
        session.swing_quote_seen = False
        session.desktop_contract_quotes = {}
        session.state = SimulationState.RUNNING
        session.resume_event.set()
        simulation._sessions[sid] = session
        restore_execution_book(session)
        current.contexts[key] = session
        if key not in row["contexts"]:
            store.update(
                user,
                portfolio_id,
                {"contexts": {**row["contexts"], key: sid}},
                row["version"],
            )
    if instrument_type == "options":
        from app.routers.desktop_trading import (
            DesktopOptionContract,
            _normalise_contract,
            _register_contract,
        )

        contract = _normalise_contract(
            DesktopOptionContract(
                symbol=symbol, strike=strike, expiry=expiry, right=right
            )
        )
        _register_contract(session, contract)
        simulation._upsert_session_to_db(session, strict=True)
        if session.paper_stream_source:
            simulation.subscribe_desktop_option_contract(session, contract)
    if subscribe and session.session_id not in current.tasks:
        current.tasks[session.session_id] = asyncio.create_task(
            _consume(current, session)
        )
    return session


async def ensure(user, portfolio_id, *, subscribe=True):
    row = store.owned(user, portfolio_id)
    if row["mode"] != "paper":
        raise HTTPException(409, "Paper runtime required")
    if row["state"] == "ended":
        current = runtime(user, portfolio_id)
        from app.services.db import get_dynamodb_resource

        for key, sid in row["contexts"].items():
            if key in current.contexts:
                continue
            saved = await asyncio.to_thread(
                lambda sid=sid: (
                    get_dynamodb_resource()
                    .Table("Sessions")
                    .get_item(Key={"session_id": sid}, ConsistentRead=True)
                    .get("Item")
                )
            )
            if not saved:
                raise HTTPException(503, "Archived Swing context is missing")
            current.contexts[key] = simulation.rebuild_session_from_db(
                saved, user, read_only=True
            )
        return current
    for key, sid in row["contexts"].items():
        symbol, kind = key.rsplit(":", 1)
        from app.services.db import get_dynamodb_resource

        saved = await asyncio.to_thread(
            lambda sid=sid: (
                get_dynamodb_resource()
                .Table("Sessions")
                .get_item(Key={"session_id": sid}, ConsistentRead=True)
                .get("Item")
            )
        )
        if not saved:
            raise HTTPException(
                503, "Saved portfolio context is missing; no new book was substituted"
            )
        attach_context(
            user,
            portfolio_id,
            symbol,
            kind,
            saved.get("strike"),
            saved.get("expiry"),
            saved.get("right"),
            subscribe=subscribe,
        )
    return runtime(user, portfolio_id)


async def _consume(current, session):
    from app.services.market_data import get_hub, FeedGroup, selected_provider
    from app.config import SUPPORTED_SYMBOLS
    from app.services.real_trading_day import market_date

    try:
        while session.state != SimulationState.ENDED:
            handles = []
            try:
                group = FeedGroup(selected_provider(), False)
                session.market_feed_group = group
                definition = SUPPORTED_SYMBOLS[session.symbol]
                underlying = {
                    "kind": "index" if definition["options_only"] else "equity",
                    "exchange": definition["exchange_code"],
                    "symbol": session.symbol,
                }
                handles.append(
                    await get_hub().subscribe(
                        underlying, session.session_id, group, session.paper_tick_queue
                    )
                )
                session.paper_stream_source = group.actual
                # Subscription comes from exact attached contracts, not an old
                # month's single primary strike. This survives option rollover.
                for contract in getattr(session, "desktop_contracts", []):
                    if contract["expiry"] < market_date():
                        continue
                    task = simulation.subscribe_desktop_option_contract(
                        session, contract
                    )
                    if task:
                        await task
                session.stream_manager = SimpleNamespace(
                    stop=lambda: [h.close() for h in handles]
                )
                while session.state != SimulationState.ENDED:
                    event = await session.paper_tick_queue.get()
                    await on_tick(current, session, event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                current.emit(
                    {
                        "type": "portfolio_error",
                        "message": str(exc),
                        "session_id": session.session_id,
                    }
                )
                for handle in handles:
                    handle.close()
                simulation._stop_desktop_option_subscriptions(session)
                await asyncio.sleep(10)
    finally:
        if session.stream_manager:
            session.stream_manager.stop()
        simulation._stop_desktop_option_subscriptions(session)
        current.tasks.pop(session.session_id, None)


async def on_tick(current, session, event):
    if event.get("type") != "tick":
        current.emit(event)
        return
    timestamp = int(event["time"])
    if session.current_time and timestamp < int(session.current_time):
        return
    if (
        event.get("provider")
        and session.paper_stream_source
        and event["provider"] != session.paper_stream_source
    ):
        return
    date = datetime.fromtimestamp(timestamp, timezone.utc).date().isoformat()
    # Tick times encode IST wall clock as UTC, just like the intraday engine.
    if date != session.date:
        session.date = date
        session._auto_closed = False
        simulation._upsert_session_to_db(session, strict=True)
    session.current_time = str(timestamp)
    if not event.get("right"):
        session.last_price = float(event["close"])
        session.swing_quote_seen = True
    if event.get("right"):
        key = f"{session.symbol}:{event.get('expiry')}:{event.get('strike')}:{event['right']}"
        registry = getattr(session, "desktop_contract_quotes", {})
        registry[key] = {
            **event,
            "price": float(event["close"]),
            "timestamp": timestamp,
        }
        session.desktop_contract_quotes = registry
    row = store.owned(current.user, current.portfolio_id)
    session.session_capital = row["session_capital"]
    before = snapshot(current.user, current.portfolio_id)
    if (
        row.get("loss_limit_pct")
        and before["pnl"] is not None
        and before["guardrail_pnl"] <= -row["session_capital"] * row["loss_limit_pct"]
        and not row.get("guardrail_ban")
    ):
        row = store.update(
            current.user, current.portfolio_id, {"guardrail_ban": True}, row["version"]
        )
    session.swing_entries_paused = (
        row["entries_paused"]
        or row.get("guardrail_ban", False)
        or row["state"] != "running"
    )
    expiry_exit = False
    if event.get("right") and event.get("expiry"):
        from app.config import get_market_close

        close_time = int(
            datetime.fromisoformat(date + "T" + get_market_close(date))
            .replace(tzinfo=timezone.utc)
            .timestamp()
        )
        expiry_exit = event["expiry"] < date or (
            event["expiry"] == date and timestamp >= close_time - 900
        )
    if row["state"] == "closing" or expiry_exit:
        close_position_on_quote(session, event)
    for filled in simulation._emit_tick_and_check_orders(
        session, event, event.get("right")
    ):
        session.queue.put_nowait(json.dumps(filled))
    result = snapshot(current.user, current.portfolio_id)
    if (
        row.get("loss_limit_pct")
        and result["pnl"] is not None
        and result["guardrail_pnl"] <= -row["session_capital"] * row["loss_limit_pct"]
        and not row.get("guardrail_ban")
    ):
        store.update(
            current.user, current.portfolio_id, {"guardrail_ban": True}, row["version"]
        )
        session.swing_entries_paused = True
        result = snapshot(current.user, current.portfolio_id)
    if (
        row["state"] == "closing"
        and not result["positions"]
        and not result["open_orders"]
    ):
        store.finish_verified_close(current.user, current.portfolio_id)
        result = snapshot(current.user, current.portfolio_id)
        stop_runtime(current)
    current.emit({"type": "portfolio_snapshot", **result})


async def shutdown():
    global _startup_task
    if _startup_task:
        _startup_task.cancel()
        await asyncio.gather(_startup_task, return_exceptions=True)
        _startup_task = None
    tasks = [task for current in _runtimes.values() for task in current.tasks.values()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _runtimes.clear()


def close_position_on_quote(session, event):
    right, strike, expiry = event.get("right"), event.get("strike"), event.get("expiry")
    if session.instrument_type == "options" and not right:
        return
    position = trading.get_position(
        session.session_id, session.symbol, right, strike, expiry
    )
    for order in list(order_service.get_open_orders(session.session_id)):
        if (order.right, order.strike, order.expiry) == (right, strike, expiry):
            order_service.cancel_order(session.session_id, order.order_id, session.date)
    if not position.quantity:
        return
    price = float(event["close"])
    if price <= 0:
        return
    order_service.place_order(
        session.session_id,
        session.symbol,
        TradeSide.SELL,
        OrderType.LIMIT,
        position.quantity,
        int(event["time"]),
        session.date,
        limit_price=price,
        is_stoploss=True,
        right=right,
        strike=strike,
        expiry=expiry,
        user_id=session.user_id,
        source="swing_close",
        wallet_ledger_id=session.wallet_ledger_id,
        wallet_ledger_kind="paper",
    )


async def close_portfolio(user, portfolio_id):
    row = store.owned(user, portfolio_id)
    if row["state"] == "ended":
        return row
    if row["state"] != "closing":
        row = store.update(
            user,
            portfolio_id,
            {"state": "closing", "entries_paused": True},
            row["version"],
        )
    current = await ensure(user, portfolio_id)
    for session in current.contexts.values():
        session.swing_entries_paused = True
        strategy_service.cancel_all(session.session_id)
        for order in list(order_service.get_open_orders(session.session_id)):
            position = trading.get_position(
                session.session_id,
                session.symbol,
                order.right,
                order.strike,
                order.expiry,
            )
            if (
                order.side == TradeSide.SELL
                and position.side == "LONG"
                and order.quantity <= position.quantity
            ):
                continue
            order_service.cancel_order(session.session_id, order.order_id, session.date)
    result = snapshot(user, portfolio_id)
    if not result["positions"] and not result["open_orders"]:
        store.finish_verified_close(user, portfolio_id)
        stop_runtime(current)
    # Exits use subsequent actual quotes, never an arbitrary UI-provided price.
    current.emit({"type": "portfolio_snapshot", **snapshot(user, portfolio_id)})
    return store.owned(user, portfolio_id)


def stop_runtime(current):
    active = asyncio.current_task()
    for context in list(current.contexts.values()):
        simulation.stop_session(context, preserve_trading_state=True)
    for task in list(current.tasks.values()):
        if task is not active:
            task.cancel()


def restore_execution_book(session):
    """Repair only fills atomically committed with cash, never guessed executions."""
    from boto3.dynamodb.conditions import Key
    from app.services.db import get_dynamodb_resource
    from app.models.schemas import Order, OrderStatus

    table = get_dynamodb_resource().Table("Orders")
    params = {
        "KeyConditionExpression": Key("session_id").eq(session.session_id),
        "ConsistentRead": True,
    }
    records = []
    while True:
        page = table.query(**params)
        records.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            break
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    orders = {}
    for item in records:
        order = Order.model_validate(item)
        orders[order.order_id] = order
        if order.status == OrderStatus.FILLED:
            if order.filled_price is None or order.filled_at is None:
                raise HTTPException(
                    503, "Recorded Swing fill is missing execution evidence"
                )
            trading.record_trade(
                session.session_id,
                order.side,
                order.filled_price,
                order.filled_at,
                quantity=order.quantity,
                symbol=order.symbol,
                right=order.right,
                strike=order.strike,
                expiry=order.expiry,
                instrument_type="options" if order.right else "equity",
                brokerage_per_order=session.brokerage_per_order,
                user_id=session.user_id,
                session_type="paper",
                source=order.source,
                trade_id=order.order_id,
            )
    order_service._orders[session.session_id] = orders


def startup():
    """Restore active persistent Paper books independently of attached screens."""
    global _startup_task
    if _startup_task is None or _startup_task.done():
        _startup_task = asyncio.create_task(restore_active_portfolios())


def _active_paper_rows():
    from boto3.dynamodb.conditions import Attr
    from app.services.db import get_dynamodb_resource

    table = get_dynamodb_resource().Table("Sessions")
    params = {
        "FilterExpression": Attr("record_type").eq("swing_portfolio")
        & Attr("mode").eq("paper")
        & Attr("state").is_in(["running", "closing"]),
        "ConsistentRead": True,
    }
    rows = []
    while True:
        page = table.scan(**params)
        rows.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return rows
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


async def restore_active_portfolios():
    try:
        rows = await asyncio.to_thread(_active_paper_rows)
    except Exception:
        logger.exception("Could not read active Swing portfolios at startup")
        return
    for row in rows:
        try:
            await ensure(row["user_id"], row["session_id"])
        except Exception:
            logger.exception(
                "Swing portfolio restoration needs reconciliation: %s",
                row["session_id"],
            )
