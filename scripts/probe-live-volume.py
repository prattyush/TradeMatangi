#!/usr/bin/env python3
"""Read-only LIVE tick payload probe: does each broker feed carry volume, and is it cumulative?

Track A of the "live volume and VWAP" requirement (docs/spec-phase24.md). Subscribes to the real market-data
websockets of Kite, Fyers, ICICI Breeze and Kotak Neo for a few instruments, keeps the RAW payloads, and reports:

  * which fields each payload has,
  * which volume-like fields exist (volume, vol_traded_today, ttq, ltq, last_traded_quantity, ...),
  * whether such a field only ever grows during the run (a cumulative day total) or jumps up and down (per trade),
  * how many ticks arrived per second.

Kite is tried in LTP and QUOTE (and optionally FULL) mode; Fyers with the default mode and after the LTP-mode call the
application makes. This is what decides how the backend turns provider ticks into per-second volume.

It NEVER places, modifies or cancels an order and writes nothing but the output file. Run it DURING MARKET HOURS
(09:15 to 15:30 IST) or the feeds are silent.

BEFORE YOU RUN IT:
  * Stop the backend (scripts/stop-backend.sh) or at least have no live/paper/real session open. Breeze and Kotak allow one
    live connection per login, and the Kotak probe logs in again, which ends the application's Kotak session.
  * Kotak needs a fresh TOTP: pass --kotak-totp 123456 (a trade login, no order is sent).

    source ~/venvs/tradematangi/bin/activate
    python scripts/probe-live-volume.py --providers kite fyers --seconds 40
    python scripts/probe-live-volume.py --providers breeze --stock NAUKRI --index NIFTY \\
        --option NIFTY 2026-11-17 24500 CE
    python scripts/probe-live-volume.py --providers kotak --kotak-totp 123456

Pick a liquid stock and, if you want option payloads, a near-the-money weekly NIFTY option of the current expiry.
The output (default .cache/index-extras/live-volume-probe.json) has the first raw payloads of every instrument and
mode; paste the printed summary into docs/spec-phase24.md ("Track A, probe findings").
"""
import argparse
import json
import re
import sys
import threading
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))

# Field names that may carry traded quantity. A hint only: every key is also listed, so nothing is missed.
VOLUME_HINT = re.compile(r'(vol|ttq|ltq|vtt|traded_?q|last_?trade|buy_?q|sell_?q|tot_?buy|tot_?sell|oi\b)', re.I)
SAMPLES_PER_STREAM = 3
VALUES_PER_KEY = 400


def plain(value):
    """JSON-safe copy of a payload (datetimes, numpy numbers, pydantic models)."""
    if hasattr(value, 'model_dump'):
        value = value.model_dump()
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


class Recorder:
    """Raw payloads grouped by (provider, phase, instrument label)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.streams = {}

    def add(self, provider, phase, label, payload):
        payload = plain(payload)
        now = time.time()
        with self.lock:
            stream = self.streams.setdefault((provider, phase, str(label)), {
                'ticks': 0, 'first_at': now, 'last_at': now, 'keys': Counter(), 'samples': [], 'values': {}})
            stream['ticks'] += 1
            stream['last_at'] = now
            if isinstance(payload, dict):
                stream['keys'].update(payload.keys())
                for key, value in payload.items():
                    if VOLUME_HINT.search(key) and isinstance(value, (int, float)) and not isinstance(value, bool):
                        series = stream['values'].setdefault(key, [])
                        if len(series) < VALUES_PER_KEY:
                            series.append(value)
            if len(stream['samples']) < SAMPLES_PER_STREAM:
                stream['samples'].append(payload)

    def report(self):
        rows = []
        for (provider, phase, label), stream in sorted(self.streams.items()):
            span = max(stream['last_at'] - stream['first_at'], 1e-9)
            fields = {}
            for key, series in stream['values'].items():
                increases = sum(1 for a, b in zip(series, series[1:]) if b > a)
                decreases = sum(1 for a, b in zip(series, series[1:]) if b < a)
                fields[key] = {
                    'first': series[0], 'last': series[-1], 'distinct': len(set(series)),
                    'increases': increases, 'decreases': decreases,
                    # Cumulative day total: never goes down, and grows while trades happen.
                    'cumulative_like': decreases == 0 and increases > 0,
                    'constant': len(set(series)) == 1,
                }
            rows.append({
                'provider': provider, 'phase': phase, 'instrument': label, 'ticks': stream['ticks'],
                'ticks_per_second': round(stream['ticks'] / span, 2) if stream['ticks'] > 1 else None,
                'keys': sorted(stream['keys']), 'volume_like_fields': fields, 'samples': stream['samples'],
            })
        return rows


def read_section(section, ddb_key=None):
    import configparser
    from app.config import DATA_DIR
    cfg = configparser.ConfigParser()
    cfg.read(str(DATA_DIR / 'accesskeys.ini'))
    if section not in cfg:
        raise RuntimeError(f'no [{section}] section in data/accesskeys.ini')
    values = {k: v.strip() for k, v in cfg[section].items()}
    if ddb_key:
        try:
            from app.services.token_service import get_token
            token = get_token(ddb_key)
            if token:
                values['access_token'] = token
        except Exception:
            pass
    return values


def wait(seconds, label):
    print(f'  {label}: listening {seconds}s ...', flush=True)
    time.sleep(seconds)


# ── Kite ──────────────────────────────────────────────────────────────────────

def probe_kite(args, rec):
    from kiteconnect import KiteTicker
    from app.services import kite_service
    tokens = {}
    tokens[kite_service.fetch_equity_instrument_token(args.stock)[1]] = f'stock {args.stock}'
    tokens[kite_service.fetch_equity_instrument_token(args.index)[1]] = f'index {args.index}'
    if args.option:
        symbol, expiry, strike, right = args.option
        token = kite_service.fetch_options_instrument_token(symbol, expiry, float(strike), right)
        tokens[token] = f'option {symbol} {expiry} {strike} {right}'
    kite = kite_service._get_kite()
    ticker = KiteTicker(kite.api_key, kite.access_token)
    state = {'phase': 'connecting'}
    connected = threading.Event()

    def on_ticks(ws, ticks):
        for tick in ticks:
            rec.add('kite', state['phase'], tokens.get(tick.get('instrument_token'), tick.get('instrument_token')), tick)

    def on_connect(ws, response):
        ws.subscribe(list(tokens))
        connected.set()

    ticker.on_ticks, ticker.on_connect = on_ticks, on_connect
    ticker.on_error = lambda ws, code, reason: print(f'  kite error {code} {reason}', flush=True)
    ticker.connect(threaded=True)
    if not connected.wait(20):
        raise RuntimeError('kite websocket did not connect')
    try:
        for name in args.kite_modes:
            mode = {'ltp': ticker.MODE_LTP, 'quote': ticker.MODE_QUOTE, 'full': ticker.MODE_FULL}[name]
            state['phase'] = f'mode_{name}'
            ticker.set_mode(mode, list(tokens))
            wait(args.seconds, f'kite {name}')
    finally:
        ticker.close()


# ── Fyers ─────────────────────────────────────────────────────────────────────

def probe_fyers(args, rec):
    from fyers_apiv3 import data_ws
    from app.services import fyers_service as fs
    cfg = read_section('fyers', 'fyers_access')
    symbols = [fs._fyers_equity_symbol(args.stock), fs._fyers_index_symbol(args.index)]
    if args.option:
        symbol, expiry, strike, right = args.option
        symbols.append(fs._fyers_options_symbol(symbol, expiry, float(strike), right))
    state = {'phase': 'default'}
    connected = threading.Event()

    def on_message(message):
        items = message if isinstance(message, list) else [message]
        for item in items:
            label = item.get('symbol') if isinstance(item, dict) else None
            rec.add('fyers', state['phase'], label or 'control', item)

    def on_connect():
        ws.subscribe(symbols=symbols, data_type='SymbolUpdate')
        connected.set()

    ws = data_ws.FyersDataSocket(
        access_token=f"{cfg['app_id']}:{cfg['access_token']}", log_path='', litemode=False, write_to_file=False,
        reconnect=False, on_connect=on_connect, on_close=lambda m: None,
        on_error=lambda m: print(f'  fyers error {str(m)[:120]}', flush=True), on_message=on_message)
    ws.connect()
    if not connected.wait(20):
        raise RuntimeError('fyers websocket did not connect')
    try:
        wait(args.seconds, 'fyers default mode (litemode=False)')
        # What the application does after subscribing: does this strip the volume fields?
        state['phase'] = 'after_mode_ltp'
        try:
            ws.mode(ws.MODE_LTP)
        except Exception as exc:
            print(f'  fyers mode call failed: {type(exc).__name__}', flush=True)
        wait(args.seconds, 'fyers after MODE_LTP')
    finally:
        try:
            ws.close_connection()
        except Exception:
            pass


# ── Breeze ────────────────────────────────────────────────────────────────────

def probe_breeze(args, rec):
    from datetime import datetime
    from app.config import SUPPORTED_SYMBOLS
    from app.services import broker_service
    breeze = broker_service._get_breeze()
    specs = []
    for kind, name in (('stock', args.stock), ('index', args.index)):
        info = SUPPORTED_SYMBOLS[name]
        specs.append((f'{kind} {name}', dict(exchange_code=info['exchange_code'], stock_code=info['breeze_stock_code'],
                                              product_type=info.get('product_type', 'cash'), expiry_date='', strike_price='', right='')))
    if args.option:
        symbol, expiry, strike, right = args.option
        info = SUPPORTED_SYMBOLS[symbol]
        specs.append((f'option {symbol} {expiry} {strike} {right}', dict(
            exchange_code=info['options_exchange_code'], stock_code=info['breeze_stock_code'], product_type='options',
            expiry_date=datetime.strptime(expiry, '%Y-%m-%d').strftime('%d-%b-%Y'), strike_price=str(strike),
            right='call' if right.upper() == 'CE' else 'put')))

    def on_ticks(tick):
        # Breeze names the instrument in `symbol` / `stock_name`; the raw payload is kept whole.
        label = tick.get('symbol') or tick.get('stock_name') or 'unknown' if isinstance(tick, dict) else 'unknown'
        rec.add('breeze', 'exchange_quotes', label, tick)

    breeze.on_ticks = on_ticks
    breeze.ws_connect()
    try:
        for _, spec in specs:
            breeze.subscribe_feeds(get_exchange_quotes=True, get_market_depth=False, **spec)
        wait(args.seconds * 2, 'breeze exchange quotes')
    finally:
        for _, spec in specs:
            try:
                breeze.unsubscribe_feeds(**spec)
            except Exception:
                pass
        try:
            breeze.ws_disconnect()
        except Exception:
            pass


# ── Kotak ─────────────────────────────────────────────────────────────────────

def probe_kotak(args, rec):
    from app.services import kotak_service
    if not args.kotak_totp:
        raise RuntimeError('Kotak needs --kotak-totp (a fresh 6-digit code)')
    service = kotak_service.get_service()
    service.login_with_totp(args.kotak_totp)  # ends any other Kotak session of the app
    bridge = service._bridge
    if bridge is None:
        raise RuntimeError('Kotak feed bridge did not start')
    wanted = {}
    token, segment = kotak_service.fetch_kotak_equity_instrument_token(args.stock)
    wanted[(segment, str(token))] = (f'stock {args.stock}', False)
    token, segment = kotak_service.fetch_kotak_equity_instrument_token(args.index)
    wanted[(segment, str(token))] = (f'index {args.index}', True)
    if args.option:
        symbol, expiry, strike, right = args.option
        token, segment = kotak_service.fetch_kotak_options_instrument_token(symbol, expiry, float(strike), right)
        wanted[(segment, str(token))] = (f'option {symbol} {expiry} {strike} {right}', False)
    original = bridge._market_message

    def capture(message):
        # The bridge keeps only {tk, e, ltp, timestamp}; record what the SDK delivered BEFORE that filtering.
        data = message.model_dump() if hasattr(message, 'model_dump') else message
        if isinstance(data, dict):
            key = (data.get('exchange_segment'), str(data.get('instrument_token', '')))
            label = wanted.get(key, (f"{data.get('type')} {data.get('name') or key}", False))[0]
            rec.add('kotak', 'sdk_message', label if data.get('type') in ('scrip', 'index') else f"control {data.get('type')}", data)
        original(message)

    bridge._market_message = capture
    try:
        bridge.replace_subscriptions([{'exchange_segment': seg, 'instrument_token': tok, 'is_index': index}
                                      for (seg, tok), (_, index) in wanted.items()])
        wait(args.seconds * 2, 'kotak sdk messages')
    finally:
        service.shutdown()


PROBES = {'kite': probe_kite, 'fyers': probe_fyers, 'breeze': probe_breeze, 'kotak': probe_kotak}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--providers', nargs='+', choices=sorted(PROBES), required=True,
                        help='explicit on purpose: Breeze and Kotak allow one connection per login')
    parser.add_argument('--stock', default='NAUKRI', help='a liquid equity, as in SUPPORTED_SYMBOLS (default NAUKRI)')
    parser.add_argument('--index', default='NIFTY', help='an index (default NIFTY)')
    parser.add_argument('--option', nargs=4, metavar=('SYMBOL', 'EXPIRY', 'STRIKE', 'RIGHT'),
                        help='one option, e.g. NIFTY 2026-11-17 24500 CE (optional)')
    parser.add_argument('--seconds', type=int, default=40, help='listening time per mode (default 40)')
    parser.add_argument('--kite-modes', nargs='+', choices=['ltp', 'quote', 'full'], default=['ltp', 'quote'])
    parser.add_argument('--kotak-totp', help='fresh Kotak TOTP; the probe logs in with it')
    parser.add_argument('--output', type=Path, default=ROOT / '.cache/index-extras/live-volume-probe.json')
    args = parser.parse_args()

    rec = Recorder()
    status = {}
    for provider in args.providers:
        print(f'== {provider}', flush=True)
        try:
            PROBES[provider](args, rec)
            status[provider] = 'ran'
        except Exception as exc:
            # Provider exception messages can carry request URLs or auth details: record the type only.
            status[provider] = f'failed: {type(exc).__name__}'
            print(f'  {provider} failed: {type(exc).__name__}', flush=True)
    rows = rec.report()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'status': status, 'streams': rows}, indent=2, default=str) + '\n')

    print('\n== SUMMARY (paste into docs/spec-phase24.md, Track A probe findings)')
    for row in rows:
        fields = row['volume_like_fields']
        shown = ', '.join(
            f"{k} {v['first']}->{v['last']} ({'cumulative-like' if v['cumulative_like'] else 'constant' if v['constant'] else 'up and down'})"
            for k, v in fields.items()) or 'NO volume-like field'
        print(f"{row['provider']:7} {row['phase']:16} {row['instrument']:34} ticks={row['ticks']:<5} "
              f"/s={row['ticks_per_second']}  {shown}")
    print(f'\nstatus: {status}\nfull payloads: {args.output}')
    return int(any(not s == 'ran' for s in status.values()))


if __name__ == '__main__':
    raise SystemExit(main())
