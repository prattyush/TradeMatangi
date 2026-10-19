"""Real Swing recovery and execution over the existing broker/store primitives."""

import asyncio
import time
import uuid

from fastapi import HTTPException

from app.services import order_service, simulation, trading, real_broker_policy as policy
from app.services import real_session_slots as slots
from app.services import swing_portfolio_store as store


async def start(user, req):
    from app.dependencies import require_real_trading_access
    from app.services import execution_broker, real_accounting
    from app.services import swing_funding_store as funding
    from app.services.real_trading_day import market_date
    from app.services.user_settings_service import get_settings

    require_real_trading_access(user)
    await policy.ensure_loaded()
    from app.services import real_sessions

    if policy.enabled() and not real_sessions._ready:
        raise HTTPException(503, "Server ownership recovery is pending; retry shortly")
    broker_name = (
        req.execution_broker
        or (await asyncio.to_thread(get_settings, user, strict=True))[
            "real_execution_broker"
        ]
    )
    broker = execution_broker.get_service(broker_name)
    if not await asyncio.to_thread(broker.is_authenticated):
        raise HTTPException(
            503, "Authenticate the selected broker before starting Real Swing"
        )
    account = await asyncio.to_thread(broker.account_identity)
    if not policy.enabled():
        existing = await asyncio.to_thread(store.active, user, "real", broker_name)
        if existing:
            if existing["state"] in ("stopped", "closing"):
                existing = await asyncio.to_thread(store.update, user, existing["session_id"],
                    {"state":"running", "entries_paused":False, "real_broker_restrictions_enabled":False}, existing["version"])
                from app.services import swing_portfolio_service as service
                previous = service._runtimes.get(existing["session_id"])
                if previous:
                    previous.real_ready = False
                    service.stop_runtime(previous)
                    await asyncio.gather(*(task for task in previous.tasks.values() if task is not asyncio.current_task()), return_exceptions=True)
                    # Keep SSE subscribers attached to this same portfolio runtime.
                    previous.contexts.clear()
                    previous.tasks.clear()
            return existing
    wallet = await real_accounting.refresh(
        user, market_date(), broker, reason="swing_start"
    )
    if not policy.enabled():
        return await asyncio.to_thread(store.create, user, "real", wallet["session_capital"] * req.allocation_pct,
            broker=broker_name, account=account, loss_limit_pct=req.loss_limit_pct, allocation_pct=req.allocation_pct)
    pool = await asyncio.to_thread(
        funding.initialize, user, broker_name, account, wallet["balance"]
    )
    # Validate funding before acquiring a new book. A later race stays recoverable.
    from app.services import swing_accounting as rules

    try:
        if "swing" not in pool["funding"]["modes"]:
            rules.allocate(pool["funding"], "swing", req.allocation_pct)
        else:
            previous = pool["funding"]["modes"]["swing"]
            amount = rules.money(
                pool["funding"]["allocation_reference"] * req.allocation_pct
            )
            reduction = rules.money(
                previous.get("funding_allocation", previous["capital"]) - amount
            )
            if reduction > 0 and reduction > rules.mode_available(
                pool["funding"], "swing"
            ):
                raise ValueError("Requested allocation is below retained commitments")
            rules.correct(
                pool["funding"], "swing", amount, 0, "New session allocation", amount
            )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    row = await asyncio.to_thread(
        store.create,
        user,
        "real",
        pool["funding"]["allocation_reference"] * req.allocation_pct,
        broker=broker_name,
        account=account,
        loss_limit_pct=req.loss_limit_pct,
        allocation_pct=req.allocation_pct,
        funding_period=pool["period_id"],
    )
    await asyncio.to_thread(
        funding.start_participant,
        user,
        broker_name,
        account,
        pool["period_id"],
        "swing",
        row["session_id"],
        req.allocation_pct,
        session_record_id=row["session_id"],
    )
    return row


async def bind(current, row):
    """One renewable parent lease fences every child, with no additional lock manager."""
    if not policy.enabled():
        return await bind_observer(current, row)
    if getattr(current,"observe_only",False):
        for name in ("real-lease","real-engine"):
            task=current.tasks.pop(name,None)
            if task:
                task.cancel()
                await asyncio.gather(task,return_exceptions=True)
        current.observe_only=False
    if current.tasks.get("real-lease") and not current.tasks["real-lease"].done():
        if time.monotonic() >= getattr(current, "real_valid_until", 0):
            raise HTTPException(409, "Swing ownership needs reconnection")
        return
    if not row.get("real_funding_period"):
        from app.services import swing_funding_store as funding

        pool = await asyncio.to_thread(
            funding.read,
            current.user,
            row["execution_broker"],
            row["broker_account_id"],
        )
        if pool and not row.get("allocation_pct") and not row.get("contexts"):
            # Old interrupted starts saved the exact capital before enrollment.
            fraction = row["session_capital"] / pool["funding"]["allocation_reference"]
            if 0 < fraction <= 1:
                row = await asyncio.to_thread(
                    store.update,
                    current.user,
                    row["session_id"],
                    {
                        "allocation_pct": fraction,
                        "prepared_funding_period": pool["period_id"],
                    },
                    row["version"],
                )
        if (
            not pool
            or not row.get("allocation_pct")
            or (
                row.get("prepared_funding_period")
                and row["prepared_funding_period"] != pool["period_id"]
            )
        ):
            raise HTTPException(
                409, "Saved Swing funding is incomplete; reconcile before trading"
            )
        await asyncio.to_thread(
            funding.start_participant,
            current.user,
            row["execution_broker"],
            row["broker_account_id"],
            pool["period_id"],
            "swing",
            row["session_id"],
            row["allocation_pct"],
            session_record_id=row["session_id"],
        )
        row.update(real_funding_period=pool["period_id"])
    token = str(uuid.uuid4())
    await asyncio.to_thread(
        slots.claim,
        current.user,
        row["execution_broker"],
        row["broker_account_id"],
        "swing",
        row["session_id"],
        token,
    )
    from app.services.db import get_dynamodb_resource

    await asyncio.to_thread(
        lambda: (
            get_dynamodb_resource()
            .Table("Sessions")
            .update_item(
                Key={"session_id": row["session_id"]},
                UpdateExpression="SET real_claim_token = :token, real_broker_restrictions_enabled = :yes, #version = :next",
                ConditionExpression="user_id = :owner AND #state <> :ended AND #version = :old",
                ExpressionAttributeNames={"#state": "state", "#version": "version"},
                ExpressionAttributeValues={
                    ":yes": True,
                    ":old": row["version"],
                    ":next": row["version"] + 1,
                    ":token": token,
                    ":owner": current.user,
                    ":ended": "ended",
                },
            )
        )
    )
    current.real_ready = False
    current.real_token = token
    current.real_valid_until = time.monotonic() + 40
    for child in current.contexts.values():
        bind_child(current, child, row)
    from app.services.real_funding import mark_pending

    await asyncio.to_thread(mark_pending, funding_actor(current))
    current.tasks["real-lease"] = asyncio.create_task(heartbeat(current))
    current.tasks["real-engine"] = asyncio.create_task(engine(current))


def bind_child(current, child, row):
    child.real_broker_restrictions_enabled = not getattr(current,"observe_only",False)
    child.real_claim_token = current.real_token
    child.real_engine_lease_required = True
    child.real_engine_valid_until = current.real_valid_until
    child.real_funding_period = row.get("real_funding_period")
    child.execution_broker = row["execution_broker"]
    child.broker_account_id = row["broker_account_id"]
    child.real_recovery_pending = policy.enforce(child)


def funding_actor(current):
    if current.contexts:
        return next(iter(current.contexts.values()))
    from types import SimpleNamespace

    row = store.owned(current.user, current.portfolio_id)
    return SimpleNamespace(
        user_id=current.user,
        session_id=current.portfolio_id,
        portfolio_id=current.portfolio_id,
        trading_style="swing",
        instrument_type="equity",
        execution_broker=row["execution_broker"],
        broker_account_id=row["broker_account_id"],
        real_broker_restrictions_enabled=not getattr(current,"observe_only",False),
        real_funding_period=row.get("real_funding_period"),
        real_claim_token=current.real_token,
        real_engine_lease_required=True,
        real_engine_valid_until=current.real_valid_until,
    )


async def reconcile_empty(current):
    from app.services import execution_broker, real_accounting, real_funding
    from app.services.real_trading_day import market_date

    actor = funding_actor(current)
    wallet = await real_accounting.refresh(
        current.user,
        market_date(),
        execution_broker.get_service(actor),
        reason="empty_swing_reconcile",
    )
    return await asyncio.to_thread(
        real_funding.reconcile, actor, wallet["balance"], coherent=True
    )


async def heartbeat(current):
    """Renew independently of slow multi-symbol report reads and staging."""
    while True:
        try:
            row = await asyncio.to_thread(
                store.owned, current.user, current.portfolio_id
            )
            if row["state"] in ("ended", "stopped"):
                return
            if not policy.enabled():
                from app.services.real_session_observer import record
                await asyncio.to_thread(record, current.user, current.portfolio_id, row["execution_broker"], row["broker_account_id"],
                    "swing", current.real_token, date=row["date"])
                await asyncio.sleep(180)
                continue
            await asyncio.to_thread(
                slots.update,
                row["execution_broker"],
                row["broker_account_id"],
                "swing",
                current.user,
                current.portfolio_id,
                current.real_token,
                state="closing" if row["state"] == "closing" else "running",
            )
            current.real_valid_until = time.monotonic() + 40
            for child in current.contexts.values():
                child.real_engine_valid_until = current.real_valid_until
        except Exception as exc:  # noqa: BLE001 - retain the book, stop an expired engine
            if policy.enabled() and time.monotonic() >= current.real_valid_until:
                for child in current.contexts.values():
                    child.real_recovery_pending = True
                    child.real_engine_valid_until = 0
                current.emit(
                    {
                        "type": "portfolio_recovery_required",
                        "message": f"Ownership recovery required: {exc}",
                    }
                )
                task = current.tasks.get("real-engine")
                if task:
                    task.cancel()
                return
        await asyncio.sleep(10 if policy.enabled() else 180)


async def engine(current):
    from app.services import swing_portfolio_service as service

    try:
        while True:
            row = await asyncio.to_thread(
                store.owned, current.user, current.portfolio_id
            )
            if row["state"] in ("ended", "stopped"):
                return
            if not current.real_ready or row["contexts"] != {
                key: child.session_id for key, child in current.contexts.items()
            }:
                await asyncio.sleep(1)
                continue
            try:
                for child in list(current.contexts.values()):
                    child.real_engine_valid_until = current.real_valid_until
                    try:
                        await refresh(child)
                    except Exception as exc:  # noqa: BLE001 - persistent recovery must survive broker outages
                        child.real_recovery_pending = True
                        child.real_history_warning = str(exc)
                        current.emit(
                            {"type": "portfolio_recovery_required", "message": str(exc)}
                        )
                if not current.contexts:
                    await reconcile_empty(current)
                if policy.enabled() and row["state"] == "closing":
                    await close_positions(current)
                    await verify_close(current)
                current.emit(
                    {
                        "type": "portfolio_snapshot",
                        **service.snapshot(current.user, current.portfolio_id),
                    }
                )
            except Exception as exc:  # noqa: BLE001 - persistent recovery must survive broker outages
                if policy.enabled() and time.monotonic() >= current.real_valid_until:
                    for child in current.contexts.values():
                        child.real_recovery_pending = True
                    current.emit(
                        {
                            "type": "portfolio_recovery_required",
                            "message": f"Ownership recovery required: {exc}",
                        }
                    )
                    return
            await asyncio.sleep(10)
    finally:
        for child in current.contexts.values():
            child.real_engine_valid_until = 0
        task = current.tasks.get("real-lease")
        if task and task is not asyncio.current_task():
            task.cancel()


async def refresh(session, *, protection=False):
    """Publish only a complete, quantity-verified journal revision."""
    from app.services import (
        execution_broker,
        fifo_positions,
        kotak_reports,
        real_accounting,
        real_funding,
    )
    from app.services import real_broker_state as state
    from app.services.real_trading_day import market_date
    from app.services.swing_real_journal import holding_positions, merge_executions

    if session.date != market_date():
        session.date = market_date()
        await asyncio.to_thread(simulation._upsert_session_to_db, session, strict=True)
    broker = execution_broker.get_service(session)
    account = await asyncio.to_thread(broker.account_identity)
    root = state.projection_id(session, account)
    from app.services.protection_recovery import session_lock

    async with session_lock(session), state._locks.setdefault(root, asyncio.Lock()):
        if getattr(session, "broker_refresh_events", None) is not None:
            raise HTTPException(409, "Broker refresh is already running")
        session.broker_refresh_events = []
        try:
            bundle = await kotak_reports.fetch(broker, background=protection)
            scoped_orders, today_fills = state.book_reports(
                session, bundle.orders, bundle.executions
            )
            previous = getattr(session, "_fifo_executions", None) or []
            ledger = merge_executions(previous, today_fills)
            master = None
            try:
                ledger = fifo_positions.unique_executions(session, ledger)
                reported = state.normalize_positions(session, bundle.positions)
                orders = state.build_orders(session, scoped_orders)
            except state.reports.UnknownContractError:
                from app.services.kotak_service import _get_kotak_instruments

                master = await asyncio.to_thread(_get_kotak_instruments)
                ledger = fifo_positions.unique_executions(session, ledger, master)
                reported = state.normalize_positions(session, bundle.positions, master)
                orders = state.build_orders(session, scoped_orders, master)
            if session.instrument_type == "equity":
                reported = holding_positions(
                    session, await asyncio.to_thread(broker.get_holdings), reported
                )
            # Reports may straddle a fill. Pending is safer than replacing known history.
            quantities = {}
            for fill in today_fills:
                key = (fill.get("exchange", ""), fill["broker_order_id"])
                quantities[key] = quantities.get(key, 0) + fill["quantity"]
            if any(
                row["filled_quantity"]
                != quantities.get((row["exchange"], row["broker_order_id"]), 0)
                for row in scoped_orders
            ):
                raise ValueError(
                    "Broker execution reports are incomplete or updating; reconcile again"
                )
            positions = fifo_positions.verified_positions(
                session, ledger, reported, master
            )
            if session.instrument_type != "futures" and any(p["side"] == "SHORT" for p in positions):
                raise ValueError(
                    "Swing supports long positions; reconcile this short at the broker"
                )
            # Prior DAY orders stay archived. Their unknown state remains a barrier,
            # rather than assuming that absence from today's report means cancelled.
            current_ids = {row["broker_order_id"] for row in scoped_orders}
            for old in order_service.get_all_orders(session.session_id):
                if old.broker_order_id and old.broker_order_id not in current_ids:
                    preserved = old.model_copy(deep=True)
                    if preserved.status.value == "PENDING":
                        preserved.swing_reconcile_pending = True
                        preserved.swing_reconcile_reason = "Previous DAY attempt is absent from current broker reports; verify before replacement"
                    orders[old.order_id] = preserved
            if session.instrument_type == "futures":
                from app.services.futures_real import confirmed_trades
                trades = confirmed_trades(session,ledger,orders)
            else:
                trades = state.aggregate(session, ledger, account, master)
            for report in scoped_orders:
                expired = report["status"] == "expired" or (
                    "expir" in report.get("reject_reason", "").lower()
                    and report["status"] in ("cancelled", "canceled")
                )
                order = next(
                    (
                        o
                        for o in orders.values()
                        if o.broker_order_id == report["broker_order_id"]
                    ),
                    None,
                )
                if (
                    expired
                    and order
                    and (order.side.value == "SELL" or session.instrument_type == "futures" and order.execution_role == "exit")
                    and not order.cancel_request_id
                ) and (
                    not order.swing_attempts
                    or order.swing_attempts[-1].get("state") != "expired"
                ):
                    order.swing_attempts.append(
                        {
                            "state": "expired",
                            "date": session.date,
                            "broker_order_id": order.broker_order_id,
                            "filled_quantity": order.broker_filled_quantity,
                        }
                    )

            state.rebuild_reservations(session, orders, positions)
            manifest, _members = await asyncio.to_thread(
                state.stage,
                session,
                account,
                trades,
                scoped_orders,
                positions,
                ledger,
                orders,
            )
            await asyncio.to_thread(commit, session, manifest)
            trading._trades[session.session_id] = trades
            order_service._orders[session.session_id] = orders
            session.kotak_order_map = {
                o.order_id: o.broker_order_id
                for o in orders.values()
                if o.broker_order_id
            }
            session._fifo_executions = ledger
            session.broker_positions = positions
            if session.instrument_type == "futures":
                from app.services.futures_real import rebuild
                await asyncio.to_thread(rebuild,session)
            session._broker_state_version = (
                getattr(session, "_broker_state_version", 0) + 1
            )
            coherent = not any(
                o.recovery_state in ("submitting", "unknown")
                or o.swing_reconcile_pending
                for o in orders.values()
            )
            session.real_recovery_pending = not coherent
            if coherent:
                session.real_history_warning = None
            wallet = await real_accounting.refresh(
                session.user_id,
                session.date,
                broker,
                reason="swing_reconcile",
                executions=bundle.executions,
                positions=bundle.positions,
            )
            await asyncio.to_thread(
                real_funding.reconcile, session, wallet["balance"], coherent=coherent
            )
            for order in order_service.get_open_orders(session.session_id):
                if order.broker_order_id and not order.swing_reconcile_pending:
                    simulation._register_kotak_sl_for_order(
                        session, order, asyncio.get_running_loop(), attach_only=True
                    )
            return {
                "reconciled": coherent,
                "positions": positions,
                "history_warning": session.real_history_warning,
            }
        except Exception:
            session.real_recovery_pending = True
            if session.real_funding_period:
                await asyncio.to_thread(real_funding.mark_pending, session)
            raise
        finally:
            events, session.broker_refresh_events = session.broker_refresh_events, None
            for callback, args in events or []:
                callback(*args)


def commit(session, manifest):
    from app.services import real_broker_state as state
    from app.services.db import get_dynamodb_client

    actions = [
            {
                "ConditionCheck": {
                    "TableName": "WalletLedgers",
                    "Key": slots.serialize(
                        slots.key(
                            session.execution_broker, session.broker_account_id, "swing"
                        )
                    ),
                    "ConditionExpression": "owner_user_id = :owner AND session_id = :pid AND operation_id = :token AND engine_until >= :now AND #state <> :closed",
                    "ExpressionAttributeNames": {"#state": "state"},
                    "ExpressionAttributeValues": slots.serialize(
                        {
                            ":owner": session.user_id,
                            ":pid": session.portfolio_id,
                            ":token": session.real_claim_token,
                            ":now": int(time.time()),
                            ":closed": "closed",
                        }
                    ),
                }
            },
            {
                "Update": {
                    "TableName": "Sessions",
                    "Key": slots.serialize({"session_id": session.session_id}),
                    "UpdateExpression": "SET broker_projection_id = :root",
                    "ExpressionAttributeValues": slots.serialize(
                        {":root": manifest["session_id"]}
                    ),
                }
            },
            {"Put": {"TableName": "Sessions", "Item": slots.serialize(manifest)}},
        ]
    get_dynamodb_client().transact_write_items(TransactItems=actions if policy.enforce(session) else actions[1:])
    state._links[session.session_id] = {
        "projection_id": manifest["session_id"],
        **manifest,
    }
    session.broker_projection_id = manifest["session_id"]


async def verify_close(current):
    from app.services import (
        real_recovery,
    )
    from app.services import swing_portfolio_service as service

    row = store.owned(current.user, current.portfolio_id)
    if not current.real_ready or row["contexts"] != {
        key: child.session_id for key, child in current.contexts.items()
    }:
        return False
    requirements = real_recovery.closure_requirements(
        list(current.contexts.values()),
        row.get("acknowledged_undated_submission_ids", []),
    )
    if requirements["closure_blocked"]:
        return False
    from app.services.futures_real import delivery_review_contexts
    delivery=delivery_review_contexts(current)
    if not set(delivery)<=set(row.get("acknowledged_delivery_context_ids",[])):
        return False  # Flat derivative reports alone do not prove stock delivery/payment obligations.
    results = [
        await real_recovery.verify(child) for child in list(current.contexts.values())
    ]
    if not all(result["verified_flat"] for result in results):
        return False
    row = await asyncio.to_thread(store.owned, current.user, current.portfolio_id)
    if real_recovery.closure_requirements(
        list(current.contexts.values()),
        row.get("acknowledged_undated_submission_ids", []),
    )["closure_blocked"]:
        return False
    warning = (
        "Current broker scope is flat; undated submission history was explicitly acknowledged and remains unverified."
        if row.get("acknowledged_undated_submission_ids")
        else None
    )
    if delivery:
        warning="Broker derivative exposure is verified flat. Stock Futures delivery/settlement was reviewed by the owner; historical cash, delivery and P&L evidence may remain incomplete."
    for child in current.contexts.values():
        if child.real_recovery_pending and not delivery:
            warning = "Current broker exposure is flat; historical execution/P&L gaps remain unresolved."
        # Current broker evidence proves no order remains active, including an old
        # DAY attempt. Clear reservations only after that proof, not on lease expiry.
        for order in order_service.get_open_orders(child.session_id):
            order_service.cancel_order(child.session_id, order.order_id, child.date)
    if warning:
        row = await asyncio.to_thread(
            store.update,
            current.user,
            current.portfolio_id,
            {"history_warning": warning},
            row["version"],
        )
    await asyncio.to_thread(
        store.finish_verified_close, current.user, current.portfolio_id
    )
    for child in current.contexts.values():
        child.real_verified_closed = True
        child.broker_positions = []
    service.stop_runtime(current)
    from app.services.broker_order_service import refresh_account_peers

    refresh_account_peers(funding_actor(current))
    return True


async def close_positions(current):
    from app.models.schemas import TradeSide
    from app.routers.orders import cancel_order
    from app.services import emergency_exit

    for child in list(current.contexts.values()):
        if child.real_recovery_pending:
            continue
        for order in list(order_service.get_open_orders(child.session_id)):
            position = trading.get_position(
                child.session_id, child.symbol, order.right, order.strike, order.expiry
            )
            if (
                order.side == TradeSide.SELL
                and order.quantity - order.broker_filled_quantity <= position.quantity
            ):
                continue
            await cancel_order(order.order_id, child.session_id)
        if any(p["quantity"] for p in getattr(child, "broker_positions", [])):
            await emergency_exit.exit_all(child)


def ownership_check(child):
    return {
        "ConditionCheck": {
            "TableName": "WalletLedgers",
            "Key": slots.serialize(
                slots.key(child.execution_broker, child.broker_account_id, "swing")
            ),
            "ConditionExpression": "owner_user_id = :owner AND session_id = :pid AND operation_id = :token AND engine_until >= :now AND #state = :running",
            "ExpressionAttributeNames": {"#state": "state"},
            "ExpressionAttributeValues": slots.serialize(
                {
                    ":owner": child.user_id,
                    ":pid": child.portfolio_id,
                    ":token": child.real_claim_token,
                    ":now": int(time.time()),
                    ":running": "running",
                }
            ),
        }
    }


def inventory_fingerprint(positions):
    import hashlib
    import json

    from app.services.swing_funding_store import decode

    return hashlib.sha256(
        json.dumps(decode(positions), sort_keys=True).encode()
    ).hexdigest()


async def inventory_preview(child):
    if child.instrument_type == "futures":
        raise HTTPException(409, "Existing external Futures require broker reconciliation; opening-inventory import is not supported")
    from app.services.real_recovery import verify

    verification = await verify(child)
    if verification["pending_orders"] or order_service.get_open_orders(
        child.session_id
    ):
        raise HTTPException(
            409, "Cancel broker orders before importing opening inventory"
        )
    if getattr(child, "_fifo_executions", None) or trading.get_trades(child.session_id):
        raise HTTPException(
            409, "Import opening inventory before this context has executions"
        )
    positions = verification["positions"]
    if child.instrument_type == "equity":
        from app.services import execution_broker, kotak_reports
        from app.services.swing_real_journal import import_basis

        bundle = await kotak_reports.fetch(
            execution_broker.get_service(child), force=True
        )
        positions = import_basis(child, positions, bundle)
    if not positions or any(
        p["side"] != "LONG" or p["avg_entry_price"] <= 0 for p in positions
    ):
        raise HTTPException(
            409, "Broker must confirm long inventory with a positive acquisition basis"
        )
    if child.opening_positions:
        raise HTTPException(
            409,
            "This context already has opening inventory; reconcile its history instead",
        )
    cost = round(sum(p["quantity"] * p["avg_entry_price"] for p in positions), 2)
    return {
        "positions": positions,
        "cost": cost,
        "fingerprint": inventory_fingerprint(positions),
        "message": "Import the entire delivery/overnight inventory for this context at broker basis. No historical fills or broker cash debit will be created.",
    }


async def import_inventory(child, fingerprint, request_id):
    from app.routers.orders import _session_edit_lock
    from app.services import real_broker_state as state
    from app.services import swing_accounting as rules
    from app.services import swing_funding_store as funding

    async with (
        _session_edit_lock(child),
        state._locks.setdefault(
            state.projection_id(child, child.broker_account_id), asyncio.Lock()
        ),
    ):
        if child.opening_inventory_request_id == request_id:
            if child.opening_inventory_fingerprint != fingerprint:
                raise HTTPException(
                    409, "Import identity was reused with different inventory"
                )
            return
        preview = await inventory_preview(child)
        if preview["fingerprint"] != fingerprint:
            raise HTTPException(
                409, "Broker inventory changed; review a fresh import preview"
            )
        parent = await asyncio.to_thread(store.owned, child.user_id, child.portfolio_id)
        pool = await asyncio.to_thread(
            funding.owned_participant,
            child.user_id,
            child.execution_broker,
            child.broker_account_id,
            "swing",
            child.portfolio_id,
        )
        cost = preview["cost"]
        captured_at = int(time.time() * 1000)

        def mutate(row):
            row["funding"] = rules.adopt_opening_inventory(
                row["funding"], "swing", cost
            )
            mode = row["funding"]["modes"]["swing"]
            mode["capital"] = rules.money(mode["capital"] + cost)
            mode["funding_allocation"] = rules.money(
                mode.get("funding_allocation", mode["capital"] - cost) + cost
            )
            mode["expected_balance"] = rules.money(mode["expected_balance"] + cost)
            row["funding"]["unallocated_balance"] = rules.money(
                row["funding"]["unallocated_balance"] - cost
            )
            row["funding"]["corrections"].append(
                {
                    "mode": "swing",
                    "kind": "opening_inventory",
                    "cost": cost,
                    "reason": "Broker-confirmed opening inventory import",
                }
            )
            row["participants"]["swing"]["baseline_balance"] += cost
            row["participants"]["swing"]["reconciliation_pending"] = True
            row["participants"]["swing"].pop("snapshot_fingerprint", None)
            row["funding_status"] = rules.status(
                row["funding"],
                (row.get("funding_status") or {}).get("available", 0),
                coherent=False,
            )

        def metadata(row):
            return [
                *([ownership_check(child)] if policy.enforce(child) else []),
                {
                    "Update": {
                        "TableName": "Sessions",
                        "Key": slots.serialize({"session_id": child.session_id}),
                        "UpdateExpression": "SET opening_positions = :positions, opening_inventory_cost = :cost, opening_inventory_request_id = :request, opening_inventory_fingerprint = :fingerprint, opening_inventory_captured_at = :captured, opening_inventory_capital = :capital",
                        "ConditionExpression": "user_id = :owner AND opening_inventory_cost = :zero",
                        "ExpressionAttributeValues": slots.serialize(
                            {
                                ":positions": preview["positions"],
                                ":cost": cost,
                                ":request": request_id,
                                ":fingerprint": fingerprint,
                                ":captured": captured_at,
                            ":capital":child.session_capital,
                                ":owner": child.user_id,
                                ":zero": 0,
                            }
                        ),
                    }
                },
                {
                    "Update": {
                        "TableName": "Sessions",
                        "Key": slots.serialize({"session_id": child.portfolio_id}),
                        "UpdateExpression": "SET session_capital = :capital, #version = :next",
                        "ConditionExpression": "user_id = :owner AND #version = :old AND #state = :running",
                        "ExpressionAttributeNames": {
                            "#version": "version",
                            "#state": "state",
                        },
                        "ExpressionAttributeValues": slots.serialize(
                            {
                                ":capital": row["funding"]["modes"]["swing"]["capital"],
                                ":owner": child.user_id,
                                ":old": parent["version"],
                                ":next": parent["version"] + 1,
                                ":running": "running",
                            }
                        ),
                    }
                },
            ]

        await asyncio.to_thread(
            funding.apply,
            child.user_id,
            child.execution_broker,
            child.broker_account_id,
            pool["period_id"],
            "opening:" + child.session_id + ":" + request_id,
            "opening_inventory",
            {"fingerprint": fingerprint, "cost": cost},
            mutate,
            extra_actions=metadata,
        )
        child.opening_positions, child.opening_inventory_cost = (
            preview["positions"],
            cost,
        )
        child.opening_inventory_request_id = request_id
        child.opening_inventory_fingerprint = fingerprint
        child.opening_inventory_captured_at = captured_at
        child.opening_inventory_capital=child.session_capital
    await refresh(child)


def parent_metadata(child, parent, changes):
    values = {
        ":owner": child.user_id,
        ":old": parent["version"],
        ":next": parent["version"] + 1,
        ":running": "running",
    }
    names = {"#version": "version", "#state": "state"}
    setters = ["#version = :next"]
    for index, (key, value) in enumerate(changes.items()):
        names[f"#f{index}"] = key
        values[f":v{index}"] = value
        setters.append(f"#f{index} = :v{index}")
    return [
        *([ownership_check(child)] if policy.enforce(child) else []),
        {
            "Update": {
                "TableName": "Sessions",
                "Key": slots.serialize({"session_id": child.portfolio_id}),
                "UpdateExpression": "SET " + ", ".join(setters),
                "ConditionExpression": "user_id = :owner AND #version = :old AND #state = :running",
                "ExpressionAttributeNames": names,
                "ExpressionAttributeValues": slots.serialize(values),
            }
        },
    ]


async def reset_capital(current, capital, request_id):
    from app.services import swing_accounting as rules
    from app.services import swing_funding_store as funding
    from app.services.swing_portfolio_service import snapshot

    child = funding_actor(current)
    parent = store.owned(current.user, current.portfolio_id)
    view = snapshot(current.user, current.portfolio_id)
    pool = funding.owned_participant(
        current.user,
        child.execution_broker,
        child.broker_account_id,
        "swing",
        current.portfolio_id,
    )
    mode = pool["funding"]["modes"]["swing"]
    if view["pnl"] is None:
        raise HTTPException(
            409, "Reconcile executions and wait for prices before resetting capital"
        )
    if capital > mode.get("funding_allocation", mode["capital"]) + view["pnl"] + 0.01:
        raise HTTPException(
            422,
            "Capital exceeds this portfolio equity; adjust funding allocation explicitly",
        )

    def mutate(row):
        row["funding"] = rules.reset_reference(
            row["funding"], "swing", capital, capital
        )

    changes = {
        "session_capital": capital,
        "guardrail_start_pnl": view["pnl"],
        "guardrail_epoch": parent["guardrail_epoch"] + 1,
        "guardrail_ban": False,
    }
    await asyncio.to_thread(
        funding.apply,
        current.user,
        child.execution_broker,
        child.broker_account_id,
        pool["period_id"],
        request_id,
        "capital_reset",
        {"capital": capital},
        mutate,
        extra_actions=lambda _: parent_metadata(child, parent, changes),
    )
    for session in current.contexts.values():
        session.session_capital = capital


async def allocation(current, fraction, request_id):
    from app.services import swing_funding_store as funding

    child = funding_actor(current)
    parent = store.owned(current.user, current.portfolio_id)
    row = await asyncio.to_thread(
        funding.change_allocation,
        current.user,
        child.execution_broker,
        child.broker_account_id,
        "swing",
        current.portfolio_id,
        fraction,
        request_id,
        extra_actions=lambda row: parent_metadata(
            child,
            parent,
            {"session_capital": row["funding"]["modes"]["swing"]["capital"]},
        ),
    )
    for session in current.contexts.values():
        session.session_capital = row["funding"]["modes"]["swing"]["capital"]


async def correction_preview(current, adjustment, reason):
    from app.services import swing_accounting as rules
    from app.services import swing_funding_store as funding
    from app.services.swing_portfolio_service import snapshot

    child = funding_actor(current)
    if current.contexts:
        await refresh(child)
    else:
        await reconcile_empty(current)
    pool = funding.owned_participant(
        current.user,
        child.execution_broker,
        child.broker_account_id,
        "swing",
        current.portfolio_id,
    )
    status = pool.get("funding_status") or {}
    gap = status.get("shortfall")
    if gap is None or not 0 < -adjustment <= gap + 0.01:
        raise HTTPException(
            422, "Correction must cover part or all of a confirmed wallet shortfall"
        )
    if -adjustment > rules.mode_available(pool["funding"], "swing"):
        raise HTTPException(
            422, "Correction exceeds free Swing funding; manage commitments first"
        )
    parent = store.owned(current.user, current.portfolio_id)
    capital = round(parent["session_capital"] + adjustment, 2)
    view = snapshot(current.user, current.portfolio_id)
    if view["pnl"] is None:
        raise HTTPException(
            409,
            "Historical P&L is unresolved; do not erase its warning with a cash correction",
        )
    changed = rules.correct(
        pool["funding"], "swing", capital, adjustment, reason, capital
    )
    return {
        "capital": capital,
        "adjustment": adjustment,
        "shortfall": gap,
        "remaining_shortfall": rules.status(changed, status["available"])["shortfall"],
        "funding_version": pool["version"],
        "pnl": view["pnl"],
        "pool": pool,
        "parent": parent,
    }


async def correct_shortfall(current, adjustment, reason, request_id, version):
    # Recognize a confirmed retry before re-previewing a now-smaller gap.
    import hashlib
    import json

    from app.services import swing_accounting as rules
    from app.services import swing_funding_store as funding

    child = funding_actor(current)
    pool = funding.owned_participant(
        current.user,
        child.execution_broker,
        child.broker_account_id,
        "swing",
        current.portfolio_id,
    )
    receipt = (
        funding._table()
        .get_item(
            Key={
                "user_id": funding.partition(
                    child.execution_broker, child.broker_account_id
                ),
                "ledger_id": f"funding-op:{pool['period_id']}:{hashlib.sha256(request_id.encode()).hexdigest()}",
            },
            ConsistentRead=True,
        )
        .get("Item")
    )
    if receipt:
        payload = {
            "kind": "acknowledged_cash_shortfall",
            "payload": {"adjustment": adjustment, "reason": reason, "version": version},
            "actor_user_id": current.user,
        }
        fingerprint = hashlib.sha256(
            json.dumps(payload, sort_keys=True, allow_nan=False).encode()
        ).hexdigest()
        if receipt.get("fingerprint") != fingerprint:
            raise HTTPException(
                409, "Correction identity was reused with different instructions"
            )
        return
    preview = await correction_preview(current, adjustment, reason)
    if preview["funding_version"] != version:
        raise HTTPException(409, "Funding changed; review the correction preview again")
    child = funding_actor(current)
    pool, parent = preview["pool"], preview["parent"]

    def mutate(row):
        if row["version"] != version:
            raise HTTPException(
                409, "Funding changed; review the correction preview again"
            )
        row["funding"] = rules.correct(
            row["funding"],
            "swing",
            preview["capital"],
            adjustment,
            reason,
            preview["capital"],
        )
        row["participants"]["swing"]["baseline_balance"] += adjustment
        row["participants"]["swing"].pop("snapshot_fingerprint", None)
        row["funding_status"] = rules.status(
            row["funding"], pool["funding_status"]["available"]
        )

    changes = {
        "session_capital": preview["capital"],
        "guardrail_start_pnl": preview["pnl"],
        "guardrail_epoch": parent["guardrail_epoch"] + 1,
        "guardrail_ban": False,
    }
    await asyncio.to_thread(
        funding.apply,
        current.user,
        child.execution_broker,
        child.broker_account_id,
        pool["period_id"],
        request_id,
        "acknowledged_cash_shortfall",
        {"adjustment": adjustment, "reason": reason, "version": version},
        mutate,
        extra_actions=lambda _: parent_metadata(child, parent, changes),
    )

    for session in current.contexts.values():
        session.session_capital = preview["capital"]


async def renew_protection_on_quote(session, event):
    """Renew only an explicitly expired, verified DAY exit on a fresh online quote."""
    from app.models.schemas import OrderStatus, OrderType, TradeSide
    from app.services.swing_paper_recovery import day_window

    if (
        getattr(session, "broker_refresh_events", None) is not None
        or session.real_recovery_pending
        or not day_window(int(event["time"]))
    ):
        return
    if store.owned(session.user_id, session.portfolio_id)["state"] != "running":
        return
    exact = (event.get("right"), event.get("strike"), event.get("expiry"))
    for old in list(order_service.get_all_orders(session.session_id)):
        if (
            old.status != OrderStatus.CANCELLED
            or (old.execution_role != "exit" if session.instrument_type == "futures" else old.side != TradeSide.SELL)
            or not old.broker_order_id
        ):
            continue
        if (old.right, old.strike, old.expiry) != exact or not old.swing_attempts:
            continue
        latest = old.swing_attempts[-1]
        if (
            latest.get("state") != "expired"
            or latest.get("date", session.date) >= session.date
        ):
            continue
        if old.expiry and (old.expiry < session.date if session.instrument_type == "futures" else old.expiry <= session.date):
            continue  # Expiry/settlement must be reconciled; never renew an expired contract.
        held = trading.get_position(
            session.session_id, session.symbol, old.right, old.strike, old.expiry
        )
        if session.instrument_type == "futures":
            from app.services.futures_real import exit_belongs_to_position
            closing_side = TradeSide.SELL if held.side == "LONG" else TradeSide.BUY if held.side == "SHORT" else None
            if old.side != closing_side or not exit_belongs_to_position(session, old):
                continue
        covered = sum(
            max(0, o.quantity - o.broker_filled_quantity)
            for o in order_service.get_open_orders(session.session_id)
            if o.side == old.side and (o.right, o.strike, o.expiry) == exact
        )
        remaining = min(
            max(0, old.quantity - old.broker_filled_quantity),
            max(0, held.quantity - covered),
        )
        if not remaining:
            continue
        identifier = str(
            uuid.uuid5(uuid.NAMESPACE_URL, old.order_id + ":renew:" + session.date)
        )
        if order_service.get_order(session.session_id, identifier):
            continue  # Includes unknown ACK and known rejection; no blind retry.
        if session.instrument_type == "futures":
            from app.services.futures_real import renew_exit
            await renew_exit(session,old,remaining,identifier,event)
            continue
        renewal = order_service.place_order(
            session.session_id,
            session.symbol,
            TradeSide.SELL,
            old.order_type,
            remaining,
            int(event["time"]),
            session.date,
            trigger_price=old.trigger_price
            if old.order_type == OrderType.STOPLOSS
            else None,
            limit_price=old.limit_price,
            right=old.right,
            strike=old.strike,
            expiry=old.expiry,
            user_id=session.user_id,
            source="swing_real_renewal",
            order_id=identifier,
            margin_rate=1,
            wallet_ledger_id=session.wallet_ledger_id,
            wallet_ledger_kind="real",
        )
        old.swing_attempts.append(
            {
                "state": "renewed",
                "date": session.date,
                "order_id": identifier,
                "quantity": remaining,
            }
        )
        order_service._write_order_to_db(old, strict=True)
        simulation._register_kotak_sl_for_order(
            session, renewal, asyncio.get_running_loop()
        )


async def bind_observer(current, row):
    """Restore this portfolio without consulting other books or reconciliation gates."""
    if getattr(current,"observe_only",False) and current.tasks.get("real-lease") and not current.tasks["real-lease"].done():
        return
    from app.services.real_session_observer import record
    previous=current.tasks.get("real-lease")
    if previous:
        previous.cancel()
        await asyncio.gather(previous,return_exceptions=True)
    current.observe_only=True
    current.real_token=str(uuid.uuid4())
    current.real_valid_until=time.monotonic()+890
    current.real_ready=True
    row=await asyncio.to_thread(store.update,current.user,row["session_id"],{"real_broker_restrictions_enabled":False},row["version"])
    for child in current.contexts.values():
        bind_child(current,child,row)
        child.real_recovery_pending=False
    async def heartbeat():
        while True:
            try:
                saved=await asyncio.to_thread(store.owned,current.user,current.portfolio_id)
            except Exception:
                await asyncio.sleep(180)
                continue
            if saved["state"] in ("ended", "stopped"): return
            await asyncio.to_thread(record,current.user,current.portfolio_id,row["execution_broker"],row["broker_account_id"],
                "swing",current.real_token,state=saved["state"],date=row["date"])
            current.real_valid_until=time.monotonic()+890
            for child in current.contexts.values(): child.real_engine_valid_until=current.real_valid_until
            await asyncio.sleep(180)
    current.tasks["real-lease"]=asyncio.create_task(heartbeat())
    if not current.tasks.get("real-engine") or current.tasks["real-engine"].done():
        current.tasks["real-engine"]=asyncio.create_task(engine(current))
