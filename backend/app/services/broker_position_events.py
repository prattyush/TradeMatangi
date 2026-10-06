"""Position-feed invalidation: reconcile broker facts, never synthesize executions."""
import asyncio
import logging
import math
from app.services import broker_reports as reports, order_service, trading

logger = logging.getLogger(__name__)
_tasks = {}
DEBOUNCE = .25


def register(session, broker, loop):
    broker.register_position_observer(session.session_id, lambda row: on_position(session, broker, row), loop)


def _contract(session, row):
    symbol = str(row.get('trdSym') or row.get('sym') or '')
    normalized = reports.normalize_order({**row, 'trdSym': symbol})
    if not reports.in_scope(session, normalized):
        return None
    try:
        return reports.contract(session, normalized)
    except reports.UnknownContractError:
        # Monthly wire messages can omit expiry. Resolve only from known exact orders.
        from app.services.kotak_service import _build_options_trading_symbol
        for order in order_service.get_all_orders(session.session_id):
            if order.right and order.expiry and order.strike:
                expected = _build_options_trading_symbol('SENSEX' if session.symbol == 'BSESEN' else session.symbol,
                    order.expiry, order.strike, order.right, session.symbol)
                if expected == symbol:
                    return {'right': order.right, 'strike': order.strike, 'expiry': order.expiry}
        return None


def _agrees(session, contract, row):
    position = trading.get_position(session.session_id, session.symbol, **contract)
    signed = position.quantity * (1 if position.side == 'LONG' else -1 if position.side == 'SHORT' else 0)
    # Filled buy/sell counters are daily facts. Do not assume they include carry-forward.
    buy, sell = float(row['flBuyQty']), float(row['flSellQty'])
    carry = float(row.get('cfBuyQty') or 0) - float(row.get('cfSellQty') or 0)
    if signed != buy - sell + carry:
        return False
    ledger = getattr(session, '_fifo_executions', None)
    if ledger is None:
        return False  # A legacy book needs confirmed history before accepting evidence.
    from app.services.fifo_positions import scope
    totals = {'BUY': 0, 'SELL': 0}
    for execution in ledger:
        exchange, product, right, strike, expiry = scope(session, execution)
        if (right, strike, expiry) == (contract['right'], contract['strike'], contract['expiry']) and product == str(row.get('prod') or 'MIS').upper() and exchange == str(row.get('exSeg') or '').lower():
            totals[execution['side']] += execution['quantity']
    return totals['BUY'] == buy and totals['SELL'] == sell


def on_position(session, broker, row):
    from app.services.simulation import get_session
    if get_session(session.session_id) is not session or session.session_type != 'real':
        return
    contract = _contract(session, row)
    if contract is None or row.get('flBuyQty') is None or row.get('flSellQty') is None:
        logger.debug('broker_position_scope_incomplete session=%s; raw event retained', session.session_id)
        return
    try:
        counts = tuple(float(row.get(key) or 0) for key in ('flBuyQty', 'flSellQty', 'cfBuyQty', 'cfSellQty'))
        if any(not math.isfinite(value) or value < 0 or not value.is_integer() for value in counts):
            raise ValueError('invalid quantities')
    except (ValueError, TypeError):
        logger.warning('broker_position_invalid_quantities session=%s', session.session_id)
        return
    key = (row.get('exSeg'), row.get('prod'), *contract.values())
    seen = getattr(session, '_broker_position_seen', {})
    fingerprint = (*counts, str(row.get('buyAmt') or ''), str(row.get('sellAmt') or ''))
    if seen.get(key) == fingerprint:
        return
    if len(seen) >= 256:
        seen.pop(next(iter(seen)))
    seen[key] = fingerprint
    session._broker_position_seen = seen
    # Let the ordinary fill callback commit before comparing position evidence.
    pending = getattr(session, '_broker_position_pending', {})
    pending[key] = (contract, dict(row), key)
    session._broker_position_pending = pending
    if session.session_id not in _tasks:
        task = asyncio.create_task(reconcile(session, broker))
        _tasks[session.session_id] = task
        task.add_done_callback(lambda _: _tasks.pop(session.session_id, None))


async def reconcile(session, broker):
    from app.services import simulation, real_broker_state
    from app.services.broker_conversion import busy
    try:
        await asyncio.sleep(DEBOUNCE)
        for _ in range(120):
            if simulation.get_session(session.session_id) is not session:
                return
            if any(busy(order) and order.broker_conversion.get('state') != 'unknown' for order in order_service.get_all_orders(session.session_id)):
                await asyncio.sleep(DEBOUNCE)
                continue
            break
        else:
            session._broker_position_pending = {}
            return
        # A single report refresh covers all queued contracts, not just the last one.
        pending = getattr(session, '_broker_position_pending', {})
        session._broker_position_pending = {}
        if not pending or all(_agrees(session, contract, row) for contract, row, _ in pending.values()):
            logger.debug('broker_position_already_committed session=%s', session.session_id)
            return
        logger.info('broker_position_reconcile_requested session=%s; execution reports own fills', session.session_id)
        await real_broker_state.refresh(session, broker)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception('broker_position_reconcile_failed session=%s; verified accounting retained', session.session_id)
        # Permit a repeated position message to retry; never generate a trade from it.
        for key in locals().get('pending', {}):
            getattr(session, '_broker_position_seen', {}).pop(key, None)
    finally:
        if getattr(session, '_broker_position_pending', None) and simulation.get_session(session.session_id) is session:
            # The current worker is removed by its done callback before scheduling again.
            asyncio.get_running_loop().call_soon(_restart, session, broker)


def _restart(session, broker):
    if session.session_id in _tasks:
        asyncio.get_running_loop().call_soon(_restart, session, broker)
        return
    task = asyncio.create_task(reconcile(session, broker))
    _tasks[session.session_id] = task
    task.add_done_callback(lambda _: _tasks.pop(session.session_id, None))


def stop(session, broker):
    broker.deregister_position_observer(session.session_id)
    task = _tasks.pop(session.session_id, None)
    if task:
        task.cancel()
    session._broker_position_pending = {}
    session._broker_position_seen = {}
