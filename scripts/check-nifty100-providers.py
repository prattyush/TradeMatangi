#!/usr/bin/env python3
"""Read-only Nifty 100 mapping/quote probe. Never places/modifies/cancels orders.

Run with the project Python environment. Existing service credential loaders are
used; no credentials are emitted. --quotes additionally checks provider access.
Without --quotes, cached/downloadable instrument masters validate exact identities.
"""
import argparse
import csv
import json
from pathlib import Path
import sys
import time
import io
import zipfile
from functools import lru_cache

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))


@lru_cache(maxsize=1)
def breeze_equities():
    from app.services import breeze_master
    breeze_master.ensure_security_master_downloaded('NFO')
    with zipfile.ZipFile(breeze_master._master_zip_path()) as master:
        rows = csv.DictReader(io.StringIO(master.read('NSEScripMaster.txt').decode('utf-8-sig')), skipinitialspace=True)
        return {row['ISINCode'].strip(): row for row in rows if row.get('Series') == 'EQ'}


def positive_quote(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key.lower().replace('_', '') in ('ltp', 'lastprice', 'lasttradedprice'):
                try:
                    if float(item) > 0:
                        return True
                except (ValueError, TypeError):
                    pass
            if positive_quote(item):
                return True
    elif isinstance(value, list):
        return any(positive_quote(item) for item in value)
    return False


def probe(provider, stock, quotes):
    from app.services import kite_service, kotak_service, broker_service
    symbol = stock['symbol']
    if provider == 'kite':
        exchange, token = kite_service.fetch_equity_instrument_token(symbol)
        if quotes:
            value = kite_service._get_kite().ltp(f'{exchange}:{stock["nse_symbol"]}')
            if not positive_quote(value):
                raise ValueError('Missing quote')
        return str(token)
    if provider == 'kotak':
        from app.services.kotak_history import _get_client
        client = _get_client()
        token, exchange = kotak_service.fetch_kotak_equity_instrument_token(symbol, client=client)
        if quotes:
            value = client.quotes(instrument_tokens=[{'instrument_token':token,'exchange_segment':exchange}], quote_type='ltp')
            if not positive_quote(value):
                raise ValueError('Missing quote')
        return token
    # ISIN avoids ambiguous renamed-company/name matching.
    row = breeze_equities().get(stock['isin'])
    if not row or row['ShortName'] != stock['breeze_stock_code']:
        raise ValueError('Missing or changed ISIN mapping')
    if quotes:
        value = broker_service._get_breeze().get_quotes(stock_code=stock['breeze_stock_code'], exchange_code='NSE', product_type='cash')
        if value.get('Error') or not positive_quote(value.get('Success')):
            raise ValueError('Missing quote')
    return row['Token']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--providers', nargs='+', choices=['kite','kotak','breeze'], default=['kite','kotak','breeze'])
    parser.add_argument('--quotes', action='store_true')
    parser.add_argument('--limit', type=int, default=100)
    parser.add_argument('--output', type=Path, default=ROOT / '.cache/phase21-swing/provider-validation.json')
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error('--limit must be between 1 and 100')
    stocks = json.loads((ROOT / 'backend/app/resources/nifty100.json').read_text())['stocks'][:args.limit]
    results = []
    for provider in args.providers:
        for stock in stocks:
            row = {'provider':provider,'symbol':stock['symbol'],'nse_symbol':stock['nse_symbol'],
                   'requested_check':'quote' if args.quotes else 'instrument_mapping'}
            try:
                row.update(status='verified', token=probe(provider, stock, args.quotes))
            except Exception as exc:
                # Provider exception messages can contain request URLs/auth details.
                row.update(status='unverified', error_type=type(exc).__name__)
            results.append(row)
            print(f"{provider} {stock['symbol']}: {row['status']}", flush=True)
            if args.quotes:
                time.sleep(1.1)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2)+'\n')
    return int(any(row['status'] != 'verified' for row in results))


if __name__ == '__main__':
    raise SystemExit(main())
