"""Urgent, exact-contract exits using existing broker-confirmed conversion paths."""
import asyncio
import json
import logging
import math

from fastapi import HTTPException
from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
from app.services import order_service, simulation, trading
from app.services.execution_price_service import limit_price

logger = logging.getLogger(__name__)
EMERGENCY_GAP = 0.03


def targets(session):
    equity = [{'right': None, 'strike': None, 'expiry': None}] if session.instrument_type == 'equity' else []
    keys = {(row['right'], row['strike'], row['expiry'])
            for row in trading.get_open_option_contracts(session.session_id, session.symbol)}
    for row in getattr(session, 'broker_positions', None) or []:
        if row.get('quantity', 0) and row.get('right') in ('CE', 'PE') and row.get('strike') is not None and row.get('expiry'):
            keys.add((row['right'], row['strike'], row['expiry']))
    return equity + [dict(right=right, strike=strike, expiry=expiry) for right, strike, expiry in sorted(keys)]


def position(session, target):
    facts = getattr(session, 'broker_positions', None)
    if session.session_type == 'real' and facts is not None:
        matching = [row for row in facts if (row.get('right'), row.get('strike'), row.get('expiry')) ==
                    (target['right'], target['strike'], target['expiry']) and row.get('quantity', 0)]
        if any(row.get('product', 'MIS').upper() != 'MIS' for row in matching):
            raise ValueError('Exit all now supports MIS positions only; another product requires broker review')
    return trading.get_position(session.session_id, session.symbol, **target, exact_contract=True)


def emit(session, order):
    session.queue.put_nowait(json.dumps({'type': 'order_placed', **order.model_dump(mode='json')}))


async def quote(session, target):
    if session.session_type == 'real':
        from app.services.protection_recovery import obtain_quote
        probe = Order(session_id=session.session_id, user_id=session.user_id, symbol=session.symbol,
                      side=TradeSide.SELL, order_type=OrderType.LIMIT, quantity=1,
                      created_at=int(session.current_time or 0), trigger_price=1, limit_price=1, **target)
        return await obtain_quote(session, probe, f'emergency-exit:{session.session_id}')
    from app.routers.desktop_trading import _last_price_for_right
    price = _last_price_for_right(session, **target)
    if not math.isfinite(price) or price <= 0:
        raise ValueError('No valid price for this exact contract; no exit order placed')
    return price


async def create_exit(session, target, side, quantity, price):
    from app.services.execution_analytics import snapshot
    order = order_service.place_order(
        session_id=session.session_id, user_id=session.user_id, symbol=session.symbol,
        side=side, order_type=OrderType.LIMIT, quantity=quantity,
        created_at=int(session.current_time or 0), trading_date=session.date,
        limit_price=limit_price(side, price, EMERGENCY_GAP), is_stoploss=True,
        market_order=False, quote_price=price, source='emergency_exit',
        wallet_ledger_id=session.wallet_ledger_id,
        wallet_ledger_kind='real' if session.session_type == 'real' else 'paper' if session.session_type == 'paper' else 'sim',
        analytics={**snapshot(session, quantity=quantity, price=price, side=side.value,
                              exit_method='LIMIT', size='Full'), 'emergency_exit': True,
                   'emergency_offset_pct': EMERGENCY_GAP}, **target,
    )
    order.execution_role = 'exit'
    order.execution_gap_pct = EMERGENCY_GAP
    if session.session_type == 'real':
        from app.services.kotak_service import get_service, KotakOrderRejected
        from app.services.broker_order_service import register_callbacks, persist_order_async
        broker = get_service()
        # Persist an unconfirmed reservation before contacting the broker. An
        # ambiguous acknowledgement cannot become a local tick fill or a new retry.
        order.recovery_state = 'submitting'
        order.analytics['broker_tag'] = 'tme' + order.order_id.replace('-', '')[:17]
        await persist_order_async(order, strict=True)
        kwargs = dict(symbol=session.symbol, side='S' if side == TradeSide.SELL else 'B',
                      qty=quantity, price=order.limit_price, tag=order.analytics['broker_tag'])
        method = broker.place_limit_order
        if target['right']:
            kwargs.update(target)
            method = broker.place_options_limit_order
        try:
            broker_id = await asyncio.to_thread(method, **kwargs)
            if not isinstance(broker_id, str) or not broker_id:
                raise ValueError('Broker acknowledgement has no order identity')
        except Exception as exc:
            # Only an explicit negative broker response proves nothing was placed.
            order.recovery_state = 'failed' if isinstance(exc, KotakOrderRejected) else 'unknown'
            if isinstance(exc, KotakOrderRejected):
                order.status = OrderStatus.CANCELLED
            await persist_order_async(order, strict=True)
            emit(session, order)
            raise ValueError(f'Exit submission {order.recovery_state}: {exc}. Check broker orders before retrying.') from exc
        order.kotak_order_id = broker_id
        order.recovery_state = 'acknowledged'
        session.kotak_order_map[order.order_id] = broker_id
        register_callbacks(session, order, broker, asyncio.get_running_loop())
        await persist_order_async(order, strict=True)
    else:
        order_service._write_order_to_db(order)
    emit(session, order)
    logger.info('emergency_exit_submitted session=%s order=%s contract=%s quantity=%s limit=%s',
                session.session_id, order.order_id, target, quantity, order.limit_price)
    return order


async def exit_contract(session, target):
    from app.services.protection_recovery import session_lock
    from app.services.broker_conversion import busy
    from app.services.broker_order_service import convert_order_async
    row = {**target, 'created': [], 'converted': [], 'pending': [], 'errors': []}
    initial = position(session, target)
    if initial.side == 'FLAT' or not initial.quantity:
        return row
    price = await quote(session, target)
    async with session_lock(session):
        current = position(session, target)
        if current.side == 'FLAT' or not current.quantity:
            return row
        side = TradeSide.SELL if current.side == 'LONG' else TradeSide.BUY
        closing = [order for order in order_service.get_open_orders(session.session_id)
                   if (order.right, order.strike, order.expiry) == (target['right'], target['strike'], target['expiry'])
                   and order.side == side]
        remaining = lambda order: max(0, order.quantity - order.broker_filled_quantity)
        if sum(remaining(order) for order in closing) > current.quantity:
            raise ValueError('Existing exits exceed remaining position; refresh broker state before retrying')
        if any(order.recovery_state in ('prepared', 'submitting', 'unknown') for order in closing):
            raise ValueError('An exit acknowledgement is uncertain; refresh and verify broker orders before retrying')
        urgent_price = limit_price(side, price, EMERGENCY_GAP)
        for order in closing:
            if busy(order):
                row['pending'].append(order.order_id)
                row['errors'].append('Existing exit conversion is unconfirmed; no duplicate exit was submitted')
                continue
            if order.order_type == OrderType.LIMIT and ((side == TradeSide.SELL and order.limit_price <= urgent_price) or
                                                       (side == TradeSide.BUY and order.limit_price >= urgent_price)):
                row['pending'].append(order.order_id)
                continue
            try:
                # Do not wait five seconds per SL. Conversion workers own broker
                # confirmation, while the original exit continues covering quantity.
                updated = await convert_order_async(session, order, OrderType.LIMIT, urgent_price)
                if updated.broker_conversion:
                    row['pending'].append(updated.order_id)
                else:
                    row['converted'].append(updated.order_id)
                    session.queue.put_nowait(json.dumps({'type':'order_converted','order_id':updated.order_id,
                        'new_order_type':'LIMIT','trigger_price':updated.trigger_price,'limit_price':updated.limit_price}))
            except Exception as exc:
                row['errors'].append(str(getattr(exc, 'detail', exc)))
        # Fills may arrive while broker edits are awaited. Re-read quantity and
        # existing coverage before creating only the uncovered remainder.
        current = position(session, target)
        if current.side != ('LONG' if side == TradeSide.SELL else 'SHORT'):
            return row
        closing = [order for order in order_service.get_open_orders(session.session_id)
                   if (order.right, order.strike, order.expiry) == (target['right'], target['strike'], target['expiry']) and order.side == side]
        uncovered = max(0, current.quantity - sum(remaining(order) for order in closing))
        chunks = order_service.split_quantity(session.symbol, uncovered) if target['right'] and uncovered else [uncovered]
        for quantity in chunks:
            if not quantity:
                continue
            if session.session_type == 'real':
                # A long edit must not reuse a quote that is now stale.
                from app.services.protection_recovery import fresh_quote
                probe = Order(session_id=session.session_id, user_id=session.user_id, symbol=session.symbol, side=side,
                              order_type=OrderType.LIMIT, quantity=quantity, created_at=0, trigger_price=1, limit_price=1, **target)
                price = fresh_quote(session, probe)
            latest = position(session, target)
            coverage = sum(remaining(order) for order in order_service.get_open_orders(session.session_id)
                           if (order.right,order.strike,order.expiry)==(target['right'],target['strike'],target['expiry']) and order.side==side)
            if latest.side != current.side or latest.quantity - coverage < quantity:
                row['errors'].append('Position changed during exit submission; refresh before retrying the remainder')
                break
            order = await create_exit(session, target, side, quantity, price)
            row['created'].append(order.order_id)
    return row


async def exit_all(session):
    if session.state not in (simulation.SimulationState.RUNNING, simulation.SimulationState.PAUSED):
        raise HTTPException(409, 'Session is not active')
    if session.session_type == 'real' and getattr(session, 'broker_refresh_events', None) is not None:
        raise HTTPException(409, 'Broker refresh is in progress; retry shortly')
    lock = getattr(session, '_emergency_exit_lock', None)
    if lock is None:
        lock = session._emergency_exit_lock = asyncio.Lock()
    if lock.locked():
        raise HTTPException(409, 'Exit all now is already in progress')
    async with lock:
        results = []
        for target in targets(session):
            try:
                result = await exit_contract(session, target)
            except Exception as exc:
                logger.exception('emergency_exit_failed session=%s contract=%s', session.session_id, target)
                result = {**target, 'created': [], 'converted': [], 'pending': [],
                          'errors': [str(getattr(exc, 'detail', exc))]}
            results.append(result)
        return {'session_id': session.session_id, 'offset_pct': EMERGENCY_GAP, 'results': results,
                'status': 'needs_attention' if any(row['errors'] for row in results) else 'orders_requested' if any(row['created'] or row['converted'] or row['pending'] for row in results) else 'already_flat'}
