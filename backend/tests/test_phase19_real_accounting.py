"""Account-wide gross cash accounting; no broker orders or market access."""
from unittest.mock import MagicMock
import pytest
from app.services import real_accounting as accounting, wallet_service, broker_reports
from app.services.kotak_service import KotakError
from tests.test_phase19_broker_wallet import isolated, USER, DATE


def execution(identity, side, qty, price, symbol='ABC-EQ', product='MIS', time='10:00:00', **extra):
    return broker_reports.normalize_execution(dict(flId=identity, nOrdNo=identity, fldQty=qty, flPrc=price,
        trnsTp=side, trdSym=symbol, prod=product, exSeg='nse_cm', flDt='01-Oct-2026', flTm=time, **extra))


def test_profit_loss_partial_exits_and_reversals():
    rows = [execution('b', 'B', 10, 100, time='09:00:00'),
            execution('s', 'S', 15, 120, time='10:00:00'),
            execution('cover', 'B', 2, 110, time='11:00:00')]
    assert accounting.gross_realized_pnl(DATE, rows, []) == 220
    assert accounting.gross_realized_pnl(DATE, rows + rows, []) == 220
    assert accounting.gross_realized_pnl(DATE, [execution('b', 'B', 10, 100, time='09:00:00'),
        execution('s', 'S', 4, 80)], []) == -80


def test_weighted_average_and_multiple_contracts_products():
    rows = [execution('b1', 'B', 10, 100, time='09:00:00'),
            execution('b2', 'B', 10, 120, time='09:30:00'), execution('s', 'S', 10, 130),
            execution('external-buy', 'B', 10, 50, symbol='OTHER-EQ', product='CNC', time='09:00:00'),
            execution('external-sell', 'S', 10, 40, symbol='OTHER-EQ', product='CNC')]
    assert accounting.gross_realized_pnl(DATE, rows, []) == 100


@pytest.mark.parametrize('side,carry_field,amount_field,price,expected', [
    ('S', 'cfBuyQty', 'cfBuyAmt', 120, 100), ('B', 'cfSellQty', 'cfSellAmt', 80, 100)])
def test_carry_exit_uses_entry_cost(side, carry_field, amount_field, price, expected):
    position = dict(trdSym='ABC-EQ', prod='NRML', exSeg='nse_cm', **{carry_field: 10, amount_field: 1000})
    assert accounting.gross_realized_pnl(DATE, [execution('exit', side, 5, price, product='NRML')], [position]) == expected


def test_multipliers_are_cash_units_and_lot_size_is_not_applied_twice():
    rows = [execution('b', 'B', 2, 100, time='09:00:00', multiplier=5),
            execution('s', 'S', 2, 110, multiplier=5)]
    assert accounting.gross_realized_pnl(DATE, rows, []) == 100
    rows = [execution('b', 'B', 65, 100, time='09:00:00', lotSz=65), execution('s', 'S', 65, 110, lotSz=65)]
    assert accounting.gross_realized_pnl(DATE, rows, []) == 650


def test_earlier_day_and_unrealized_movements_do_not_change_realized_cash():
    row = execution('old', 'S', 10, 200)
    row['timestamp'] = broker_reports.wall_time('30-Sep-2026 10:00:00')
    position = dict(trdSym='ABC-EQ', exSeg='nse_cm', cfBuyQty=10, cfBuyAmt=1000, netQty=10, ltp=200)
    assert accounting.gross_realized_pnl(DATE, [row], [position]) == 0


@pytest.mark.parametrize('position', [
    dict(cfBuyQty=10), dict(cfBuyQty=10, cfBuyAmt='NaN'),
    dict(netQty=2), dict(flBuyQty=10, flSellQty=0),
])
def test_missing_carry_cost_or_inconsistent_reports_fail(position):
    with pytest.raises(ValueError):
        accounting.gross_realized_pnl(DATE, [], [dict(trdSym='ABC-EQ', exSeg='nse_cm', **position)])


def test_conflicting_duplicate_execution_fails():
    row = execution('buy', 'B', 10, 100)
    with pytest.raises(ValueError, match='Conflicting'):
        accounting.gross_realized_pnl(DATE, [row, {**row, 'price': 110}], [])


def test_account_day_baseline_survives_restart_reservations_and_cancellations(isolated):
    first = wallet_service.sync_real_account_funds(USER, DATE, 'account', 19200, 1200, 0, reason='start')
    assert first == {'balance': 19200, 'display_balance': 18000, 'session_capital': 18000}
    pending = wallet_service.sync_real_account_funds(USER, DATE, 'account', 14200, 1200, 5000, reason='refresh')
    assert pending == {'balance': 14200, 'display_balance': 13000, 'session_capital': 18000}
    wallet_service._ledgers.clear()  # process restart; persistent baseline remains
    closed = wallet_service.sync_real_account_funds(USER, DATE, 'account', 16800, -1200, 0, reason='start')
    assert closed == {'balance': 16800, 'display_balance': 18000, 'session_capital': 18000}
    assert wallet_service.get_real_wallet_snapshot(USER, DATE)['balance'] == 16800
    # Affordability still uses raw funds, even when the displayed wallet is higher.
    assert wallet_service.get_ledger_balance(USER, DATE, f'real:{DATE}', 'real') == 16800
    next_day = wallet_service.sync_real_account_funds(USER, '2026-10-02', 'account', 16800, 0, 0, reason='start')
    assert next_day['session_capital'] == 16800
    other = wallet_service.sync_real_account_funds(USER, DATE, 'other-account', 5000, 0, 0, reason='start')
    assert other['session_capital'] == 5000


@pytest.mark.asyncio
async def test_first_midday_start_recovers_open_cost_without_adding_it_twice(isolated):
    broker = MagicMock()
    broker.account_identity.return_value = 'account'
    broker.get_limits.return_value = {'Net': 14200, 'MarginUsed': 5000, 'PremiumPrsnt': 5000}
    broker.get_trade_history.return_value = [
        execution('b', 'B', 10, 100, time='09:00:00'), execution('s', 'S', 10, 220),
        execution('open', 'B', 50, 100, symbol='OPTION', time='11:00:00')]
    broker.get_positions.return_value = [dict(trdSym='OPTION', exSeg='nse_cm', netQty=50, ltp=150)]
    result = await accounting.refresh(USER, DATE, broker, reason='start')
    assert result == {'balance': 14200, 'display_balance': 13000, 'session_capital': 18000}
    broker.get_limits.assert_called_once()


@pytest.mark.asyncio
async def test_first_start_with_balance_and_sdk_no_data_reports(isolated, monkeypatch):
    import httpx
    from neo_api_client import NeoAPI
    from app.services import kotak_service
    monkeypatch.setenv("NEO_LOG_FILE_ENABLED", "false")
    requests = []
    def respond(request):
        requests.append(request.url.path)
        response = ({"stat": "Ok", "Net": "18000", "MarginUsed": "0"}
                    if request.url.path == "/limits" else
                    {"stCode": 5203, "errMsg": "No Data", "desc": "data not found", "stat": "Not_Ok"})
        return httpx.Response(200, json=response)
    client = NeoAPI(consumer_key="test", transport=httpx.MockTransport(respond))
    client.configuration.edit_token = "test-token"
    client.configuration.edit_sid = "test-sid"
    monkeypatch.setattr(client.configuration, "get_url_details", lambda method: f"https://broker.invalid/{method}")
    broker = kotak_service.KotakNeoService()
    broker._client, broker._authenticated = client, True
    monkeypatch.setattr(broker, "account_identity", lambda: "account")
    try:
        result = await accounting.refresh(USER, DATE, broker, reason="start")
        assert result == {"balance": 18000, "display_balance": 18000, "session_capital": 18000}
        assert sorted(requests) == ["/limits", "/positions", "/trade_report"]
        assert wallet_service.get_real_wallet_snapshot(USER, DATE, f"real:kotak:account:{DATE}")["balance"] == 18000
    finally:
        broker.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize('limits', [
    {'Net': 18000}, {'Net': 18000, 'MarginUsed': None}, {'Net': 18000, 'MarginUsed': float('nan')},
    {'Net': 18000, 'MarginUsed': True}, {'Net': 18000, 'MarginUsed': 'invalid'},
    {'Net': float('nan'), 'MarginUsed': 0}, {'Net': True, 'MarginUsed': 0},
])
async def test_bad_accounting_inputs_preserve_snapshot(isolated, limits):
    wallet_service.sync_real_account_funds(USER, DATE, 'account', 18000, 0, 0, reason='start')
    previous = wallet_service.get_real_wallet_snapshot(USER, DATE)
    broker = MagicMock()
    broker.account_identity.return_value = 'account'
    broker.get_limits.return_value = limits
    broker.get_trade_history.return_value = []
    broker.get_positions.return_value = []
    with pytest.raises(KotakError):
        await accounting.refresh(USER, DATE, broker, reason='refresh')
    assert wallet_service.get_real_wallet_snapshot(USER, DATE) == previous


@pytest.mark.asyncio
@pytest.mark.parametrize('existing_capital', [False, True])
@pytest.mark.parametrize('margin_used', [-250, '-250.00'])
async def test_negative_margin_used_after_exit_preserves_signed_broker_funds(isolated, existing_capital, margin_used):
    if existing_capital:
        wallet_service.sync_real_account_funds(USER, DATE, 'account', 20000, 0, 0, reason='start')
    broker = MagicMock()
    broker.account_identity.return_value = 'account'
    broker.get_limits.return_value = {'Net': 18350, 'MarginUsed': margin_used}
    broker.get_trade_history.return_value = [
        execution('buy', 'B', 10, 100, time='09:00:00'), execution('exit', 'S', 10, 110)]
    broker.get_positions.return_value = []
    result = await accounting.refresh(USER, DATE, broker, reason='refresh')
    # Existing formula: 18350 - 100 - 250 = 18000, never clamp or abs().
    assert result == {'balance': 18350, 'display_balance': 18250, 'session_capital': 20000 if existing_capital else 18000}
    row = isolated.get_item(Key={'user_id': USER, 'ledger_id': f'real:{DATE}'})['Item']
    assert float(row['committed_funds']) == -250
    assert float(row['gross_realized_pnl']) == 100
    assert wallet_service.get_real_wallet_snapshot(USER, DATE)['balance'] == 18350


def test_snapshot_write_failure_preserves_previous_accounting(isolated):
    wallet_service.sync_real_account_funds(USER, DATE, 'account', 18000, 0, 0, reason='start')
    previous = wallet_service.get_real_wallet_snapshot(USER, DATE)
    update = isolated.update_item.side_effect
    def fail_snapshot(**kwargs):
        if kwargs['Key']['ledger_id'] == f'real:{DATE}':
            raise RuntimeError('snapshot write failed')
        return update(**kwargs)
    isolated.update_item.side_effect = fail_snapshot
    with pytest.raises(RuntimeError):
        wallet_service.sync_real_account_funds(USER, DATE, 'account', 14200, 1200, 5000, reason='refresh')
    assert wallet_service.get_real_wallet_snapshot(USER, DATE) == previous
