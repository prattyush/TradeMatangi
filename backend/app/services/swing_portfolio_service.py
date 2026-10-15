"""Persistent Paper Swing execution contexts and shared portfolio controls."""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import logging
import time
from math import isfinite
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
    initializing: bool = False
    real_ready: bool = False

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
    from app.services import swing_market
    row = store.owned(user, portfolio_id)
    current = runtime(user, portfolio_id)
    positions, orders, executions, marker_basis = [], [], [], []
    futures = []
    net = 0.0
    complete = True
    for session in current.contexts.values():
        net -= getattr(session, "opening_inventory_cost", 0)
        executions.extend(trading.get_trades(session.session_id))
        captured = getattr(session, "opening_inventory_captured_at", 0)
        if captured:
            marker_basis.extend({**holding, "session_id": session.session_id,
                                 "symbol": session.symbol, "instrument_type": session.instrument_type,
                                 "timestamp": int(captured) // 1000 + 19800}
                                for holding in getattr(session, "opening_positions", []))
        orders.extend(order_service.get_open_orders(session.session_id))
        if session.instrument_type == "futures":
            from app.services.futures_ledger import read, values
            mark = session.last_price if getattr(session,"swing_quote_seen",False) else None
            metrics = values(read(session)["ledger"],mark)
            futures.append({"session_id":session.session_id,"symbol":session.symbol,"expiry":session.expiry,
                            **metrics,"warning":getattr(session,"futures_warning","")})
            if metrics["economic_pnl"] is None:
                complete = False
            else:
                net += metrics["economic_pnl"]
            if metrics["quantity"]:
                positions.append({"session_id":session.session_id,"symbol":session.symbol,"instrument_type":"futures",
                    "expiry":session.expiry,"right":None,"strike":None,"quantity":metrics["quantity"],
                    "side":metrics["side"],"avg_entry_price":metrics["avg_entry_price"],"mark_price":mark,
                    "mark_time":getattr(session,"swing_mark_time",None),"quote_status":"live" if mark and getattr(session,"swing_mark_source","live") == "live" and swing_market.window(swing_market.now()) and 0 <= swing_market.now()-int(getattr(session,"swing_mark_time",0) or 0)<120 else "stale" if mark else "unavailable",
                    "invested_value":metrics["held_margin"],"held_margin":metrics["held_margin"],
                    "unrealized_pnl":metrics["economic_open_pnl"],"unrealized_pnl_pct":round(metrics["economic_open_pnl"]/metrics["held_margin"]*100,4) if metrics["held_margin"] and metrics["economic_open_pnl"] is not None else None,
                    "notional_exposure":mark*metrics["quantity"] if mark else None,
                    "unsettled_pnl":metrics["unsettled_pnl"],"settled_mtm":metrics["settled_mtm"]})
            continue
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
            invested = position.quantity * position.avg_entry_price
            unrealized = (position.quantity * (price - position.avg_entry_price) - position.entry_commission) if price is not None else None
            if session.session_type == "real" and session.real_recovery_pending: unrealized = None
            quote_time = quote.get("timestamp") if contract["right"] else getattr(session, "swing_mark_time", None)
            positions.append(
                {
                    "session_id": session.session_id,
                    "symbol": session.symbol,
                    **contract,
                    **position.model_dump(mode="json"),
                    "mark_price": price,
                    "mark_time": quote_time,
                    "quote_status": "unavailable" if price is None else "live" if (quote.get("mark_source", "live") if contract["right"] else getattr(session, "swing_mark_source", "live")) == "live" and quote_time and swing_market.window(swing_market.now()) and 0 <= swing_market.now() - int(quote_time) < 120 else "stale",
                    "invested_value": round(invested, 2),
                    "unrealized_pnl": round(unrealized, 2) if unrealized is not None else None,
                    "unrealized_pnl_pct": round(unrealized / invested * 100, 4) if unrealized is not None and invested else None,
                }
            )
    for trade in executions:
        if trade.instrument_type == "futures":
            continue
        net += (
            trade.price * trade.quantity * (1 if trade.side == TradeSide.SELL else -1)
            - trade.commission
        )
    from app.services.real_broker_policy import enabled as restrictions_enabled
    if row["mode"] == "real":
        complete = complete and current.real_ready and row["contexts"] == {key: child.session_id for key, child in current.contexts.items()} and not any(child.real_recovery_pending for child in current.contexts.values())
        from app.services import swing_funding_store as funding
        pool = funding.read(user, row["execution_broker"], row["broker_account_id"]) if row["state"] != "ended" and restrictions_enabled() else None
        mode = (pool or {}).get("funding", {}).get("modes", {}).get("swing", {})
        from app.services.swing_accounting import mode_available
        wallet_balance = mode_available(pool['funding'], 'swing') if mode else 0
        funding_status = (pool or {}).get("funding_status")
        if funding_status and pool:
            local_reserved = sum(ticket['amount'] for ticket in pool['funding'].get('reservations', {}).values() if ticket['owner'] == 'local')
            wallet_balance = max(0, min(wallet_balance, funding_status['available'] - local_reserved))
    else:
        wallet_balance = swing_cash.read(user, portfolio_id)["current_balance"]
        funding_status = None
    if row["mode"] == "real" and not restrictions_enabled() and row["state"] != "ended":
        from app.services import wallet_service
        from app.services.real_trading_day import market_date
        ledger=f"real:{row['execution_broker']}:{row['broker_account_id']}:{market_date()}"
        wallet_balance=wallet_service.get_real_wallet_snapshot(user,market_date(),ledger)["balance"]
        funding_status=None
    if row["mode"] == "real" and row["state"] == "ended":
        positions, orders = [], []
        wallet_balance, funding_status = None, None
        complete = complete and not row.get("history_warning")
    pnl = round(net, 2) if complete else None
    requirements = {}
    if row["mode"] == "real":
        from app.services.real_recovery import closure_requirements
        requirements = closure_requirements(list(current.contexts.values()), row.get("acknowledged_undated_submission_ids", []))
    delivery_review=[]
    if row["mode"]=="real" and current.contexts:
        from app.services.futures_real import delivery_review_contexts
        delivery_review=delivery_review_contexts(current)
    return {
        "portfolio": row,
        "delivery_review_context_ids":delivery_review,
        **requirements,
        "wallet_balance": wallet_balance,
        "funding_status": {key: value for key, value in funding_status.items() if key != "modes"} if funding_status else None,
        "allocation_pct": mode.get("funding_allocation", mode.get("capital", 0)) / pool["funding"]["allocation_reference"] if row["mode"] == "real" and pool else None,
        "positions": positions,
        "open_orders": [o.model_dump(mode="json") for o in orders],
        "trades": [t.model_dump(mode="json") for t in executions],
        "marker_basis": marker_basis,
        "futures": futures,
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
        "reconciliation_pending": ["settlement:"+s.session_id for s in current.contexts.values() if getattr(s,"futures_settlement_pending",False) or getattr(s,"futures_margin_pending",False)] + (["portfolio:" + portfolio_id] if row["mode"] == "real" and not current.real_ready else []) + [
            o.order_id for o in orders if o.swing_reconcile_pending
        ]
        + [
            "book:" + child.session_id
            for child in current.contexts.values()
            if getattr(child, "swing_book_needs_repair", False)
        ],
        "valuation_status": "unavailable" if pnl is None else "stale" if any(p.get("quote_status") != "live" for p in positions) else "live",
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
    exit_order = quantity <= position.quantity and (
        (side == TradeSide.SELL and position.side == "LONG") or
        (session.instrument_type == "futures" and side == TradeSide.BUY and position.side == "SHORT")
    )
    if session.session_type == "real":
        current = _runtimes.get(session.portfolio_id)
        if not current or not current.real_ready:
            raise HTTPException(409, "Portfolio contexts are restoring; retry after reconciliation")
    if exit_order:
        return
    if session.session_type == "real":
        from app.services.real_broker_policy import enforce
        if enforce(session) and session.real_recovery_pending:
            raise HTTPException(409, "Broker history needs reconciliation; entries wait")
        from app.services.real_funding import require_entry
        require_entry(session)
    if expiry and session.session_type != "real":
        from app.services.swing_market import closing

        stamp = int(session.current_time or 0)
        cutoff = closing(session.date) - 900
        if expiry < session.date or (expiry == session.date and stamp >= cutoff):
            raise HTTPException(
                400, "Paper Swing option entries are closed for this expiry"
            )
    if side != TradeSide.BUY and session.instrument_type != "futures":
        raise HTTPException(
            400,
            "Swing supports long positions only; SELL quantity cannot exceed the held position",
        )
    row = store.owned(session.user_id, session.portfolio_id)
    current = _runtimes.get(session.portfolio_id)
    if current and (
        any(
            getattr(child, "futures_margin_pending", False) or getattr(child, "futures_settlement_pending", False) or getattr(child, "swing_book_needs_repair", False) or (child.session_type == "real" and child.real_recovery_pending)
            for child in current.contexts.values()
        )
        or any(
            o.swing_reconcile_pending
            for child in current.contexts.values()
            for o in order_service.get_open_orders(child.session_id)
        )
    ):
        raise HTTPException(
            409,
            "Paper broker-order recovery is pending; entries wait for reconciliation",
        )
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
    future_contract=None,
):
    from app.config import SUPPORTED_SYMBOLS

    row = store.owned(user, portfolio_id)
    if row["mode"] not in ("paper", "real"):
        raise HTTPException(409, "Unsupported portfolio mode")
    context_key = f"{symbol}:futures:{expiry}" if instrument_type == "futures" else f"{symbol}:{instrument_type}"
    if row["state"] == "ended" or (
        row["state"] == "closing"
        and context_key not in row["contexts"]
    ):
        raise HTTPException(409, "Cannot attach a new context while closing")
    definition = SUPPORTED_SYMBOLS.get(symbol)
    if not definition or instrument_type not in ("equity", "options", "futures"):
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
    key = context_key
    session = current.contexts.get(key)
    saved = None
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
    metadata = None
    if instrument_type == "futures":
        if not expiry or right is not None or strike is not None:
            raise HTTPException(422, "Futures require an exact expiry without option fields")
        metadata = future_contract or getattr(session,"future_contract",None) or (saved or {}).get("future_contract")
        if not metadata:
            raise HTTPException(503, "Listed Futures metadata must be resolved before creating the context")
    if instrument_type == "options":
        existing = next(
            (
                c
                for c in (
                    getattr(session, "desktop_contracts", [])
                    if session is not None
                    else (saved or {}).get("desktop_contracts", [])
                )
                if (c.get("strike"), c.get("expiry"), c.get("right"))
                == (strike, expiry, right)
            ),
            None,
        )
        metadata = existing
        if existing is None:
            from app.services.breeze_master import listed_option_contract

            try:
                metadata = listed_option_contract(symbol, strike, expiry, right)
            except FileNotFoundError as exc:
                raise HTTPException(
                    503,
                    "Option contract metadata is unavailable; no lot size was guessed",
                ) from exc
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
    if session is None:
        if saved:
            session = simulation.rebuild_session_from_db(saved, user, read_only=row["mode"] == "real")
        else:
            session = simulation.SimulationSession(
                sid,
                symbol,
                row["date"],
                "09:15:00",
                1,
                user_id=user,
                instrument_type=instrument_type,
                future_contract=metadata if instrument_type == "futures" else None,
                strike=strike,
                expiry=expiry,
                right=right,
                strike_ce=strike if right == "CE" else None,
                strike_pe=strike if right == "PE" else None,
                session_type=row["mode"],
                execution_broker=row.get("execution_broker") or "kotak",
                broker_account_id=row.get("broker_account_id"),
                real_funding_period=row.get("real_funding_period"),
                trading_style="swing",
                portfolio_id=portfolio_id,
                session_capital=row["session_capital"],
                wallet_ledger_id=f"real:{row['execution_broker']}:{row['broker_account_id']}:{row['date']}" if row["mode"] == "real" else f"swing:{portfolio_id}",
            )
            if row["mode"] == "real":
                from app.services.swing_real import bind_child
                bind_child(current, session, row)
            simulation._upsert_session_to_db(session, strict=True)
        if row["mode"] == "real":
            from app.services.swing_real import bind_child
            bind_child(current, session, row)
        from app.services.real_broker_policy import enforce
        session.swing_recovery_required = row["mode"] != "real" or enforce(session)
        session.swing_quote_seen = False
        session.desktop_contract_quotes = {}
        if row["mode"] == "paper" and saved:
            session.swing_marks = saved.get("swing_marks", {})
            for mark in session.swing_marks.values():
                update_current_mark(session, mark, int(mark["time"]))
            # Older session rows already saved their last equity price/time.
            if session.instrument_type in ("equity", "futures") and not session.swing_quote_seen and session.last_price > 0 and session.current_time:
                update_current_mark(session, {"close": session.last_price, "mark_source": "saved"}, int(session.current_time))
        session.state = SimulationState.RUNNING
        session.resume_event.set()
        if row["mode"] == "paper":
            restore_execution_book(session)
        else:
            from app.services.real_broker_state import restore_orders
            restore_orders(session)
        if key not in row["contexts"]:
            store.update(
                user,
                portfolio_id,
                {"contexts": {**row["contexts"], key: sid}},
                row["version"],
            )
        current.contexts[key] = session
        simulation._sessions[sid] = session
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
        if metadata and metadata.get("lot_size"):
            contract["lot_size"] = metadata["lot_size"]
        _register_contract(session, contract)
        simulation._upsert_session_to_db(session, strict=True)
        if session.paper_stream_source:
            simulation.subscribe_desktop_option_contract(session, contract)
    if subscribe and (session.session_id not in current.tasks or current.tasks[session.session_id].done()):
        if session.instrument_type == "futures":
            from app.services.swing_futures import consume
            current.tasks[session.session_id] = asyncio.create_task(consume(current,session))
        else:
            current.tasks[session.session_id] = asyncio.create_task(_consume(current,session))
    return session


async def ensure(user, portfolio_id, *, subscribe=True):
    current = runtime(user, portfolio_id)
    if current.initializing:
        raise HTTPException(409, "Portfolio restoration is in progress; retry shortly")
    current.initializing = True
    try:
        result = await _restore(user, portfolio_id, subscribe=subscribe)
        current.real_ready = True
        return result
    except Exception:
        current.real_ready = False
        raise
    finally:
        current.initializing = False


async def _restore(user, portfolio_id, *, subscribe=True):
    row = store.owned(user, portfolio_id)
    if row["mode"] == "real" and row["state"] != "ended":
        from app.dependencies import require_real_trading_access
        from app.services.swing_real import bind
        require_real_trading_access(user)
        await bind(runtime(user, portfolio_id), row)
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
        if ":futures:" in key:
            symbol, kind, _expiry = key.split(":", 2)
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
        child = attach_context(
            user,
            portfolio_id,
            symbol,
            kind,
            saved.get("strike"),
            saved.get("expiry") or (saved.get("future_contract") or {}).get("expiry"),
            saved.get("right"),
            subscribe=subscribe,
        )
        if getattr(child, "swing_book_needs_repair", False):
            restore_execution_book(child)
            child.swing_book_needs_repair = False
    return runtime(user, portfolio_id)


def required_contracts(session):
    contracts = (
        trading.get_open_option_contracts(session.session_id, session.symbol)
        if session.instrument_type == "options"
        else []
    )
    contracts += [
        {"right": o.right, "strike": o.strike, "expiry": o.expiry}
        for o in order_service.get_open_orders(session.session_id)
        if o.right
    ]
    keys = {(c["right"], c["strike"], c["expiry"]) for c in contracts}
    return [
        c
        for c in getattr(session, "desktop_contracts", [])
        if (c["right"], c["strike"], c["expiry"]) in keys
    ]


async def _consume(current, session):
    from app.services.market_data import get_hub, FeedGroup, selected_provider
    from app.services import swing_market
    from app.config import SUPPORTED_SYMBOLS

    handles, subscribed = [], None
    active, next_owner_check = True, 0
    try:
        while session.state != SimulationState.ENDED:
            try:
                if asyncio.get_running_loop().time() >= next_owner_check:
                    active = (
                        await asyncio.to_thread(
                            store.owned, current.user, current.portfolio_id
                        )
                    )["state"] != "ended"
                    next_owner_check = asyncio.get_running_loop().time() + 15
                held = (
                    trading.get_position(session.session_id, session.symbol).quantity
                    if session.instrument_type == "equity"
                    else bool(required_contracts(session))
                )
                needed = active and (
                    held or order_service.get_open_orders(session.session_id)
                )
                contracts = required_contracts(session)
                signature = (
                    (
                        selected_provider(),
                        tuple(
                            (c["right"], c["strike"], c["expiry"]) for c in contracts
                        ),
                    )
                    if needed and swing_market.window(swing_market.now())
                    else None
                )
                if signature != subscribed:
                    for handle in handles:
                        handle.close()
                    handles = []
                    simulation._stop_desktop_option_subscriptions(session)
                    subscribed = None
                    if signature:
                        session.swing_recovery_required = True
                        group = FeedGroup(signature[0], session.session_type == "real")
                        session.market_feed_group = group
                        definition = SUPPORTED_SYMBOLS[session.symbol]
                        underlying = {
                            "kind": "index" if definition["options_only"] else "equity",
                            "exchange": definition["exchange_code"],
                            "symbol": session.symbol,
                        }
                        handles.append(
                            await get_hub().subscribe(
                                underlying,
                                session.session_id,
                                group,
                                session.paper_tick_queue,
                            )
                        )
                        session.paper_stream_source = group.actual
                        for contract in contracts:
                            if contract["expiry"] < swing_market.today():
                                continue
                            task = simulation.subscribe_desktop_option_contract(
                                session, contract
                            )
                            if task:
                                await task
                        session.stream_manager = SimpleNamespace(
                            stop=lambda: [h.close() for h in handles]
                        )
                        subscribed = signature
                try:
                    event = await asyncio.wait_for(
                        session.paper_tick_queue.get(), timeout=15
                    )
                except TimeoutError:
                    continue
                if signature and (
                    event.get("type") != "tick"
                    or 0 <= swing_market.now() - int(event.get("time", 0)) < 120
                ):
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
                handles, subscribed = [], None
                simulation._stop_desktop_option_subscriptions(session)
                await asyncio.sleep(10)
    finally:
        for handle in handles:
            handle.close()
        simulation._stop_desktop_option_subscriptions(session)
        current.tasks.pop(session.session_id, None)


async def on_tick(current, session, event):
    if session.instrument_type == "futures":
        from app.services.swing_futures import on_quote
        await on_quote(current,session,event)
        return
    if getattr(session, "swing_book_needs_repair", False):
        restore_execution_book(session)
        session.swing_book_needs_repair = False
    if session.session_type == "real" and not current.real_ready:
        return
    if event.get("type") != "tick":
        current.emit(event)
        return
    timestamp = int(event["time"])
    price = float(event["close"])
    if not isfinite(price) or price < 0:
        current.emit(
            {
                "type": "portfolio_quote_unavailable",
                "message": "No executable quote is available",
                "session_id": session.session_id,
            }
        )
        return
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
    from app.services import swing_paper_recovery as recovery

    if price == 0 or not recovery.day_window(timestamp):
        update_current_mark(session, event, timestamp)
        await persist_marks(session)
        current.emit(
            {
                "type": "portfolio_snapshot",
                **snapshot(current.user, current.portfolio_id),
            }
        )
        return
    if session.session_type == "paper":
        await recovery.before_quote_async(session, event)
    update_current_mark(session, event, timestamp)
    await persist_marks(session)
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
    if session.session_type != "real" and event.get("right") and event.get("expiry"):
        from app.services.swing_market import window
        close_time = window(timestamp)["closing"]
        expiry_exit = event["expiry"] < date or (
            event["expiry"] == date and timestamp >= close_time - 900
        )
    if (row["state"] == "closing" or expiry_exit) and session.session_type == "paper":
        close_position_on_quote(session, event)
    if session.session_type == "real":
        from app.services.swing_real import renew_protection_on_quote
        await renew_protection_on_quote(session, event)
    try:
        events = (simulation._emit_tick_and_check_orders_real(session, event, event.get("right"), asyncio.get_running_loop())
                  if session.session_type == "real" and not session.real_recovery_pending
                  else [] if session.session_type == "real"
                  else simulation._emit_tick_and_check_orders(session, event, event.get("right")))
        for filled in events:
            session.queue.put_nowait(json.dumps(filled))
    except Exception:
        session.swing_book_needs_repair = True
        raise
    if session.session_type == "paper":
        recovery.after_quote(session, event)
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
        row["mode"] == "paper"
        and row["state"] == "closing"
        and not result["positions"]
        and not result["open_orders"]
    ):
        store.finish_verified_close(current.user, current.portfolio_id)
        result = snapshot(current.user, current.portfolio_id)
        stop_runtime(current)
    current.emit({"type": "portfolio_snapshot", **result})


async def shutdown():
    from app.services import swing_charts
    await swing_charts.shutdown()
    global _startup_task, _risk_refresh_task
    if _risk_refresh_task:
        _risk_refresh_task.cancel()
        await asyncio.gather(_risk_refresh_task,return_exceptions=True)
        _risk_refresh_task=None
    if _startup_task:
        _startup_task.cancel()
        await asyncio.gather(_startup_task, return_exceptions=True)
        _startup_task = None
    tasks = [task for current in _runtimes.values() for task in current.tasks.values()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await asyncio.gather(*(persist_marks(session, force=True) for current in _runtimes.values() for session in current.contexts.values()))
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


async def close_portfolio(user, portfolio_id, acknowledge_undated_submission_ids=None, *, acknowledge_delivery_context_ids=None):
    row = store.owned(user, portfolio_id)
    if row["state"] == "ended":
        return row
    if row["mode"] == "real" and acknowledge_undated_submission_ids:
        from app.services.real_recovery import validate_acknowledgements
        current = await ensure(user, portfolio_id)
        accepted = validate_acknowledgements(list(current.contexts.values()), acknowledge_undated_submission_ids)
        row = store.owned(user, portfolio_id)
        row = store.update(user, portfolio_id, {"acknowledged_undated_submission_ids": sorted(set(row.get("acknowledged_undated_submission_ids", [])) | set(accepted))}, row["version"])
    if row["mode"]=="real" and acknowledge_delivery_context_ids:
        from app.services.futures_real import delivery_review_contexts
        current=await ensure(user,portfolio_id)
        needed=set(delivery_review_contexts(current))
        if not set(acknowledge_delivery_context_ids)<=needed:
            raise HTTPException(409,"Delivery review identities changed; review the owned portfolio again")
        row=store.owned(user,portfolio_id)
        row=store.update(user,portfolio_id,{"acknowledged_delivery_context_ids":sorted(set(row.get("acknowledged_delivery_context_ids",[]))|set(acknowledge_delivery_context_ids))},row["version"])
    if row["state"] != "closing":
        row = store.update(
            user,
            portfolio_id,
            {"state": "closing", "entries_paused": True},
            row["version"],
        )
    current = await ensure(user, portfolio_id)
    if row["mode"] == "real":
        from app.services.swing_real import verify_close
        await verify_close(current)
        return store.owned(user, portfolio_id)
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
    if session.instrument_type == "futures":
        from app.services.swing_futures import restore
        restore(session)
        return
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
        if order.status == OrderStatus.PENDING and order.swing_attempts:
            order.swing_reconcile_pending = True
            order.swing_reconcile_reason = (
                "Restored broker-held exit needs its valid DAY window reconciled"
            )
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


_risk_refresh_task = None


def startup():
    """Restore active persistent Paper books independently of attached screens."""
    global _startup_task, _risk_refresh_task
    from app.services.futures_risk import refresh_offhours
    if _risk_refresh_task is None or _risk_refresh_task.done():
        _risk_refresh_task = asyncio.create_task(refresh_offhours())
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
    while True:
        try:
            rows = await asyncio.to_thread(_active_paper_rows)
            break
        except Exception:
            logger.exception("Could not read active Swing portfolios at startup")
            await asyncio.sleep(15)
    pending = rows
    while pending:
        retry = []
        for row in pending:
            try:
                await ensure(row["user_id"], row["session_id"])
            except Exception:
                logger.exception(
                    "Swing portfolio restoration needs reconciliation: %s",
                    row["session_id"],
                )
                retry.append(row)
        pending = retry
        if pending:
            await asyncio.sleep(15)


def update_current_mark(session, event, timestamp):
    price = float(event["close"])
    if not isfinite(price) or price <= 0:
        return
    if session.session_type == "paper" and session.trading_style == "swing":
        key = f"{event.get('expiry')}:{event.get('strike')}:{event.get('right')}"
        marks = getattr(session, "swing_marks", {})
        marks[key] = {"close": price, "time": timestamp,
                      **{field: event[field] for field in ("right", "strike", "expiry", "mark_source") if field in event}}
        session.swing_marks = marks
    if not event.get("right"):
        session.last_price = float(event["close"])
        session.swing_mark_time = timestamp
        session.swing_quote_seen = True
        session.swing_mark_source = event.get("mark_source", "live")
    if event.get("right"):
        key = f"{session.symbol}:{event.get('expiry')}:{event.get('strike')}:{event['right']}"
        registry = getattr(session, "desktop_contract_quotes", {})
        registry[key] = {
            **event,
            "price": float(event["close"]),
            "timestamp": timestamp,
        }
        session.desktop_contract_quotes = registry


async def persist_marks(session, *, force=False):
    """Checkpoint valuation only, once/minute and at shutdown, off the event loop."""
    if session.session_type != "paper" or session.trading_style != "swing" or not getattr(session, "swing_marks", None):
        return
    now = time.monotonic()
    if not force and now - getattr(session, "swing_marks_saved_at", -60) < 60:
        return
    from app.services.real_broker_state import encode
    marks = encode(session.swing_marks)
    def write():
        from app.services.db import get_dynamodb_resource
        get_dynamodb_resource().Table("Sessions").update_item(
            Key={"session_id": session.session_id},
            UpdateExpression="SET swing_marks = :marks",
            ConditionExpression="user_id = :user",
            ExpressionAttributeValues={":marks": marks, ":user": session.user_id})
    try:
        await asyncio.to_thread(write)
        session.swing_marks_saved_at = now
    except Exception:
        session.swing_marks_saved_at = now  # don't retry storage failures every tick
        logger.exception("Paper Swing valuation checkpoint failed session_id=%s", session.session_id)


async def apply_history_valuation(user, portfolio_id, item, quote):
    """Reuse already loaded chart history for valuation only; never execute orders."""
    current = runtime(user, portfolio_id)
    if store.owned(user, portfolio_id)["mode"] != "paper":
        return
    symbol = item.get("underlying", item.get("symbol"))
    changed = False
    for session in current.contexts.values():
        if session.symbol != symbol or item["kind"] not in {"equity": ("equity", "index"), "options": ("option",), "futures": ("future",)}[session.instrument_type]:
            continue
        if session.instrument_type == "futures" and session.expiry != item.get("expiry"):
            continue
        fields = {field: item[field] for field in ("right", "strike", "expiry") if field in item}
        if session.instrument_type == "options":
            if (session.right, session.strike, session.expiry) != (fields.get("right"), fields.get("strike"), fields.get("expiry")):
                continue
            key = f"{symbol}:{fields['expiry']}:{fields['strike']}:{fields['right']}"
            previous = getattr(session, "desktop_contract_quotes", {}).get(key, {}).get("timestamp", 0)
        else:
            previous = getattr(session, "swing_mark_time", 0) or 0
        if previous >= quote["timestamp"]:
            continue
        update_current_mark(session, {"close": quote["price"], "mark_source": "history", **fields}, quote["timestamp"])
        await persist_marks(session)
        changed = True
    if changed:
        current.emit({"type": "portfolio_snapshot", **snapshot(user, portfolio_id)})
