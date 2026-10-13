"""Read-only exact Futures discovery, without orders or broker authentication."""

from datetime import UTC, date, datetime

import pytest
from app.services.futures_contracts import parse_contracts
from app.services.kotak_service import _master_tick


def contract(expiry="2026-10-27", **changes):
    return {
        "name": "NIFTY",
        "instrument_type": "FUT",
        "exchange": "NFO",
        "expiry": expiry,
        "lot_size": "65",
        "tick_size": "0.05",
        "instrument_token": "123",
        "tradingsymbol": "NIFTY26OCTFUT",
        **changes,
    }


def test_next_month_window_uses_actual_expiry_and_seven_calendar_days():
    rows = [
        contract(),
        contract("2026-11-24", instrument_token="234", tradingsymbol="NIFTY26NOVFUT"),
        contract("2026-12-29", instrument_token="345", tradingsymbol="NIFTY26DECFUT"),
    ]
    assert [
        c["entry_eligible"]
        for c in parse_contracts("NIFTY", "kite", rows, date(2026, 10, 19))
    ] == [True, False, False]
    assert [
        c["entry_eligible"]
        for c in parse_contracts("NIFTY", "kite", rows, date(2026, 10, 20))
    ] == [True, True, False]
    assert [
        c["expiry"] for c in parse_contracts("NIFTY", "kite", rows, date(2026, 10, 28))
    ] == ["2026-11-24", "2026-12-29"]


def test_exact_names_and_exchange_prevent_spot_options_or_other_underlying_leakage():
    rows = [
        contract(),
        contract(name="BANKNIFTY"),
        contract(instrument_type="CE"),
        contract(exchange="BFO"),
        contract(expiry="bad"),
        contract(lot_size="0"),
        contract(tick_size="nan"),
    ]
    assert len(parse_contracts("NIFTY", "kite", rows, date(2026, 10, 12))) == 1
    assert parse_contracts("BSESEN", "kite", rows, date(2026, 10, 12)) == []
    with pytest.raises(ValueError, match="Unsupported"):
        parse_contracts("NIFTY100", "kite", rows, date(2026, 10, 12))


def test_stock_aliases_and_fractional_tick_metadata_are_not_guessed():
    rows = [
        contract(
            name="RELIANCE", lot_size="500", tick_size="0.01", instrument_type="FUTSTK"
        )
    ]
    result = parse_contracts("RELIND", "kite", rows, date(2026, 10, 12))
    assert result[0]["category"] == "stock" and result[0]["tick_size"] == 0.01
    assert (
        parse_contracts(
            "NIFTY", "kite", [contract(instrument_type="FUTSTK")], date(2026, 10, 12)
        )
        == []
    )


def test_kotak_numeric_master_expiry_matches_installed_sdk_conversion():
    expiry = int(datetime(2026, 10, 27, tzinfo=UTC).timestamp()) - 315511200
    row = {
        "name": "SENSEX",
        "instrument_type": "FUTIDX",
        "exchange": "bse_fo",
        "expiry": str(expiry),
        "lot_size": 20,
        "tick_size": 0.05,
        "instrument_token": "88",
        "symbol": "SENSEX26OCTFUT",
    }
    result = parse_contracts("BSESEN", "kotak", [row], date(2026, 10, 12))
    assert result[0]["expiry"] == "2026-10-27" and result[0]["exchange"] == "BFO"
    assert result[0]["trading_symbol"] == "SENSEX26OCTFUT"


def test_ambiguous_provider_metadata_is_rejected():
    with pytest.raises(ValueError, match="Ambiguous"):
        parse_contracts(
            "NIFTY",
            "kite",
            [contract(), contract(instrument_token="other")],
            date(2026, 10, 12),
        )


@pytest.mark.parametrize(
    "row,expected",
    [
        ({"dTickSize": "5", "lPrecision": "2"}, 0.05),
        ({"dTickSize": "1", "lPrecision": "0"}, 1),
        ({"tick_size": ".01"}, 0.01),
        ({"dTickSize": "bad", "lPrecision": "2"}, None),
        ({"dTickSize": "5"}, None),
        ({"tick_size": "inf"}, None),
    ],
)
def test_kotak_tick_normalization_does_not_break_other_master_rows(row, expected):
    assert _master_tick(row) == expected
