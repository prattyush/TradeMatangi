#!/usr/bin/env python3
"""Read-only one-day, 1-minute history probe: candle count and volume per provider.

Fetches one past trading day of 1-minute candles for the given symbols straight from Kite,
ICICI Breeze and Kotak Neo and prints how many candles came back and whether the volume
field is present and non-zero. Never places/modifies/cancels orders. Kotak writes its usual
history cache file; Kite and Breeze write nothing.

    source ~/venvs/tradematangi/bin/activate
    python scripts/check-history-volume-probe.py --date 2026-11-09 --symbols NAUKRI UBL NIFTY \\
        --providers kite breeze kotak --output .cache/index-extras/history-probe.json
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))


def summarize(volumes, count):
    present = [v for v in volumes if v is not None]
    return {'candles': count, 'volume_field': bool(present), 'volume_sum': float(sum(present)) if present else None,
            'volume_nonzero_candles': sum(1 for v in present if v and float(v) > 0)}


def kite(symbol, day):
    import pandas as pd
    from app.config import MARKET_OPEN, get_market_close
    from app.services import kite_service
    _, token = kite_service.fetch_equity_instrument_token(symbol)
    records = kite_service._kite_request(kite_service._get_kite(), 'historical', 'historical_data',
        instrument_token=token, from_date=pd.Timestamp(f'{day} {MARKET_OPEN}').to_pydatetime(),
        to_date=pd.Timestamp(f'{day} {get_market_close(day)}').to_pydatetime(), interval='minute', continuous=False, oi=False)
    return summarize([r.get('volume') for r in records], len(records))


def breeze(symbol, day):
    from app.config import SUPPORTED_SYMBOLS
    from app.services import broker_service
    from app.services.breeze_history import request_history
    info = SUPPORTED_SYMBOLS[symbol]
    response = request_history(broker_service._get_breeze(), interval='1minute', from_date=f'{day} 09:15:00',
        to_date=f'{day} 15:30:00', stock_code=info['breeze_stock_code'], exchange_code=info['exchange_code'],
        product_type=info['product_type'])
    rows = (response or {}).get('Success') or []
    if not rows:
        raise ValueError('no candles')
    return summarize([float(r['volume']) if r.get('volume') not in (None, '') else None for r in rows], len(rows))


def kotak(symbol, day):
    from app.services.kotak_history import fetch_history
    frame = fetch_history(symbol, day)
    return summarize(frame['volume'].tolist() if 'volume' in frame else [], len(frame))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--date', required=True, help='a past trading day, YYYY-MM-DD')
    parser.add_argument('--symbols', nargs='+', required=True)
    parser.add_argument('--providers', nargs='+', choices=['kite', 'breeze', 'kotak'], default=['kite', 'breeze', 'kotak'])
    parser.add_argument('--output', type=Path, default=ROOT / '.cache/index-extras/history-probe.json')
    args = parser.parse_args()
    probes = {'kite': kite, 'breeze': breeze, 'kotak': kotak}
    results = []
    for provider in args.providers:
        for symbol in args.symbols:
            row = {'provider': provider, 'symbol': symbol, 'date': args.date}
            try:
                row.update(status='verified', **probes[provider](symbol, args.date))
            except Exception as exc:
                # Provider exception messages can contain request URLs/auth details.
                row.update(status='unverified', error_type=type(exc).__name__)
            results.append(row)
            print(row, flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2) + '\n')
    return int(any(r['status'] != 'verified' for r in results))


if __name__ == '__main__':
    raise SystemExit(main())
