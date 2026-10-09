"""Kite intraday execution. Writes are sent once; reports resolve uncertain ACKs."""
from __future__ import annotations
import csv
import hashlib
import math
import threading
import time
from decimal import Decimal, ROUND_HALF_UP
from app.services import kite_service, broker_reports
from app.services.kotak_service import KotakError, KotakOrderRejected

_EXCHANGES = {'NSE': 'nse_cm', 'BSE': 'bse_cm', 'NFO': 'nse_fo', 'BFO': 'bse_fo'}


class KiteExecutionService:
    execution_broker = 'kite'

    def __init__(self):
        self._lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._feed_lock = threading.Lock()
        self._next_write = 0
        self._client = None
        self._account = None
        self._ticker = None
        self._generation = 0
        self._ready = threading.Event()
        self._fills, self._rejects, self._cancels = {}, {}, {}
        self._orders, self._positions, self._latest = {}, {}, {}
        self._instruments = {}
        self._audit_tasks, self._audit_dirty = {}, set()

    def _get_client(self):
        client = kite_service._get_kite()
        if client is not self._client:
            from app.services.kite_requests import request
            profile = request(client, 'general', 'profile')
            account = hashlib.sha256(str(profile['user_id']).encode()).hexdigest()[:16]
            with self._lock:
                if self._account and self._account != account and (self._fills or self._positions):
                    raise KotakError('Kite account changed; close/reconcile the existing account before trading')
                self._client, self._account = client, account
            if self._ticker and getattr(self, "_feed_client", None) is not client:
                self.start_order_feed()
        return client

    def is_authenticated(self):
        try:
            self._get_client()
            return True
        except Exception:
            return False

    def account_identity(self):
        self._get_client()
        return self._account

    def _read(self, method, **kwargs):
        from app.services.kite_requests import request
        try:
            return request(self._get_client(), 'general', method, **kwargs)
        except Exception as exc:
            raise KotakError(f'Kite {method} failed: {exc}') from exc

    def _write(self, method, **kwargs):
        client = self._get_client()
        # Do not run writes through the read helper's automatic 429 retry loop.
        with self._write_lock:
            time.sleep(max(0, self._next_write - time.monotonic()))
            self._next_write = time.monotonic() + .16
            try:
                result = getattr(client, method)(**kwargs)
            except Exception as exc:
                code = getattr(exc, 'code', None)
                if code in (400, 401, 403, 404, 429) or type(exc).__name__ in ('InputException', 'MarginException', 'TokenException', 'OrderException'):
                    raise KotakOrderRejected(f'Kite rejected {method}: {exc}') from exc
                raise KotakError(f'Kite {method} acknowledgement is uncertain; refresh before retrying: {exc}') from exc
        if not isinstance(result, str) or not result:
            raise KotakError('Kite acknowledgement has no order identity; refresh before retrying')
        return result

    def _master(self, exchange):
        from app.config import DATA_DIR
        path = DATA_DIR / f'kite_instruments_{exchange}.csv'
        if not path.exists():
            kite_service._refresh_instruments_cache(exchange, path)
        with path.open(newline='') as handle:
            return list(csv.DictReader(handle))

    def instrument(self, symbol, right=None, strike=None, expiry=None):
        if right:
            token = kite_service.fetch_options_instrument_token(symbol, expiry, strike, right)
            exchange = 'BFO' if symbol == 'BSESEN' else 'NFO'
            match = next((r for r in self._master(exchange) if int(r['instrument_token']) == token), None)
        else:
            exchange, token = kite_service.fetch_equity_instrument_token(symbol)
            match = next((r for r in self._master(exchange) if int(r['instrument_token']) == token), None)
        if not match or not match.get('tradingsymbol'):
            raise KotakOrderRejected('Kite instrument metadata is missing')
        self._instruments[(exchange, match['tradingsymbol'])] = match
        return {**match, 'exchange': exchange}

    @staticmethod
    def _price(value, tick):
        if not math.isfinite(float(value)) or value <= 0 or float(tick) <= 0:
            raise KotakOrderRejected('Kite price/tick must be positive and finite')
        step = Decimal(str(tick))
        return float((Decimal(str(value)) / step).quantize(Decimal('1'), rounding=ROUND_HALF_UP) * step)

    def _place(self, symbol, side, qty, price, right=None, strike=None, expiry=None, trigger=None, tag=None):
        instrument = self.instrument(symbol, right, strike, expiry)
        lot = int(instrument.get('lot_size') or 1)
        if not isinstance(qty, int) or qty <= 0 or qty % lot:
            raise KotakOrderRejected(f'Kite quantity must be a positive multiple of {lot}')
        if side not in ('B', 'S', 'BUY', 'SELL'):
            raise KotakOrderRejected('Kite side must be BUY or SELL')
        if tag and (len(tag) > 20 or not tag.isalnum()):
            raise KotakOrderRejected('Kite tag must be <=20 alphanumeric characters')
        tick = instrument['tick_size']
        return self._write('place_order', variety='regular', exchange=instrument['exchange'],
            tradingsymbol=instrument['tradingsymbol'], transaction_type='BUY' if side in ('B', 'BUY') else 'SELL',
            quantity=qty, product='MIS', order_type='SL' if trigger is not None else 'LIMIT', validity='DAY',
            price=self._price(price, tick), trigger_price=self._price(trigger, tick) if trigger is not None else 0, tag=tag)

    def place_limit_order(self, symbol, side, qty, price, tag=None):
        return self._place(symbol, side, qty, price, tag=tag)

    def place_sl_order(self, symbol, side, qty, trigger_price, limit_price, tag=None):
        return self._place(symbol, side, qty, limit_price, trigger=trigger_price, tag=tag)

    def place_options_limit_order(self, symbol, side, qty, price, right, strike, expiry, tag=None):
        return self._place(symbol, side, qty, price, right, strike, expiry, tag=tag)

    def place_options_sl_order(self, symbol, side, qty, trigger_price, limit_price, right, strike, expiry, tag=None):
        return self._place(symbol, side, qty, limit_price, right, strike, expiry, trigger_price, tag)

    def _modify(self, order_id, price, qty, trigger=None):
        # Existing order metadata supplies the actual tick size on resumed books.
        row = next((r for r in self._read('orders') if str(r['order_id']) == order_id), None)
        if row is None:
            raise KotakOrderRejected('Kite order is not in today\'s book')
        instrument = self._metadata(row)
        tick = instrument.get('tick_size')
        if tick is None:
            raise KotakOrderRejected('Kite order tick metadata is missing')
        return self._write('modify_order', variety=row.get('variety', 'regular'), order_id=order_id,
            order_type='SL' if trigger is not None else 'LIMIT', quantity=qty, price=self._price(price, tick),
            trigger_price=self._price(trigger, tick) if trigger is not None else 0, validity='DAY')

    def modify_sl_order(self, order_id, new_trigger, new_limit, qty):
        return self._modify(order_id, new_limit, qty, new_trigger)

    def modify_sl_to_limit_order(self, order_id, limit_price, qty):
        return self._modify(order_id, limit_price, qty)

    def cancel_order(self, order_id, *, initiator='system', purpose='legacy', context=None):
        return self._write('cancel_order', variety='regular', order_id=order_id)

    def _metadata(self, raw):
        exchange, symbol = raw['exchange'], raw['tradingsymbol']
        match = self._instruments.get((exchange, symbol))
        if match is None:
            match = next((r for r in self._master(exchange) if r.get('tradingsymbol') == symbol), None)
            if match:
                self._instruments[(exchange, symbol)] = match
        if not match:
            raise KotakError(f'Kite contract metadata is missing for {exchange}:{symbol}')
        return match

    def _normalize(self, raw):
        meta = self._metadata(raw)
        right = meta.get('instrument_type')
        right = right if right in ('CE', 'PE') else None
        expiry = str(meta.get('expiry') or '')[:10] or None
        return broker_reports.normalize_order(dict(broker_order_id=str(raw.get('order_id') or ''), execution_broker='kite',
            symbol=raw['tradingsymbol'], underlying=meta.get('name', ''), exchange=_EXCHANGES[raw['exchange']],
            side=raw.get('transaction_type'), order_type=raw.get('order_type'), status=raw.get('status', ''),
            quantity=raw.get('quantity', 0), filled_quantity=raw.get('filled_quantity', 0),
            filled_price=raw.get('average_price', 0), limit_price=raw.get('price', 0), trigger_price=raw.get('trigger_price', 0),
            product=raw.get('product', 'MIS'), tag=raw.get('tag'), reject_reason=raw.get('status_message'),
            order_time=str(raw.get('order_timestamp') or ''), right=right, strike=int(float(meta.get('strike') or 0)) or None,
            expiry=expiry, instrument_token=meta.get('instrument_token')))

    def get_order_history(self):
        return [self._normalize(r) for r in self._read('orders') if r.get('product') == 'MIS']

    def get_trade_history(self):
        rows = []
        for raw in self._read('trades'):
            if raw.get('product') != 'MIS':
                continue
            row = self._normalize(raw)
            stamp = str(raw.get('exchange_timestamp') or raw.get('fill_timestamp') or '')
            rows.append(broker_reports.normalize_execution({**row, 'execution_id': str(raw['trade_id']),
                'execution_time': stamp, 'quantity': raw['quantity'], 'price': raw['average_price']}))
        return rows

    def get_positions(self):
        rows = []
        for raw in self._read('positions')['net']:
            if raw.get('product') != 'MIS':
                continue
            row = self._normalize(raw)
            if raw.get('overnight_quantity', 0):
                raise KotakError('Unexpected carried MIS position; broker verification required')
            rows.append({**row, 'netQty': raw['quantity'], 'avg_entry_price': raw['average_price'],
                'flBuyQty': raw['day_buy_quantity'], 'flSellQty': raw['day_sell_quantity'],
                'flBuyAmt': raw['day_buy_value'], 'flSellAmt': raw['day_sell_value'],
                'cfBuyQty': 0, 'cfSellQty': 0, 'realized_pnl': raw['realised']})
        return rows

    def get_limits(self):
        margin = self._read('margins', segment='equity')
        net = float(margin['net'])
        # debits already contains SPAN/exposure/premium; never sum them twice.
        utilized, available = margin['utilised'], margin['available']
        committed = float(utilized['debits'])
        realized = float(utilized['m2m_realised'])
        capital = sum(float(available[key]) for key in ('opening_balance', 'intraday_payin', 'collateral', 'adhoc_margin'))
        if not all(math.isfinite(value) for value in (net, committed, realized, capital)):
            raise KotakError('Kite funds report contains nonfinite values')
        return {'Net': net, 'MarginUsed': committed, 'RealizedPnl': realized, 'DayStartCapital': capital}

    def shutdown(self):
        from app.services.kite_reactor import call
        with self._feed_lock:
            ticker, self._ticker = self._ticker, None
            if ticker:
                call(ticker.close)
        with self._lock:
            self._fills.clear(); self._rejects.clear(); self._cancels.clear()
            self._orders.clear(); self._positions.clear(); self._latest.clear()

    def get_funds(self):
        return self.get_limits()['Net']

    def start_order_feed(self):
        from kiteconnect import KiteTicker
        from app.services.kite_reactor import call
        client = self._get_client()
        with self._feed_lock:
            if self._ticker and getattr(self, '_feed_client', None) is client:
                return
            if self._ticker:
                call(self._ticker.close)
            self._generation += 1
            ticker = KiteTicker(client.api_key, client.access_token)
            self._feed_client, self._ticker = client, ticker
            self._ready.clear()
            ticker.on_order_update = lambda ws, raw: self.on_order(raw) if self._ticker is ws else None
            def connected(ws, response):
                if self._ticker is not ws:
                    return
                self._ready.set()
                from app.services import simulation, real_broker_state
                for token, (_, loop) in list(self._positions.items()):
                    session = simulation.get_session(token)
                    if session and not loop.is_closed():
                        def refresh(session=session):
                            import asyncio
                            task = asyncio.create_task(real_broker_state.refresh(session, self))
                            task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
                        loop.call_soon_threadsafe(refresh)
            ticker.on_connect = connected
            call(ticker.connect)
            if not self._ready.wait(15):
                call(ticker.close)
                self._ticker = None
                raise KotakError('Kite order connection timed out; no order submitted')

    def on_order(self, raw):
        try:
            row = self._normalize(raw)
        except (ValueError, KeyError, KotakError):
            return  # A malformed event cannot synthesize a fill; explicit refresh resolves it.
        identifier = row['broker_order_id']
        with self._lock:
            old = self._latest.get(identifier)
            if old and (row == old or row['filled_quantity'] < old['filled_quantity'] or (old['status'] in ('complete', 'cancelled', 'rejected') and row['filled_quantity'] == old['filled_quantity'] and row['filled_price'] == old['filled_price'])):
                return
            self._latest[identifier] = row
            observers = list(self._orders.values())
            fill = self._fills.get(identifier)
            reject = self._rejects.get(identifier)
            cancel = self._cancels.get(identifier)
        for callback, loop in observers:
            if not loop.is_closed():
                loop.call_soon_threadsafe(callback, {**row, '_received_at': time.time()})
        from app.services import simulation
        for token, (_, loop) in list(self._positions.items()):
            session = simulation.get_session(token)
            if session and broker_reports.in_scope(session, row) and not loop.is_closed():
                loop.call_soon_threadsafe(self._request_audit, session, loop)

        if fill and row['filled_quantity'] > 0 and row['filled_price'] > 0:
            callback, loop = fill
            if not loop.is_closed():
                loop.call_soon_threadsafe(callback, identifier, row['side'], row['filled_quantity'], row['filled_price'])
        terminal = reject if row['status'] == 'rejected' else cancel if row['status'] in ('cancelled', 'canceled') else None
        if terminal:
            callback, loop = terminal
            if not loop.is_closed():
                data = row['reject_reason'] if terminal is reject else {'status': 'cancelled', 'reason': row['reject_reason'], 'raw': row}
                loop.call_soon_threadsafe(callback, identifier, data)

    def _request_audit(self, session, loop):
        import asyncio
        token = session.session_id
        self._audit_dirty.add(token)
        if token in self._audit_tasks:
            return
        async def run():
            from app.services import kotak_reports, real_broker_state
            try:
                while token in self._audit_dirty and token in self._positions and session.state.value != 'ended':
                    self._audit_dirty.discard(token)
                    bundle = await kotak_reports.fetch(self, background=True, force=True)
                    await real_broker_state.refresh(session, self, bundle=bundle)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                import json
                session.queue.put_nowait(json.dumps({'type': 'broker_error', 'message': f'Kite account update needs Trade History Refresh: {exc}'}))
            finally:
                self._audit_tasks.pop(token, None)
                self._audit_dirty.discard(token)
        self._audit_tasks[token] = asyncio.create_task(run())

    def _register(self, registry, identifier, callback, loop, replay=False):
        with self._lock:
            registry[identifier] = (callback, loop)
            row = self._latest.get(identifier)
        if replay and row:
            self._replay(row, registry, callback, loop)

    def _replay(self, row, registry, callback, loop):
        identifier = row['broker_order_id']
        if registry is self._fills and row['filled_quantity'] and row['filled_price']:
            loop.call_soon_threadsafe(callback, identifier, row['side'], row['filled_quantity'], row['filled_price'])
        elif registry is self._rejects and row['status'] == 'rejected':
            loop.call_soon_threadsafe(callback, identifier, row['reject_reason'])
        elif registry is self._cancels and row['status'] in ('cancelled', 'canceled'):
            loop.call_soon_threadsafe(callback, identifier, {'status': 'cancelled', 'raw': row})

    def register_fill_callback(self, identifier, callback, loop): self._register(self._fills, identifier, callback, loop, True)
    def register_reject_callback(self, identifier, callback, loop): self._register(self._rejects, identifier, callback, loop, True)
    def register_cancel_callback(self, identifier, callback, loop): self._register(self._cancels, identifier, callback, loop, True)
    def register_order_observer(self, token, callback, loop): self._register(self._orders, token, callback, loop)
    def register_position_observer(self, token, callback, loop): self._register(self._positions, token, callback, loop)
    def deregister_fill_callback(self, identifier): self._fills.pop(identifier, None)
    def deregister_reject_callback(self, identifier): self._rejects.pop(identifier, None)
    def deregister_cancel_callback(self, identifier): self._cancels.pop(identifier, None)
    def deregister_order_observer(self, token): self._orders.pop(token, None)
    def deregister_position_observer(self, token):
        self._positions.pop(token, None)
        task = self._audit_tasks.pop(token, None)
        if task:
            task.cancel()
        self._audit_dirty.discard(token)


_service = KiteExecutionService()


def get_service():
    return _service
