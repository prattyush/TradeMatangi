"""Shared broker-first edits for website, desktop and real exit strategies."""
import asyncio
import logging
from app.models.schemas import Order, OrderType, TradeSide
from app.services import order_service

logger = logging.getLogger(__name__)


async def sync_order_edit_async(session, order: Order, new_order_type: OrderType, *, reprice: bool = False) -> None:
    """Run broker I/O off-loop; keep identity and callback changes on the loop."""
    if session.session_type != "real":
        return
    from app.services.kotak_service import get_service, KotakError
    from app.services.execution_price_service import reprice_trigger
    from app.services.simulation import _is_position_exit
    if getattr(session, "broker_refresh_events", None) is not None:
        raise KotakError("Broker refresh is in progress; retry the edit shortly")
    previous = order_service.get_order(session.session_id, order.order_id)
    if reprice or previous is None or previous.order_type != order.order_type or previous.trigger_price != order.trigger_price:
        await asyncio.to_thread(reprice_trigger, order)
    broker = get_service()
    loop = asyncio.get_running_loop()
    old_id = order.kotak_order_id
    try:
        replacement = None
        if old_id:
            if new_order_type == OrderType.LIMIT:
                replacement = await asyncio.to_thread(broker.modify_sl_to_limit_order, old_id, order.limit_price, order.quantity)
            elif new_order_type == OrderType.STOPLOSS:
                replacement = await asyncio.to_thread(broker.modify_sl_order, old_id, order.trigger_price, order.limit_price, order.quantity)
            else:
                await asyncio.to_thread(broker.cancel_order, old_id, purpose="conversion")
                broker.deregister_fill_callback(old_id)
                broker.deregister_reject_callback(old_id)
                broker.deregister_cancel_callback(old_id)
                session.kotak_order_map.pop(order.order_id, None)
                order.kotak_order_id = None
            if isinstance(replacement, str) and replacement and replacement != old_id:
                broker.deregister_fill_callback(old_id)
                broker.deregister_reject_callback(old_id)
                broker.deregister_cancel_callback(old_id)
                order.kotak_order_id = replacement
                session.kotak_order_map[order.order_id] = replacement
        elif new_order_type in (OrderType.LIMIT, OrderType.STOPLOSS) and _is_position_exit(session, order):
            kwargs = dict(symbol=session.symbol, side="B" if order.side == TradeSide.BUY else "S", qty=order.quantity)
            if order.right:
                kwargs.update(right=order.right, strike=order.strike if order.strike is not None else session.strike, expiry=order.expiry or session.expiry)
            if new_order_type == OrderType.LIMIT:
                method = broker.place_options_limit_order if order.right else broker.place_limit_order
                kwargs["price"] = order.limit_price
            else:
                method = broker.place_options_sl_order if order.right else broker.place_sl_order
                kwargs.update(trigger_price=order.trigger_price, limit_price=order.limit_price)
            order.kotak_order_id = await asyncio.to_thread(method, **kwargs)
            order.execution_role = "exit"
            session.kotak_order_map[order.order_id] = order.kotak_order_id
        # Publish the broker identity before registering callbacks: a callback may
        # already be waiting when a replacement/new order is acknowledged.
        if previous is not None:
            previous.kotak_order_id = order.kotak_order_id
            previous.execution_role = order.execution_role
        if order.kotak_order_id and order.kotak_order_id != old_id:
            register_callbacks(session, order, broker, loop)
    except Exception as exc:
        logger.warning("broker_order_edit_failed session=%s order=%s: %s", session.session_id, order.order_id, exc)
        raise KotakError(f"Broker rejected order edit: {exc}") from exc


async def persist_order_async(order, *, strict=False):
    """Persist copies off-loop and reconcile fills received during the write."""
    while True:
        snapshot = order.model_copy(deep=True)
        if strict:
            await asyncio.to_thread(order_service._write_order_to_db, snapshot, strict=True)
        else:
            await asyncio.to_thread(order_service._write_order_to_db, snapshot)
        current = order_service.get_order(order.session_id, order.order_id)
        if current is None or current.model_dump() == snapshot.model_dump():
            return
        order = current


async def convert_order_async(session, order, new_type, price=None):
    if session.session_type == "real" and order.kotak_order_id and new_type in (OrderType.LIMIT, OrderType.STOPLOSS) and new_type != order.order_type:
        from app.services.broker_conversion import start
        return await start(session, order, new_type, price)
    candidate = order.model_copy(deep=True)
    if new_type == candidate.order_type:
        if price is not None:
            if new_type == OrderType.LIMIT:
                candidate.limit_price = price
            else:
                candidate.trigger_price = price
    else:
        resolved = price if price is not None else (candidate.trigger_price if new_type == OrderType.LIMIT else candidate.limit_price)
        candidate.order_type = new_type
        candidate.trigger_price = candidate.limit_price = resolved
        candidate.is_stoploss = new_type == OrderType.STOPLOSS
    await sync_order_edit_async(session, candidate, new_type, reprice=price is not None or new_type != order.order_type)
    if order.status != order_service.OrderStatus.PENDING:
        await persist_order_async(order)
        return order
    if new_type == order.order_type:
        kwargs = {"limit_price": price} if new_type == OrderType.LIMIT else {"trigger_price": price}
        result = order_service.update_order(session.session_id, order.order_id, session.date, **kwargs, persist=False) if price is not None else order
    else:
        result = order_service.convert_order(session.session_id, order.order_id, new_type, session.date, price, persist=False, execution_gap_pct=candidate.execution_gap_pct)
    if result:
        result.kotak_order_id = candidate.kotak_order_id
        result.execution_role = candidate.execution_role
        if session.session_type == "real":
            result.limit_price = candidate.limit_price
            result.execution_gap_pct = candidate.execution_gap_pct
            result.market_order = candidate.market_order
        await persist_order_async(result)
    return result


def sync_order_edit(session, order: Order, new_order_type: OrderType, *, reprice: bool = False) -> None:
    """Sync a proposed edit before publishing it locally; propagate broker failure."""
    if session.session_type != "real":
        return
    if getattr(session, "broker_refresh_events", None) is not None:
        from app.services.kotak_service import KotakError
        raise KotakError("Broker refresh is in progress; retry the edit shortly")
    from app.services.kotak_service import get_service as get_kotak, KotakError
    from app.services.simulation import _register_kotak_sl_for_order
    from app.services.execution_price_service import reprice_trigger
    previous = order_service.get_order(session.session_id, order.order_id)
    if reprice or previous is None or previous.order_type != order.order_type or previous.trigger_price != order.trigger_price:
        reprice_trigger(order)
    try:
        if order.kotak_order_id:
            broker = get_kotak()
            old_id = order.kotak_order_id
            replacement = None
            if new_order_type == OrderType.LIMIT:
                replacement = broker.modify_sl_to_limit_order(order.kotak_order_id, order.limit_price, order.quantity)
            elif new_order_type == OrderType.STOPLOSS:
                replacement = broker.modify_sl_order(order.kotak_order_id, order.trigger_price,
                                       order.limit_price, order.quantity)
            else:
                broker.cancel_order(order.kotak_order_id, purpose="conversion")
                broker.deregister_fill_callback(order.kotak_order_id)
                broker.deregister_reject_callback(order.kotak_order_id)
                broker.deregister_cancel_callback(order.kotak_order_id)
                session.kotak_order_map.pop(order.order_id, None)
                order.kotak_order_id = None
            if isinstance(replacement, str) and replacement and replacement != old_id:
                broker.deregister_fill_callback(old_id)
                broker.deregister_reject_callback(old_id)
                broker.deregister_cancel_callback(old_id)
                order.kotak_order_id = replacement
                session.kotak_order_map[order.order_id] = replacement
                register_callbacks(session, order, broker, asyncio.get_running_loop())
        elif new_order_type in (OrderType.LIMIT, OrderType.STOPLOSS):
            _register_kotak_sl_for_order(session, order, asyncio.get_running_loop())
    except Exception as exc:
        logger.warning("broker_order_edit_failed session=%s order=%s type=%s: %s",
                       session.session_id, order.order_id, new_order_type.value, exc)
        raise KotakError(f"Broker rejected order edit: {exc}") from exc


def convert_order(session, order, new_type, price=None):
    if session.session_type == "real" and order.kotak_order_id and new_type in (OrderType.LIMIT, OrderType.STOPLOSS) and new_type != order.order_type:
        # Legacy strategy callers already run on the application loop. Schedule the
        # shared worker and keep the confirmed state until its event arrives.
        from app.services.broker_conversion import enqueue
        return enqueue(session, order, new_type, price)
    # Preview prices without changing the cached order or its wallet reservation.
    candidate = order.model_copy(deep=True)
    if new_type == candidate.order_type:
        if price is not None:
            if new_type == OrderType.LIMIT:
                candidate.limit_price = price
            else:
                candidate.trigger_price = price
    else:
        resolved = price if price is not None else (
            candidate.trigger_price if new_type == OrderType.LIMIT else candidate.limit_price)
        candidate.order_type = new_type
        candidate.trigger_price = resolved
        candidate.limit_price = resolved
        candidate.is_stoploss = new_type == OrderType.STOPLOSS
    sync_order_edit(session, candidate, new_type, reprice=price is not None or new_type != order.order_type)
    if new_type == order.order_type:
        kwargs = {"limit_price": price} if new_type == OrderType.LIMIT else {"trigger_price": price}
        result = order_service.update_order(session.session_id, order.order_id, session.date, **kwargs) if price is not None else order
    else:
        result = order_service.convert_order(session.session_id, order.order_id, new_type, session.date, price)
    if result:
        result.kotak_order_id = candidate.kotak_order_id
        result.execution_role = candidate.execution_role
        if session.session_type == "real":
            result.limit_price = candidate.limit_price
            result.execution_gap_pct = candidate.execution_gap_pct
            result.market_order = candidate.market_order
        order_service._write_order_to_db(result)
    return result



def register_callbacks(session, order, broker, loop):
    """One cumulative-fill handler for entry, exit and imported broker orders."""
    from app.services.broker_position_events import register as register_position_events
    register_position_events(session, broker, loop)
    import json
    from app.models.schemas import OrderStatus
    from app.services import trading, real_broker_state

    def fill(k_id, side, quantity, price):
        if real_broker_state.fill_deferred(session, fill, k_id, side, quantity, price):
            return
        current = order_service.get_order(session.session_id, order.order_id)
        if current is None or current.kotak_order_id != k_id or quantity <= current.broker_filled_quantity or price <= 0:
            return
        from app.services import protection_recovery
        before = trading.get_position(session.session_id, session.symbol, right=current.right, strike=current.strike, expiry=current.expiry)
        before_net = before.quantity * (1 if before.side == "LONG" else -1 if before.side == "SHORT" else 0)
        from app.services.fifo_positions import bootstrap_live
        bootstrap_live(session)
        previous_quantity = current.broker_filled_quantity
        previous_value = current.broker_filled_value
        delta = quantity - previous_quantity
        value = quantity * price
        delta_price = (value - previous_value) / delta
        current.broker_filled_quantity = quantity
        current.broker_filled_value = value
        current.filled_price = price
        current.kotak_fill_confirmed = quantity >= current.quantity
        current.status = OrderStatus.FILLED if current.kotak_fill_confirmed else OrderStatus.PENDING
        from datetime import datetime, timezone
        current.filled_at = current.filled_at or int(datetime.now(timezone.utc).timestamp()) + 19800
        order_service._write_order_to_db(current)
        # Funds displayed for real sessions are broker-owned; release local reservations
        # proportionally rather than applying fictional paper-trading cash movements.
        reserved = current.reserved_amount * delta / max(1, current.quantity - previous_quantity)
        if reserved:
            order_service._credit_reservation(current, reserved, session.date)
            current.reserved_amount = max(0, current.reserved_amount - reserved)
        trade = trading.record_trade(session_id=session.session_id, side=current.side,
            quantity=quantity, price=price, timestamp=current.filled_at, symbol=current.symbol,
            instrument_type="options" if current.right else session.instrument_type,
            right=current.right, strike=current.strike, expiry=current.expiry,
            brokerage_per_order=session.brokerage_per_order, user_id=session.user_id,
            session_type="real", source=current.source,
            trade_id="kotak-live:" + k_id, kotak_order_id=k_id, cumulative=True, defer_exit_reconciliation=True)
        positions = getattr(session, "broker_positions", None)
        if positions is not None or getattr(session, '_fifo_executions', None) is not None:
            real_broker_state.apply_position_fill(session, current, delta, delta_price)
        protection_recovery.note_fill(session, current, delta, before_net)
        order_service.request_exit_reconciliation(session.session_id, session.symbol, current.right, current.strike, current.expiry, session.date)
        if hasattr(trade, "model_dump"):
            session.queue.put_nowait(json.dumps({"type": "new_trade", **trade.model_dump(mode="json")}))
        if current.execution_role != "exit" and (current.entry_sl_price is not None or current.is_autostop):
            from app.services.entry_sl_watcher import on_entry_filled
            on_entry_filled(current, session, loop)
        order_service._write_order_to_db(current)
        if getattr(session, '_fifo_executions', None) is not None:
            snapshot_trade = trade.model_dump(mode="json") if hasattr(trade, "model_dump") else None
            session.queue.put_nowait(json.dumps({"type": "position_snapshot", "session_id": session.session_id,
                "positions": session.broker_positions, "state_version": session._broker_state_version,
                "state_generation": real_broker_state.STATE_GENERATION, "trade": snapshot_trade if isinstance(snapshot_trade, dict) else None}))
        session.queue.put_nowait(json.dumps({"type": "order_filled" if current.kotak_fill_confirmed else "order_updated",
            "order_id": current.order_id, "side": current.side.value, "quantity": quantity,
            "trigger_price": current.trigger_price, "filled_price": price,
            "filled_at": current.filled_at, "right": current.right}))

    def rejected(k_id, reason):
        if real_broker_state.fill_deferred(session, rejected, k_id, reason):
            return
        current = order_service.get_order(session.session_id, order.order_id)
        if current is None or current.kotak_order_id != k_id or current.kotak_fill_confirmed or current.status == OrderStatus.CANCELLED:
            return
        if current.reserved_amount:
            order_service._credit_reservation(current, current.reserved_amount, session.date)
            current.reserved_amount = 0
        current.status = OrderStatus.CANCELLED
        order_service._write_order_to_db(current)
        session.queue.put_nowait(json.dumps({"type": "order_cancelled", "order_id": current.order_id}))
        session.queue.put_nowait(json.dumps({"type": "broker_error", "message": f"Kotak rejected order: {reason}"}))
        logger.warning("broker_order_rejected session=%s order=%s reason=%s", session.session_id, current.order_id, reason)
        if current.source == "cancellation_recovery":
            from app.services.protection_recovery import note_cancel
            current.cancellation_status = "rejected"
            current.cancellation_reason = reason
            current.cancelled_at = __import__("time").time()
            note_cancel(session, current, {"status": "rejected", "raw_reason": reason, "received_at": current.cancelled_at, "raw": {}})

    def cancelled(k_id, metadata):
        if real_broker_state.fill_deferred(session, cancelled, k_id, metadata):
            return
        current = order_service.get_order(session.session_id, order.order_id)
        if current is None or current.kotak_order_id != k_id or current.kotak_fill_confirmed or current.status == OrderStatus.CANCELLED:
            return
        if current.broker_conversion and current.broker_conversion.get("state") in ("cancelling", "replacing"):
            # Conversion worker observes cancellation; fills still use the ordinary handler.
            return
        if current.reserved_amount:
            order_service._credit_reservation(current, current.reserved_amount, session.date)
            current.reserved_amount = 0
        current.status = OrderStatus.CANCELLED
        current.cancellation_status = "cancelled"
        current.cancellation_reason = metadata.get("raw_reason") or None
        current.cancelled_at = metadata.get("received_at")
        from app.services import protection_recovery
        protection_recovery.note_cancel(session, current, metadata)
        session.queue.put_nowait(json.dumps({"type": "order_cancelled", "order_id": current.order_id, "reason": current.cancellation_reason, "broker_status": "cancelled"}))

    broker.register_fill_callback(order.kotak_order_id, fill, loop)
    broker.register_cancel_callback(order.kotak_order_id, cancelled, loop)
    broker.register_reject_callback(order.kotak_order_id, rejected, loop)


def submit_immediate(session, order, loop):
    """Submit a marketable LIMIT now, retaining exact contract and entry intent."""
    from app.services.kotak_service import get_service
    from app.services.simulation import _is_position_exit
    broker = get_service()
    role = "exit" if _is_position_exit(session, order) else "entry"
    kwargs = dict(symbol=session.symbol, side="B" if order.side == TradeSide.BUY else "S",
                  qty=order.quantity, price=order.limit_price)
    if order.right:
        kwargs.update(right=order.right, strike=order.strike, expiry=order.expiry)
        broker_id = broker.place_options_limit_order(**kwargs)
    else:
        broker_id = broker.place_limit_order(**kwargs)
    order.execution_role = role
    order.kotak_order_id = broker_id
    session.kotak_order_map[order.order_id] = broker_id
    order_service._write_order_to_db(order)
    register_callbacks(session, order, broker, loop)
    logger.info("broker_immediate_submitted session=%s order=%s role=%s", session.session_id, order.order_id, role)
