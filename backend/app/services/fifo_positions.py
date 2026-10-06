"""Remaining-lot cost basis from individual, confirmed broker executions."""
from collections import defaultdict, deque
from datetime import datetime, timezone
import math
from app.models.schemas import TradeSide
from app.services import broker_reports as reports


def exchange_for(session):
    if session.instrument_type == 'options':
        return 'bse_fo' if session.symbol == 'BSESEN' else 'nse_fo'
    from app.services.kotak_service import _SYMBOL_MAP
    return _SYMBOL_MAP.get(session.symbol, (session.symbol, 'nse_cm'))[1]


def scope(session, execution, master=None):
    resolved = reports.contract(session, execution, master)
    return (execution.get('exchange') or exchange_for(session), execution.get('product', 'MIS').upper(),
            resolved['right'], resolved['strike'], resolved['expiry'])


def unique_executions(session, executions, master=None):
    seen, result = {}, []
    for source in executions:
        row = dict(source)
        row['quantity'] = int(row['quantity'])
        row['price'] = float(row['price'])
        row['timestamp'] = int(row['timestamp'])
        if 'execution_sort_time' in row:
            row['execution_sort_time'] = int(row['execution_sort_time'])
        if not reports.in_scope(session, row) or (not row.get('_live_delta') and datetime.fromtimestamp(row['timestamp'], timezone.utc).date().isoformat() != session.date):
            continue
        if row.get('side_known', True) is False or row['side'] not in ('BUY', 'SELL') or row['quantity'] <= 0 or not math.isfinite(row['price']) or row['price'] <= 0:
            raise ValueError('Invalid confirmed execution for FIFO reconstruction')
        row.update(reports.contract(session, row, master))
        identity = (row.get('exchange') or exchange_for(session), row['kotak_order_id'], row['execution_id'])
        fingerprint = (scope(session, row, master), row['side'], row['quantity'], row['price'], row['timestamp'])
        if identity in seen:
            if seen[identity] != fingerprint:
                raise ValueError('Conflicting duplicate broker execution')
            continue
        seen[identity] = fingerprint
        result.append(dict(row))
    def order_key(row):
        identifier = row['execution_id']
        identity = (0, int(identifier)) if str(identifier).isdigit() else (1, str(identifier))
        return (row.get('execution_sort_time', row['timestamp'] * 1_000_000), identity)
    return sorted(result, key=order_key)


def positions(session, executions, master=None):
    from app.services.trading import compute_commission
    rows = unique_executions(session, executions, master)
    totals = defaultdict(lambda: {'quantity': 0, 'value': 0.})
    for row in rows:
        key = (*scope(session, row, master), row['kotak_order_id'], row['side'])
        totals[key]['quantity'] += row['quantity']
        totals[key]['value'] += row['quantity'] * row['price']
    lots = defaultdict(deque)
    for row in rows:
        key = scope(session, row, master)
        total = totals[(*key, row['kotak_order_id'], row['side'])]
        flat = session.brokerage_per_order
        fee = compute_commission(TradeSide(row['side']), total['value'] / total['quantity'], total['quantity'], flat)
        entry_fee = (fee - flat) * (row['quantity'] * row['price'] / total['value']) + flat * row['quantity'] / total['quantity']
        quantity = row['quantity']
        sign = 1 if row['side'] == 'BUY' else -1
        queue = lots[key]
        while quantity and queue and queue[0]['sign'] != sign:
            first = queue[0]
            matched = min(quantity, first['quantity'])
            first['fee'] *= (first['quantity'] - matched) / first['quantity']
            first['quantity'] -= matched
            quantity -= matched
            if not first['quantity']:
                queue.popleft()
        if quantity:
            queue.append({'sign': sign, 'quantity': quantity, 'price': row['price'], 'fee': entry_fee * quantity / row['quantity']})
    result = []
    for (exchange, product, right, strike, expiry), queue in lots.items():
        quantity = sum(lot['quantity'] for lot in queue)
        side = ('LONG' if queue[0]['sign'] > 0 else 'SHORT') if queue else 'FLAT'
        result.append(dict(symbol=session.symbol, broker_exchange=exchange, product=product,
            right=right, strike=strike, expiry=expiry, side=side, quantity=quantity,
            avg_entry_price=sum(lot['price'] * lot['quantity'] for lot in queue) / quantity if quantity else 0.,
            entry_commission=sum(lot['fee'] for lot in queue), cost_basis='fifo'))
    return result


def verified_positions(session, executions, reported, master=None):
    reconstructed = positions(session, executions, master)
    def key(row):
        return (row.get('broker_exchange') or exchange_for(session), row.get('product', 'MIS').upper(), row.get('right'), row.get('strike'), row.get('expiry'))
    def signed(row):
        return row['quantity'] * (1 if row['side'] == 'LONG' else -1 if row['side'] == 'SHORT' else 0)
    actual = defaultdict(int)
    for row in reported:
        actual[key(row)] += signed(row)
    rebuilt = {key(row): row for row in reconstructed}
    for identity in actual.keys() | rebuilt.keys():
        fifo = rebuilt.get(identity)
        expected = signed(fifo) if fifo else 0
        if expected != actual[identity]:
            raise ValueError(f'FIFO execution history incomplete or updating for {identity}: executions={expected}, broker={actual[identity]}')
    for row in reconstructed:
        evidence = next((p for p in reported if key(p) == key(row)), None)
        row['broker_avg_entry_price'] = float(evidence['avg_entry_price']) if evidence else 0.
    return reconstructed


def bootstrap_live(session):
    """A flat starting book can safely seed closed-order fee history before live deltas."""
    if getattr(session, '_fifo_executions', None) is not None:
        return
    from app.services import trading
    from app.services.kotak_service import _SYMBOL_MAP, _build_options_trading_symbol
    facts = getattr(session, 'broker_positions', None)
    if facts and any(row['quantity'] for row in facts):
        return  # An open historical book requires authoritative execution refresh.
    trades = trading.get_trades(session.session_id)
    net = defaultdict(int)
    for trade in trades:
        net[(trade.right, trade.strike, trade.expiry)] += trade.quantity * (1 if trade.side == TradeSide.BUY else -1)
    if any(net.values()):
        return
    rows = []
    for trade in trades:
        symbol = _SYMBOL_MAP.get(session.symbol, (session.symbol, 'nse_cm'))[0]
        if trade.right:
            symbol = _build_options_trading_symbol('SENSEX' if session.symbol == 'BSESEN' else session.symbol,
                trade.expiry, trade.strike, trade.right, session.symbol)
        rows.append(dict(symbol=symbol, exchange=trade.broker_exchange or exchange_for(session), product='MIS',
            kotak_order_id=trade.kotak_order_id or trade.trade_id, execution_id='legacy:' + trade.trade_id,
            quantity=trade.quantity, price=trade.price, side=trade.side.value, timestamp=trade.timestamp,
            execution_sort_time=trade.timestamp * 1_000_000, _live_delta=True))
    session._fifo_executions = rows


def live_delta(session, order, quantity, price):
    if getattr(session, '_fifo_executions', None) is None:
        return None
    from app.services.kotak_service import _SYMBOL_MAP, _build_options_trading_symbol
    import time
    symbol = _SYMBOL_MAP.get(session.symbol, (session.symbol, 'nse_cm'))[0]
    if order.right:
        symbol = _build_options_trading_symbol('SENSEX' if session.symbol == 'BSESEN' else session.symbol,
            order.expiry or session.expiry, order.strike, order.right, session.symbol)
    now = int(time.time()) + 19800
    previous_sort = max((row.get('execution_sort_time', row['timestamp'] * 1_000_000) for row in session._fifo_executions), default=0)
    from app.services.execution_analytics import order_snapshot, filled
    row = dict(analytics=filled(order_snapshot(order, session), price, quantity), symbol=symbol, exchange=order.broker_exchange or exchange_for(session), product=order.broker_product or 'MIS',
        kotak_order_id=order.kotak_order_id, execution_id=f'live:{order.kotak_order_id}:{order.broker_filled_quantity}',
        quantity=quantity, price=price, side=order.side.value, timestamp=now,
        execution_sort_time=max(now * 1_000_000, previous_sort + 1), _live_delta=True)
    session._fifo_executions.append(row)
    return row
