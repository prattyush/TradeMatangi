"""Explicit Real closure: never confuse acknowledgements with a flat book."""
import asyncio
import json
from app.services import order_service, simulation

_jobs = {}


def summary(session):
    from app.services import emergency_exit
    positions = [{**target, **emergency_exit.position(session, target).model_dump()} for target in emergency_exit.targets(session)
                 if emergency_exit.position(session, target).quantity]
    return {'session_id': session.session_id, 'execution_broker': session.execution_broker,
            'positions': positions, 'position_count': len(positions),
            'pending_order_count': len(order_service.get_open_orders(session.session_id)),
            'closing': bool(getattr(session, 'real_closing', False))}


def emit(session, message):
    session.queue.put_nowait(json.dumps({'type': 'real_session_status', **summary(session), 'message': message}))


def unresolved(session):
    from app.services.broker_conversion import busy
    from app.services.order_split import ACTIVE
    return any(busy(o) or (o.split_operation or {}).get('state') in ACTIVE or o.recovery_state in ('submitting', 'unknown')
               for o in order_service.get_all_orders(session.session_id))


async def finish(session):
    from app.services import real_sessions
    from app.services import trading
    from app.models.schemas import Position
    trades = [t.model_dump(mode='json') for t in trading.get_trades(session.session_id)]
    flat = Position(symbol=session.symbol, side="FLAT", quantity=0, avg_entry_price=0).model_dump(mode='json')
    net = sum((t['quantity'] * t['price'] * (1 if t['side'] == 'SELL' else -1) - t.get('commission', 0)) for t in trades)
    capital = session.session_capital
    if getattr(session, "real_active_claim", False):
        await asyncio.to_thread(real_sessions.release, session)
    event = {'type': 'session_ended', 'session_id': session.session_id,
        'trades': trades, 'open_orders': [], 'positions': {'equity': flat, 'CE': flat, 'PE': flat},
        'positions_by_contract': {c['contract_key']: flat for c in getattr(session, 'desktop_contracts', [])},
        'pnl': {'day': round(net, 2), 'day_pct': round(net / capital * 100, 2) if capital > 0 else 0,
                'equity': 0, 'ce': 0, 'pe': 0, 'contracts': {}}}
    from app.services.real_trading_day import market_date
    if session.date != market_date():
        event.pop('pnl', None)  # Preserve archived P&L; today's reports cannot reconstruct it.
    session.queue.put_nowait(json.dumps(event))
    session.real_closing = False
    simulation.stop_session(session, preserve_trading_state=True)


async def close(session):
    if getattr(session, 'real_start_preparing', False):
        from app.services import real_sessions
        from fastapi import HTTPException
        slot = await asyncio.to_thread(real_sessions.active, session.user_id)
        if slot and slot.get('operation_id') != getattr(session, 'real_claim_token', None):
            raise HTTPException(409, 'Real startup ownership changed; reconnect to the authoritative session before closing')
    if session.state == simulation.SimulationState.ENDED:
        return {'status': 'stopped', **summary(session)}
    if session.session_id in _jobs:
        return {'status': 'closing', **summary(session)}
    session.real_closing = True
    try:
        await asyncio.to_thread(simulation._upsert_session_to_db, session, strict=True)
    except Exception:
        session.real_closing = False
        raise
    async def run():
        from app.services import execution_broker, real_broker_state, strategy_service, emergency_exit
        from app.routers.orders import cancel_order
        try:
            strategy_service.cancel_all(session.session_id)
            broker = execution_broker.get_service(session)
            while session.state != simulation.SimulationState.ENDED:
                try:
                    from app.services.real_trading_day import market_date
                    if session.date != market_date():
                        # Daily broker order/trade books cannot reconstruct yesterday.
                        # Confirm current exposure without overwriting archived executions.
                        from app.services import kotak_reports, broker_reports
                        bundle = await kotak_reports.fetch(broker)
                        positions = [p for p in bundle.positions if broker_reports.in_scope(session, broker_reports.normalize_order(p))]
                        pending = [r for r in bundle.orders if broker_reports.in_scope(session, broker_reports.normalize_order(r)) and broker_reports.normalize_order(r)['status'] in real_broker_state.OPEN]
                        nonflat = any(float(p.get('netQty', p.get('net_quantity', p.get('quantity', 0)))) for p in positions)
                        if not nonflat and not pending:
                            for order in order_service.get_open_orders(session.session_id):
                                order_service.cancel_order(session.session_id, order.order_id, session.date)
                            await finish(session)
                            return
                        emit(session, 'Previous-day exposure still exists; close it at the broker, then refresh closure. Archived trade history is preserved.')
                        await asyncio.sleep(5)
                        continue
                    await real_broker_state.refresh(session, broker)
                    for order in list(order_service.get_open_orders(session.session_id)):
                        target = {'right': order.right, 'strike': order.strike, 'expiry': order.expiry}
                        position = emergency_exit.position(session, target)
                        pure_exit = position.quantity and ((position.side == 'LONG' and order.side.value == 'SELL') or
                                                          (position.side == 'SHORT' and order.side.value == 'BUY')) and (
                            order.quantity - order.broker_filled_quantity <= position.quantity)
                        if not pure_exit:
                            await cancel_order(order.order_id, session.session_id)
                    if summary(session)['position_count']:
                        await emergency_exit.exit_all(session)
                    await real_broker_state.refresh(session, broker)
                    if not summary(session)['position_count'] and not order_service.get_open_orders(session.session_id) and not unresolved(session):
                        await finish(session)
                        return
                    emit(session, 'Closing positions; waiting for broker-confirmed fills and cancellations')
                except Exception as exc:
                    emit(session, f'Closure needs attention; retrying verification: {exc}')
                await asyncio.sleep(5)
        finally:
            _jobs.pop(session.session_id, None)
    _jobs[session.session_id] = asyncio.create_task(run())
    emit(session, 'Closing session; new entries blocked until closure is verified')
    return {'status': 'closing', **summary(session)}


async def shutdown():
    tasks = list(_jobs.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _jobs.clear()
