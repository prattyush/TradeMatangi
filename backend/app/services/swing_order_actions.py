"""Owned amendments for Swing; reuse the existing execution and reservation paths."""
from math import isfinite
from fastapi import HTTPException
from app.models.schemas import OrderStatus, OrderType, TradeSide, UpdateOrderRequest
from app.services import order_service, trading, swing_portfolio_service as service, swing_portfolio_store as store


async def act(user, portfolio_id, order_id, *, price=None, quantity=None, cancel=False):
    row = store.owned(user, portfolio_id)
    if row['state'] in ('stopped', 'ended'):
        raise HTTPException(409, 'Resume this portfolio before changing orders')
    current = await service.ensure(user, portfolio_id)
    child = next((s for s in current.contexts.values() if order_service.get_order(s.session_id, order_id)), None)
    if child is None:
        raise HTTPException(404, 'Portfolio order not found')
    from app.services.wallet_service import InsufficientFundsError
    from app.routers.orders import _session_edit_lock, _update_order_locked, _cancel_order_locked
    async with _session_edit_lock(child):
        if store.owned(user, portfolio_id)['state'] in ('stopped', 'ended'):
            raise HTTPException(409, 'Resume this portfolio before changing orders')
        order = order_service.get_order(child.session_id, order_id)
        if order is None or order.user_id != user:
            raise HTTPException(404, 'Portfolio order not found')
        if order.status != OrderStatus.PENDING:
            raise HTTPException(409, 'Order is no longer pending; refresh its latest state')
        if child.session_type == 'paper':
            from app.services.swing_paper_recovery import require_amendable
            require_amendable(order)
        if child.session_type == 'real' and getattr(child, 'broker_refresh_events', None) is not None:
            raise HTTPException(409, 'Broker refresh is in progress; retry shortly')
        try:
            if cancel:
                await _cancel_order_locked(order_id, child.session_id, child)
            else:
                if price is None and quantity is None:
                    raise HTTPException(422, 'Provide a price or quantity to edit')
                if price is not None and (not isfinite(price) or price <= 0):
                    raise HTTPException(422, 'Price must be positive and finite')
                contract = next((c for c in getattr(child, 'desktop_contracts', []) if (c.get('right'), c.get('strike'), c.get('expiry')) == (order.right, order.strike, order.expiry)), {})
                future = getattr(child, 'future_contract', None) or {}
                if child.instrument_type in ('options', 'futures') and not (contract.get('lot_size') or future.get('lot_size')):
                    raise HTTPException(422, 'Contract lot metadata is unavailable; no quantity change assumed')
                tick = float(contract.get('tick_size') or future.get('tick_size') or .05)
                if price is not None and abs(price / tick - round(price / tick)) > 1e-6:
                    raise HTTPException(422, f'Price must be a multiple of {tick:g}')
                total = quantity if quantity is not None else order.quantity
                lot = int(contract.get('lot_size') or future.get('lot_size') or 1)
                if total <= order.broker_filled_quantity or total % lot:
                    raise HTTPException(422, f'Total quantity must exceed filled quantity and use complete lots of {lot}')
                position = trading.get_position(child.session_id, child.symbol, right=order.right, strike=order.strike, expiry=order.expiry, exact_contract=True)
                closing = (position.side == 'LONG' and order.side == TradeSide.SELL) or (position.side == 'SHORT' and order.side == TradeSide.BUY)
                if closing and total - order.broker_filled_quantity > position.quantity:
                    raise HTTPException(422, 'Remaining exit quantity exceeds the held position')
                if order.side == TradeSide.SELL and child.instrument_type != 'futures' and not closing:
                    raise HTTPException(422, 'This sell order has no matching long position')
                if child.instrument_type == 'futures' and not closing:
                    raise HTTPException(422, 'Cancel this futures entry and replace it after a fresh margin preview')
                values = {'quantity':quantity}
                if price is not None:
                    values['limit_price' if order.order_type == OrderType.LIMIT else 'trigger_price'] = price
                await _update_order_locked(child, order_id, UpdateOrderRequest(**values), child.session_id, swing_amendment=True)
        except InsufficientFundsError as exc:
            raise HTTPException(402, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    result = service.snapshot(user, portfolio_id)
    current.emit({'type':'portfolio_snapshot', **result})
    return result
