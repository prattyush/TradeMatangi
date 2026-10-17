import json
from pathlib import Path
from app.config import SUPPORTED_SYMBOLS
from app.services.kite_service import _KITE_NAMES
from app.services.kotak_service import _SYMBOL_MAP
from app.routers import desktop
import pytest


def test_constituents_are_unique_and_provider_identities_match_pinned_isins():
    snapshot = json.loads((Path(__file__).parents[1] / 'app/resources/nifty100.json').read_text())
    assert len(snapshot['stocks']) == 100
    assert len({s['isin'] for s in snapshot['stocks']}) == 100
    for item in snapshot['stocks']:
        symbol = item['symbol']
        assert SUPPORTED_SYMBOLS[symbol]['isin'] == item['isin']
        assert SUPPORTED_SYMBOLS[symbol]['breeze_stock_code'] == item['breeze_stock_code']
        assert _KITE_NAMES[symbol] == item['nse_symbol']
        assert _SYMBOL_MAP[symbol] == (item['nse_symbol'] + '-EQ', 'nse_cm')


@pytest.mark.asyncio
async def test_non_derivative_stock_does_not_offer_guessed_options():
    symbol = next(s for s, definition in SUPPORTED_SYMBOLS.items() if 'options_exchange_code' not in definition)
    result = await desktop.option_metadata(symbol, '2026-10-09', 'user')
    assert not result.available and result.expiries == []


@pytest.mark.asyncio
async def test_fractional_strike_interval_is_not_truncated_in_metadata():
    result = await desktop.option_metadata('CANBK', '2026-10-09', 'user')
    assert result.strike_interval == .5
