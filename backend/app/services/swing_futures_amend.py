"""Margin-reviewed amendments of an existing Swing Futures entry."""
import asyncio
import hashlib
import json
from types import SimpleNamespace

from fastapi import HTTPException
from app.models.schemas import OrderStatus, OrderType
from app.services import swing_portfolio_store as store


def fingerprint(order):
    fields = ('order_id', 'quantity', 'broker_filled_quantity', 'order_type', 'limit_price',
              'trigger_price', 'broker_order_id', 'status', 'reserved_amount', 'reservation_revision')
    data = order.model_dump(mode='json')
    return hashlib.sha256(json.dumps({k: data[k] for k in fields}, sort_keys=True).encode()).hexdigest()


def amendment_fingerprint(order, price, quantity):
    return hashlib.sha256(json.dumps([fingerprint(order), float(price), int(quantity)]).encode()).hexdigest()


async def preview(user, pid, child, order, price, quantity):
    from app.services import futures_preview, swing_market, swing_portfolio_service as service, trading
    from app.routers.orders import _require_confirmed_recovery
    _require_confirmed_recovery(order)
    if order.execution_role == 'exit':
        raise HTTPException(422, 'Only Futures entries need an amendment margin preview')
    service.require_entry_allowed(child, order.side, quantity - order.broker_filled_quantity, expiry=order.expiry)
    position = trading.get_position(child.session_id, child.symbol, expiry=order.expiry)
    if position.quantity and ((position.side == 'LONG' and order.side.value == 'SELL') or (position.side == 'SHORT' and order.side.value == 'BUY')):
        raise HTTPException(409, 'Position direction changed; refresh this order')
    contract = child.future_contract
    if not contract['entry_eligible'] or order.expiry < swing_market.today() or (order.expiry == swing_market.today() and swing_market.now() >= swing_market.closing(order.expiry) - 900):
        raise HTTPException(422, 'This contract is outside the Futures entry window')
    if child.session_type == 'real' and not swing_market.window(swing_market.now()):
        raise HTTPException(409, 'Real Futures entries require the trading session')
    row = store.owned(user, pid)
    before = fingerprint(order)
    req = SimpleNamespace(symbol=order.symbol, expiry=order.expiry, side=order.side,
                          quantity=quantity - order.broker_filled_quantity, price=price,
                          capital_pct=None, capital_revision=row['guardrail_epoch'])
    result = await asyncio.to_thread(futures_preview.preview, user, pid, req)
    if fingerprint(order) != before:
        raise HTTPException(409, 'Order changed during preview; review it again')
    if not result['execution_enabled']:
        raise HTTPException(403, 'New Futures entries are disabled in Admin settings')
    result.update(order_fingerprint=amendment_fingerprint(order, price, quantity), price=price, total_quantity=quantity,
                  existing_reservation=order.reserved_amount,
                  additional_funds=round(result['required_funds'] - order.reserved_amount, 2))
    if child.session_type == 'paper':
        from app.services.swing_cash import read
        result['available_funds'] = read(user, pid)['current_balance']
    return result


async def amend(user, pid, child, order, price, quantity, approval):
    from app.services import broker_order_service, real_funding
    from app.services.execution_price_service import reprice_trigger
    from app.services.kotak_protection import definitive_refusal
    from app.services.swing_cash import move
    approval = approval or {}
    if approval.get('order_fingerprint') != amendment_fingerprint(order, price, quantity):
        raise HTTPException(409, 'Review a fresh margin preview before editing this Futures entry')
    before = fingerprint(order)
    result = await preview(user, pid, child, order, price, quantity)
    if approval.get('capital_revision') != result['capital_revision'] or approval.get('fee_hash') != result['fee_hash']:
        raise HTTPException(409, 'Capital or fees changed; review the preview again')
    if approval.get('approved_budget') is None or result['required_funds'] > approval['approved_budget']:
        raise HTTPException(409, 'Margin changed; confirm a sufficient Futures budget')
    candidate = order.model_copy(deep=True)
    candidate.quantity = quantity
    if candidate.order_type == OrderType.LIMIT:
        candidate.limit_price = price
    else:
        candidate.trigger_price = price
    await asyncio.to_thread(reprice_trigger, candidate)
    if fingerprint(order) != before or store.owned(user, pid)['guardrail_epoch'] != result['capital_revision']:
        raise HTTPException(409, 'Order or capital changed; review the preview again')
    old_reserved = order.reserved_amount
    candidate.reserved_amount = result['required_funds']
    candidate.reservation_revision += 1
    remaining = quantity - order.broker_filled_quantity
    candidate.reservation_margin_rate = candidate.reserved_amount / (remaining * candidate.limit_price)
    if candidate.analytics.get('swing_request'):
        candidate.analytics['swing_request']['capital_revision'] = result['capital_revision']
    future = candidate.analytics.setdefault('futures', {'contract': child.future_contract, 'provider': child.execution_broker, 'valid_date': child.date})
    # Existing report reconstruction scales full-order requirements by unfilled quantity.
    future.update(margin=result['margin'] * quantity / remaining,
                  reserved_requirement=result['required_funds'] * quantity / remaining, amended_entry=True,
                  approved_budget=approval['approved_budget'], fee_profile=result['fee_profile'], evidence=result['evidence'])
    if child.session_type == 'paper':
        move(user, pid, old_reserved - candidate.reserved_amount,
             f'order:{order.order_id}:amend:{result["order_fingerprint"]}:{price}:{quantity}', order=candidate)
    else:
        # Keep a conservative reservation until the broker acknowledges the edit.
        held = max(old_reserved, candidate.reserved_amount)
        owner = 'broker' if order.broker_order_id else 'local'
        real_funding.reserve(child, order.order_id, held, owner=owner)
        original_broker_id = order.broker_order_id
        try:
            await broker_order_service.sync_order_edit_async(child, candidate, candidate.order_type)
        except Exception as exc:
            if definitive_refusal(exc):
                real_funding.reserve(child, order.order_id, old_reserved, owner=owner)
            else:
                order.recovery_state = 'unknown'
                order.analytics['swing_amendment_pending'] = True
                order.reserved_amount = held
                await broker_order_service.persist_order_async(order, strict=True)
            raise HTTPException(502, f'Broker edit was not confirmed: {exc}') from exc
        if fingerprint(order.model_copy(update={'broker_order_id': original_broker_id})) != before:
            # Callbacks own fills. Never overwrite them with the pre-request copy.
            if order.status == OrderStatus.PENDING:
                order.recovery_state = 'unknown'
                order.analytics['swing_amendment_pending'] = True
            await broker_order_service.persist_order_async(order, strict=True)
            raise HTTPException(409, 'Order changed while the broker processed the edit; refresh its latest state')
        real_funding.reserve(child, order.order_id, candidate.reserved_amount, owner=owner)
    # Preserve references used by the execution engine and callback registry.
    for name, value in candidate.__dict__.items():
        setattr(order, name, value)
    if child.session_type == 'real':
        await broker_order_service.persist_order_async(order, strict=True)
