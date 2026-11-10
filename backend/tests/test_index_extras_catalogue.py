import json
from pathlib import Path

import pytest

from app.config import LOT_SIZES, SUPPORTED_SYMBOLS
from app.routers import data, desktop
from app.services.kite_service import _KITE_NAMES
from app.services.kotak_service import _SYMBOL_MAP

RESOURCES = Path(__file__).parents[1] / "app/resources"
EXTRAS = json.loads((RESOURCES / "index_extras.json").read_text())
NIFTY100 = json.loads((RESOURCES / "nifty100.json").read_text())["stocks"]

SECTORAL = {"NIFTY MIDCAP 50", "NIFTY AUTO", "NIFTY FMCG", "NIFTY IT", "NIFTY BANK", "NIFTY METAL", "NIFTY OIL & GAS"}


def test_extras_are_unique_and_do_not_overlap_nifty100():
    stocks = EXTRAS["stocks"]
    assert len(stocks) == 72
    assert len({s["isin"] for s in stocks}) == 72
    assert len({s["symbol"] for s in stocks}) == 72
    assert not {s["isin"] for s in stocks} & {s["isin"] for s in NIFTY100}
    assert not {s["symbol"] for s in stocks} & {s["symbol"] for s in NIFTY100}
    assert set(EXTRAS["indices"]) == SECTORAL
    assert all(set(s["indices"]) <= SECTORAL and s["indices"] for s in stocks)


def test_midcap50_is_fully_covered_by_the_extras():
    midcap = [s for s in EXTRAS["stocks"] if "NIFTY MIDCAP 50" in s["indices"]]
    assert len(midcap) == 50


@pytest.mark.parametrize("item", EXTRAS["stocks"], ids=lambda s: s["symbol"])
def test_provider_identities_match_pinned_rows(item):
    symbol = item["symbol"]
    definition = SUPPORTED_SYMBOLS[symbol]
    assert definition["isin"] == item["isin"]
    assert definition["breeze_stock_code"] == item["breeze_stock_code"]
    assert definition["exchange_code"] == "NSE" and definition["options_only"] is False
    assert _KITE_NAMES[symbol] == item["nse_symbol"]
    assert _SYMBOL_MAP[symbol] == (item["nse_symbol"] + "-EQ", "nse_cm")


@pytest.mark.parametrize("item", EXTRAS["stocks"], ids=lambda s: s["symbol"])
def test_options_only_when_both_brokers_list_them(item):
    definition = SUPPORTED_SYMBOLS[item["symbol"]]
    if item["option_eligible"]:
        assert definition["options_exchange_code"] == "NFO"
        assert definition["strike_interval"] == item["strike_interval"] > 0
        assert LOT_SIZES[item["symbol"]] == item["lot_size"] > 0
    else:
        assert "options_exchange_code" not in definition
        assert item["symbol"] not in LOT_SIZES
        assert "lot_size" not in item


def test_stocks_without_derivatives_are_not_option_eligible():
    by_symbol = {s["symbol"]: s for s in EXTRAS["stocks"]}
    assert by_symbol["UBL"]["option_eligible"] is False
    assert by_symbol["NAUKRI"]["option_eligible"] is True


@pytest.mark.asyncio
async def test_symbols_endpoint_lists_the_new_stocks():
    response = await data.get_symbols()
    listed = {item.symbol: item for item in response.symbols}
    assert {s["symbol"] for s in EXTRAS["stocks"]} <= set(listed)
    assert listed["NAUKRI"].display_name == "Info Edge (India) Ltd."
    assert listed["NAUKRI"].option_eligible is True and listed["NAUKRI"].chart_type == "equity"
    assert listed["UBL"].option_eligible is False


@pytest.mark.asyncio
async def test_option_metadata_for_new_symbols():
    available = await desktop.option_metadata("NAUKRI", "2026-10-09", "user")
    assert available.strike_interval == next(s["strike_interval"] for s in EXTRAS["stocks"] if s["symbol"] == "NAUKRI")
    unavailable = await desktop.option_metadata("UBL", "2026-10-09", "user")
    assert not unavailable.available and unavailable.expiries == []
