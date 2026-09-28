from types import SimpleNamespace
import pytest

from app.services import desktop_paper_eod


def test_near_close_quote_uses_exact_ce_and_pe_contracts(monkeypatch):
    from app.services import options_service
    date = "2026-09-28"
    close = desktop_paper_eod._clock(date, "15:09:00")
    seen = []

    def fetch(symbol, trading_date, strike, expiry, right):
        seen.append((symbol, trading_date, strike, expiry, right))

    def ticks(symbol, trading_date, strike, expiry, right, start_time):
        assert start_time == "15:04:00"
        return iter([{"time": close - 30, "close": 101 if right == "CE" else 72},
            {"time": close + 15, "close": 103 if right == "CE" else 74}])

    monkeypatch.setattr(options_service, "fetch_options_historical", fetch)
    monkeypatch.setattr(options_service, "options_iter_ticks", ticks)
    session = SimpleNamespace(date=date)
    ce = desktop_paper_eod._near_close_quote(session, "NIFTY", "CE", 22950, "2026-09-29")
    pe = desktop_paper_eod._near_close_quote(session, "NIFTY", "PE", 22800, "2026-09-29")

    assert (float(ce["price"]), float(pe["price"])) == (103, 74)
    assert seen == [("NIFTY", date, 22950, "2026-09-29", "CE"),
        ("NIFTY", date, 22800, "2026-09-29", "PE")]


def test_near_close_quote_rejects_old_contract_price(monkeypatch):
    from app.services import options_service
    close = desktop_paper_eod._clock("2026-09-28", "15:09:00")
    monkeypatch.setattr(options_service, "fetch_options_historical", lambda *args: None)
    monkeypatch.setattr(options_service, "options_iter_ticks", lambda *args: iter([
        {"time": close - 601, "close": 100}, {"time": close + 301, "close": 101}]))
    assert desktop_paper_eod._near_close_quote(SimpleNamespace(date="2026-09-28"),
        "NIFTY", "CE", 22950, "2026-09-29") is None


def test_paper_recovery_does_not_treat_failed_trade_read_as_flat(monkeypatch):
    from app.services import trading
    monkeypatch.setattr("app.services.db.get_dynamodb_resource",
        lambda: (_ for _ in ()).throw(RuntimeError("storage unavailable")))
    with pytest.raises(RuntimeError, match="storage unavailable"):
        trading.reload_trades_from_db("saved-paper", strict=True)
