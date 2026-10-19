"""Explicit Real Day start rebases capital; funds/history refreshes never do."""
from copy import deepcopy
from unittest.mock import AsyncMock, Mock
import pytest
from app.models.schemas import Trade, TradeSide
from app.services import real_accounting, simulation, trading, wallet_service
from app.services.performance_service import build_cycles, cached_report
from app.services.day_journey import journeys
from tests.test_phase19_broker_wallet import isolated, session, USER, DATE

persist_session = simulation._upsert_session_to_db


def loss_trades(s, amount=150):
    return [Trade(session_id=s.session_id, user_id=s.user_id, symbol=s.symbol,
                  side=side, quantity=1, price=price, timestamp=100+i, session_type='real')
            for i, (side, price) in enumerate([(TradeSide.BUY, 200), (TradeSide.SELL, 200-amount)])]


def restricted_session(monkeypatch):
    s = session()
    s.session_capital = 813
    s.guardrail_ban_enabled = True
    s.guardrail_ban_capital_pct = 12
    s.guardrail_ban_active = True
    s.guardrail_last_type = 'BAN'
    s.guardrail_last_reason = 'old capital loss'
    s.guardrail_block_until_bar = 999
    monkeypatch.setattr(trading, 'get_trades', lambda sid: loss_trades(s))
    return s


@pytest.mark.parametrize('broker', ['kite', 'kotak'])
def test_only_start_replaces_saved_capital_and_never_double_counts_deposit(isolated, broker):
    kwargs = dict(execution_broker=broker)
    if broker == 'kite': kwargs['capital_override'] = 813
    first = wallet_service.sync_real_account_funds(USER, DATE, 'account', 663, -150, 0, reason='start', **kwargs)
    assert first['session_capital'] == 813
    # Wallet can change because of a transfer, losses, fees or committed funds.
    if broker == 'kite': kwargs['capital_override'] = 28713
    for reason in ('refresh', 'reconcile', 'swing_start'):
        snap = wallet_service.sync_real_account_funds(USER, DATE, 'account', 28563, -150, 0, reason=reason, **kwargs)
        assert snap['balance'] == 28563 and snap['session_capital'] == 813
    for _ in range(2):
        snap = wallet_service.sync_real_account_funds(USER, DATE, 'account', 28563, -150, 0, reason='start', **kwargs)
        assert snap['session_capital'] == 28713
    # Subsequent trading and margin changes retain the new capital.
    snap = wallet_service.sync_real_account_funds(USER, DATE, 'account', 26000, -200, 2000, reason='refresh', **kwargs)
    assert snap['session_capital'] == 28713
    if broker == 'kite': kwargs['capital_override'] = 10000
    snap = wallet_service.sync_real_account_funds(USER, DATE, 'account', 9800, -200, 0, reason='start', **kwargs)
    assert snap['session_capital'] == 10000


def test_ordinary_refresh_does_not_change_capital_or_ban(monkeypatch, isolated):
    s = restricted_session(monkeypatch)
    persist = Mock()
    monkeypatch.setattr(simulation, '_upsert_session_to_db', persist)
    real_accounting.apply_session_capital(s, 28713)
    assert s.session_capital == 813 and s.guardrail_ban_active
    persist.assert_not_called()


def test_start_rechecks_loss_limit_without_resetting_cooldown(monkeypatch, isolated):
    s = restricted_session(monkeypatch)
    persist = Mock()
    monkeypatch.setattr(simulation, '_upsert_session_to_db', persist)
    real_accounting.apply_session_capital(s, 28713, on_start=True)
    assert s.session_capital == 28713 and not s.guardrail_ban_active
    assert s.guardrail_last_type == '' and s.guardrail_block_until_bar == 999
    persist.assert_called_once_with(s, strict=True)


def test_start_does_not_clear_independent_losing_trade_ban(monkeypatch, isolated):
    s = restricted_session(monkeypatch)
    s.guardrail_ban_min_trades = 1
    s.guardrail_ban_loss_trade_pct = 60
    real_accounting.apply_session_capital(s, 28713, on_start=True)
    assert s.guardrail_ban_active and 'trades in loss' in s.guardrail_last_reason


def test_failed_start_persistence_restores_previous_capital_and_ban(monkeypatch, isolated):
    s = restricted_session(monkeypatch)
    monkeypatch.setattr(simulation, '_upsert_session_to_db', Mock(side_effect=RuntimeError('unavailable')))
    with pytest.raises(RuntimeError):
        real_accounting.apply_session_capital(s, 28713, on_start=True)
    assert s.session_capital == 813 and s.guardrail_ban_active
    assert s.guardrail_last_reason == 'old capital loss'


@pytest.mark.asyncio
async def test_explicit_start_of_live_engine_and_failed_broker_fetch(monkeypatch, isolated):
    s = restricted_session(monkeypatch)
    s.real_day_allocation_pct = 1
    fetch = AsyncMock(return_value={'session_capital':28713})
    monkeypatch.setattr(real_accounting, 'refresh', fetch)
    await real_accounting.restart_capital(s, Mock())
    assert s.session_capital == 28713 and not s.guardrail_ban_active
    fetch.assert_awaited_once()
    assert fetch.call_args.kwargs == {'reason':'start'}
    fetch.side_effect = RuntimeError('broker unavailable')
    with pytest.raises(RuntimeError): await real_accounting.restart_capital(s, Mock())
    assert s.session_capital == 28713


def test_completed_real_trades_rebase_stats_and_journey_but_preserve_sizing():
    record = dict(session_id='session', user_id=USER, symbol='ABC', date=DATE,
                  session_type='real', session_capital=813)
    rows = [dict(trade_id=str(i), timestamp=100+i, side=side, quantity=1, price=price,
                 commission=0, analytics={'capital':813, 'initial_risk':20, 'effective_allocation_pct':25})
            for i, (side, price) in enumerate([('BUY', 200), ('SELL', 50)])]
    original = deepcopy(rows)
    old = build_cycles(record, rows)
    old_report = cached_report(old)
    updated = build_cycles({**record, 'session_capital':28713}, rows)
    c = updated[0]
    assert c['net_pnl'] == old[0]['net_pnl'] == -150
    assert c['pnl_pct'] == pytest.approx(-150/28713*100)
    assert c['entries'][0]['pnl_pct'] == c['matches'][0]['pnl_pct'] == c['pnl_pct']
    assert c['entries'][0]['analytics']['capital'] == 813
    assert rows == original
    assert journeys(updated)[0]['net_pnl_pct'] == c['pnl_pct']
    assert cached_report(updated) != old_report
    # Practice and Swing keep their existing captured-capital percentages.
    for overrides in ({'session_type':'paper'}, {'trading_style':'swing'}):
        other = build_cycles({**record, 'session_capital':28713, **overrides}, rows)[0]
        assert other['capital'] == 813


@pytest.mark.asyncio
async def test_restart_retains_day_allocation_without_changing_swing(monkeypatch, isolated):
    s = restricted_session(monkeypatch)
    s.real_day_allocation_pct = .5
    monkeypatch.setattr(real_accounting, 'refresh', AsyncMock(return_value={'session_capital':20000}))
    await real_accounting.restart_capital(s, Mock())
    assert s.session_capital == 10000 and s.real_day_allocation_pct == .5
    s.trading_style = 'swing'
    real_accounting.apply_session_capital(s, 50000, on_start=True)
    assert s.session_capital == 10000


def test_saved_label_percentages_update_and_snapshot_labels_use_current_capital(monkeypatch, isolated):
    from app.services import real_broker_state, trade_label_service as labels
    row = dict(session_id='session', round_trip_index=0, user_id=USER, session_type='real',
               round_trip_pnl=-150, round_trip_pnl_pct=-18.45, actual_strategy='keep this')
    monkeypatch.setattr(real_broker_state, 'read_labels', lambda *_: [row])
    monkeypatch.setattr(real_broker_state, 'projected_labels', lambda *_: None)
    isolated.update_item.side_effect = None
    labels.rebase_real_day_labels('session', 28713)
    saved = isolated.update_item.call_args.kwargs
    percentage = float(saved['ExpressionAttributeValues'][':pct'])
    assert percentage == round(-150/28713*100, 4)
    assert saved['UpdateExpression'] == 'SET round_trip_pnl_pct = :pct'
    assert saved['Key'] == {'session_id':'session', 'round_trip_index':0}
    monkeypatch.setattr(labels, '_load_session', lambda _: {'session_capital':28713})
    result = labels._current_real_day_label_percentages([row])[0]
    assert result['round_trip_pnl_pct'] == percentage
    assert row['round_trip_pnl_pct'] == -18.45


def test_restart_capital_and_restriction_survive_rebuild(monkeypatch, isolated):
    from app.services import real_broker_state
    s = restricted_session(monkeypatch)
    s.real_day_allocation_pct = .5
    monkeypatch.setattr(simulation, '_upsert_session_to_db', persist_session)
    real_accounting.apply_session_capital(s, 28713, on_start=True)
    saved = isolated.put_item.call_args.kwargs['Item']
    assert float(saved['session_capital']) == 28713
    assert saved['real_guardrail_state']['ban_active'] is False
    monkeypatch.setattr(trading, 'reload_trades_from_db', Mock())
    monkeypatch.setattr(real_broker_state, 'restore_orders', Mock())
    restored = simulation.rebuild_session_from_db(saved, USER, read_only=True)
    assert restored.session_capital == 28713 and not restored.guardrail_ban_active
    assert restored.guardrail_block_until_bar == 999 and restored.real_day_allocation_pct == .5


@pytest.mark.asyncio
async def test_desktop_real_start_uses_shared_capital_update(monkeypatch, isolated):
    from types import SimpleNamespace
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from app.routers import desktop_trading as desktop
    s = restricted_session(monkeypatch)
    s.date = datetime.now(ZoneInfo('Asia/Kolkata')).date().isoformat()
    monkeypatch.setattr('app.dependencies.require_real_trading_access', Mock())
    monkeypatch.setattr(real_accounting, 'refresh', AsyncMock(return_value={'session_capital':28713}))
    async def shared_start(request, user, **kwargs):
        assert request.session_type == 'real' and kwargs['desktop_independent']
        await real_accounting.restart_capital(s, Mock())
        return SimpleNamespace(session_id=s.session_id)
    shared = AsyncMock(side_effect=shared_start)
    monkeypatch.setattr(desktop.simulation_router, 'start_with_paper_claim', shared)
    monkeypatch.setattr(desktop, '_require_session', lambda *_: s)
    monkeypatch.setattr(desktop, '_snapshot', lambda *_: {'capital':s.session_capital, 'banned':s.guardrail_ban_active})
    result = await desktop._start_desktop_trading(desktop.DesktopTradingStartRequest(
        symbol=s.symbol, date=s.date, desktop_mode='real', instrument_type='equity'), USER)
    assert result['capital'] == 28713 and not result['banned']
    shared.assert_awaited_once()
