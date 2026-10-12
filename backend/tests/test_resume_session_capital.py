"""A resumed session's baseline must not become its remaining cash."""
from decimal import Decimal
from unittest.mock import Mock

import pytest

from app.routers.simulation import _session_response
from app.services import simulation, wallet_service


@pytest.fixture
def restore(monkeypatch):
    simulation._sessions.clear()
    wallet = Mock(return_value=60_000)
    writes = Mock()
    monkeypatch.setattr(wallet_service, "get_ledger_balance", wallet)
    monkeypatch.setattr(simulation, "_upsert_session_to_db", writes)
    monkeypatch.setattr("app.services.guardrail_service.initialize_guardrails", lambda *_: None)
    monkeypatch.setattr("app.services.trading.reload_trades_from_db", lambda *_, **__: None)
    monkeypatch.setattr("app.services.trading.get_trades", lambda *_: [])
    monkeypatch.setattr("app.services.real_broker_state.restore_orders", lambda *_: None)
    monkeypatch.setattr("app.services.order_service.reload_paper_orders", lambda *_, **__: None)

    def rebuild(kind="paper", capital=Decimal("100000"), **kwargs):
        record = dict(session_id="saved", user_id="user", symbol="NIFTY",
                      date="2026-10-12", session_type=kind, session_capital=capital,
                      wallet_ledger_id="paper:2026-10-12")
        return simulation.rebuild_session_from_db(record, "user", **kwargs)

    yield rebuild, wallet, writes
    simulation._sessions.clear()


@pytest.mark.parametrize("capital", [Decimal("100000"), "100000", 100000.0, 0])
@pytest.mark.parametrize("read_only", [False, True])
def test_paper_baseline_survives_restore_and_preview(restore, capital, read_only):
    rebuild, wallet, writes = restore
    session = rebuild(capital=capital, read_only=read_only, starting_capital=50_000)
    assert session.session_capital == float(capital)
    assert _session_response(session).session_capital == float(capital)
    wallet.assert_not_called()
    if read_only:
        writes.assert_not_called()
        assert "saved" not in simulation._sessions
    else:
        assert writes.call_args.args[0].session_capital == float(capital)


def test_repeated_paper_resume_ignores_cash_changes_and_wallet_reset(restore):
    rebuild, wallet, _ = restore
    for cash in (60_000, 110_000, 200_000):
        wallet.return_value = cash
        simulation._sessions.clear()  # server restart / stopped engine
        assert rebuild().session_capital == 100_000
    wallet.assert_not_called()


@pytest.mark.parametrize("override, expected", [(None, 100_000), (18_000, 18_000), (0, 0)])
def test_real_preserves_authoritative_frozen_baseline(restore, override, expected):
    rebuild, wallet, _ = restore
    assert rebuild("real", starting_capital=override).session_capital == expected
    wallet.assert_not_called()


@pytest.mark.parametrize("capital", [None, "invalid", True, float("nan"), float("inf")])
@pytest.mark.parametrize("kind", ["paper", "real"])
def test_legacy_invalid_baseline_uses_existing_fallback_and_logs(restore, caplog, capital, kind):
    rebuild, wallet, _ = restore
    assert rebuild(kind, capital=capital).session_capital == 60_000
    wallet.assert_called_once()
    assert "session_capital_resume_fallback" in caplog.text


@pytest.mark.parametrize("kind", ["paper", "real"])
def test_legacy_explicit_fallback(restore, kind):
    rebuild, wallet, _ = restore
    assert rebuild(kind, capital=None, starting_capital=75_000).session_capital == 75_000
    wallet.assert_not_called()


@pytest.mark.parametrize("kind", ["sim", "stepwise"])
def test_replay_and_stepwise_existing_capital_rules_unchanged(restore, kind):
    rebuild, wallet, _ = restore
    assert rebuild(kind).session_capital == 60_000
    assert rebuild(kind, starting_capital=80_000).session_capital == 80_000
    wallet.assert_called_once()
