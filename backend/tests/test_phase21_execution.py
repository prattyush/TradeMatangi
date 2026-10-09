"""Synthetic broker boundary: identities, non-retrying writes and single-engine claims."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock
import boto3
import pytest
from moto import mock_aws
from app.models.schemas import Order, TradeSide, SimulationState, SimulationStartRequest
from app.services import execution_broker, kite_execution, simulation, real_sessions, broker_reports


def order(**kwargs):
    return Order(session_id='s', user_id='u', symbol='NIFTY', side=TradeSide.BUY, quantity=65,
                 trigger_price=100, limit_price=100, created_at=1, **kwargs)


def test_neutral_identity_preserves_kotak_and_never_labels_kite_as_kotak():
    old = order(kotak_order_id='old')
    assert old.broker_order_id == 'old'
    old.broker_order_id = 'replacement'
    assert old.kotak_order_id == 'replacement'
    old.kotak_order_id = None
    assert old.broker_order_id is None
    kite = order(execution_broker='kite', broker_order_id='old')
    assert kite.kotak_order_id is None
    assert kite.model_dump()['broker_order_id'] == 'old'


def test_execution_routing_ignores_chart_provider(monkeypatch):
    kotak, kite = object(), object()
    monkeypatch.setattr('app.services.kotak_service.get_service', lambda: kotak)
    monkeypatch.setattr(kite_execution, 'get_service', lambda: kite)
    assert execution_broker.get_service(SimpleNamespace(execution_broker='KotakNeo', paper_stream_source='kite')) is kotak
    assert execution_broker.get_service(SimpleNamespace(execution_broker='Kite', paper_stream_source='breeze')) is kite
    with pytest.raises(ValueError): execution_broker.get_service('unknown')


def service(monkeypatch):
    value = kite_execution.KiteExecutionService()
    client = Mock()
    client.place_order.return_value = 'broker-1'
    monkeypatch.setattr(value, '_get_client', lambda: client)
    metadata = {'tradingsymbol': 'NIFTY26O0825000CE', 'exchange': 'NFO', 'instrument_type': 'CE',
                'expiry': '2026-10-08', 'strike': 25000, 'tick_size': '.05', 'lot_size': '65', 'instrument_token': '10', 'name': 'NIFTY'}
    monkeypatch.setattr(value, 'instrument', lambda *args: metadata)
    monkeypatch.setattr(value, '_metadata', lambda raw: metadata)
    return value, client


def test_kite_places_exact_contract_and_validates_units(monkeypatch):
    broker, client = service(monkeypatch)
    assert broker.place_options_limit_order('NIFTY', 'B', 65, 100.03, 'CE', 25000, '2026-10-08', 'tm123') == 'broker-1'
    payload = client.place_order.call_args.kwargs
    assert payload['tradingsymbol'] == 'NIFTY26O0825000CE'
    assert payload['price'] == 100.05 and payload['quantity'] == 65
    assert payload['product'] == 'MIS' and payload['variety'] == 'regular'
    with pytest.raises(Exception): broker.place_options_limit_order('NIFTY', 'B', 66, 100, 'CE', 25000, '2026-10-08')
    assert client.place_order.call_count == 1


def test_uncertain_kite_write_is_sent_only_once(monkeypatch):
    broker, client = service(monkeypatch)
    client.place_order.side_effect = TimeoutError('lost ACK')
    with pytest.raises(Exception, match='uncertain'):
        broker.place_limit_order('RELIND', 'B', 65, 100)
    assert client.place_order.call_count == 1


def test_kite_normalized_reports_do_not_store_legacy_ids(monkeypatch):
    broker, _ = service(monkeypatch)
    row = broker._normalize(dict(order_id='same-id', tradingsymbol='NIFTY26O0825000CE', exchange='NFO', transaction_type='BUY',
        order_type='LIMIT', status='COMPLETE', quantity=65, filled_quantity=65, average_price=100, price=100, product='MIS'))
    assert row['broker_order_id'] == 'same-id' and 'kotak_order_id' not in row
    assert row['strike'] == 25000 and row['expiry'] == '2026-10-08'
    execution = broker_reports.normalize_execution({**row, 'execution_id': 'trade-1', 'execution_time': '2026-10-07 10:00:00', 'price': 100})
    assert execution['execution_id'] == 'trade-1' and 'kotak_order_id' not in execution


@pytest.mark.asyncio
async def test_kite_callback_before_registration_replays_partial_fill(monkeypatch):
    broker, _ = service(monkeypatch)
    raw = dict(order_id='fast', tradingsymbol='NIFTY26O0825000CE', exchange='NFO', transaction_type='BUY',
        order_type='LIMIT', status='OPEN', quantity=130, filled_quantity=65, average_price=100, price=100, product='MIS')
    broker.on_order(raw)
    filled = Mock()
    broker.register_fill_callback('fast', filled, asyncio.get_running_loop())
    await asyncio.sleep(0)
    filled.assert_called_once_with('fast', 'BUY', 65, 100)
    broker.on_order({**raw, 'filled_quantity': 0})
    await asyncio.sleep(0)
    assert filled.call_count == 1


@pytest.fixture
def claim_table(monkeypatch):
    with mock_aws():
        db = boto3.resource('dynamodb', region_name='ap-south-1')
        table = db.create_table(TableName='WalletLedgers', KeySchema=[{'AttributeName':'user_id','KeyType':'HASH'}, {'AttributeName':'ledger_id','KeyType':'RANGE'}],
            AttributeDefinitions=[{'AttributeName':'user_id','AttributeType':'S'}, {'AttributeName':'ledger_id','AttributeType':'S'}], BillingMode='PAY_PER_REQUEST')
        monkeypatch.setattr(real_sessions, '_table', lambda: table)
        monkeypatch.setattr('app.services.real_trading_day.market_date', lambda: '2026-10-09')
        monkeypatch.setattr('app.dependencies.require_real_trading_access', lambda user: user)
        monkeypatch.setattr('app.services.user_settings_service.get_settings', lambda *a, **k: {'real_execution_broker': 'kite'})
        monkeypatch.setattr(simulation, '_sessions', {})
        yield table


@pytest.mark.asyncio
async def test_concurrent_real_starts_share_one_execution_engine(claim_table):
    calls = []
    request = SimulationStartRequest(symbol='RELIND', date='2026-10-09', session_type='real')
    async def create():
        calls.append('created')
        await asyncio.sleep(.01)
        session = simulation.SimulationSession('session-1', 'RELIND', request.date, '09:15:00', 1,
            user_id='u', session_type='real', execution_broker='Kite', state=SimulationState.RUNNING)
        simulation._sessions[session.session_id] = session
        return SimpleNamespace(session_id=session.session_id)
    first, second = await asyncio.gather(real_sessions.start(request, 'u', create), real_sessions.start(request, 'u', create))
    assert first.session_id == second.session_id == 'session-1'
    assert calls == ['created']
    assert real_sessions.active('u')['session_id'] == 'session-1'
    with pytest.raises(Exception, match='Close the active'):
        await real_sessions.start(SimulationStartRequest(symbol='TATPOW', date=request.date, session_type='real'), 'u', create)


def test_claim_cannot_be_released_by_a_different_operation(claim_table):
    real_sessions._claim('u', 'owner')
    real_sessions._finish('u', 'owner', 's')
    stale = SimpleNamespace(user_id='u', session_id='s', real_claim_token='stale')
    with pytest.raises(Exception): real_sessions.release(stale)
    assert real_sessions.active('u')['session_id'] == 's'


def test_expired_engine_cannot_route_another_broker_write(monkeypatch):
    broker = object()
    monkeypatch.setattr(kite_execution, 'get_service', lambda: broker)
    stale = SimpleNamespace(execution_broker='Kite', real_engine_lease_required=True, real_engine_valid_until=0)
    with pytest.raises(RuntimeError, match='ownership expired'):
        execution_broker.get_service(stale)
    assert execution_broker.get_service(stale, allow_expired=True) is broker


def test_unknown_submission_is_durable_and_cannot_be_resent(monkeypatch):
    from app.services.broker_order_service import submit_once
    from app.services import order_service
    writes = Mock()
    monkeypatch.setattr(order_service, '_write_order_to_db', writes)
    session = SimpleNamespace(execution_broker='Kite', broker_account_id='kite-account')
    pending = order()
    method = Mock(side_effect=TimeoutError('lost ACK'))
    with pytest.raises(TimeoutError): submit_once(session, pending, method, symbol='NIFTY')
    assert pending.recovery_state == 'unknown' and pending.analytics['broker_tag'].isalnum()
    with pytest.raises(Exception, match='unconfirmed'): submit_once(session, pending, method, symbol='NIFTY')
    assert method.call_count == 1
    assert writes.call_count == 2


def test_refresh_adopts_unknown_kite_submission_once(monkeypatch):
    from app.services import order_service, real_broker_state
    session = simulation.SimulationSession('s', 'RELIND', '2026-10-09', '09:15:00', 1,
        user_id='u', session_type='real', execution_broker='Kite', broker_account_id='kite-account')
    pending = Order(session_id='s', user_id='u', symbol='RELIND', side=TradeSide.BUY, quantity=10,
                    order_type='LIMIT', trigger_price=100, limit_price=100, created_at=1,
                    execution_broker='kite', recovery_state='unknown', analytics={'broker_tag':'tm-unique'})
    monkeypatch.setattr(order_service, '_orders', {'s': {pending.order_id: pending}})
    row = broker_reports.normalize_order(dict(broker_order_id='confirmed', execution_broker='kite',
        symbol='RELIANCE', side='BUY', quantity=10, status='open', order_type='LIMIT', limit_price=100,
        product='MIS', exchange='nse_cm', tag='tm-unique'))
    adopted = real_broker_state.build_orders(session, [row])
    assert len(adopted) == 1
    result = adopted[pending.order_id]
    assert result.broker_order_id == 'confirmed' and result.kotak_order_id is None
    assert result.recovery_state is None


@pytest.mark.asyncio
async def test_confirmed_close_publishes_terminal_book_before_disposal(monkeypatch):
    import json
    from app.services import real_close, trading
    session = simulation.SimulationSession('s', 'RELIND', '2026-10-09', '09:15:00', 1,
        user_id='u', session_type='real', execution_broker='Kite', state=SimulationState.RUNNING)
    monkeypatch.setattr(trading, 'get_trades', lambda sid: [])
    def dispose(current, **kwargs):
        current.state = SimulationState.ENDED
        current.queue.close()
    monkeypatch.setattr(simulation, 'stop_session', dispose)
    await real_close.finish(session)
    _, payload = await session.queue.get_after(None)
    event = json.loads(payload)
    assert event['type'] == 'session_ended' and event['session_id'] == 's'
    assert event['positions']['equity']['quantity'] == 0 and event['open_orders'] == []


@pytest.mark.asyncio
async def test_real_wallet_reset_is_rejected_before_mutation(monkeypatch):
    from fastapi import HTTPException
    from app.routers import desktop_trading
    from app.models.schemas import WalletResetRequest
    session = simulation.SimulationSession('s', 'RELIND', '2026-10-09', '09:15:00', 1,
        user_id='u', session_type='real', state=SimulationState.ENDED)
    monkeypatch.setattr(simulation, 'get_session', lambda sid: session)
    reset = Mock()
    monkeypatch.setattr('app.services.practice_wallets.reset', reset)
    with pytest.raises(HTTPException) as failure:
        await desktop_trading.reset_wallet('s', WalletResetRequest(amount=100000), 'u')
    assert failure.value.status_code == 403 and not reset.called


def test_desktop_real_does_not_accept_legacy_identity_header():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import desktop_trading
    app = FastAPI()
    app.include_router(desktop_trading.router)
    response = TestClient(app).post('/api/desktop/v1/trading/start', headers={'X-User-Id':'u'},
        json={'desktop_mode':'real','symbol':'RELIND','date':'2026-10-09','session_type':'real'})
    assert response.status_code == 401


def test_underlying_action_freezes_all_right_contracts_at_trigger(monkeypatch):
    from app.services import strategy_service, trading
    session = simulation.SimulationSession('s', 'NIFTY', '2026-10-09', '09:15:00', 1, user_id='u',
        instrument_type='options', strike_ce=25000, strike_pe=24900, expiry='2026-10-15')
    opened = [dict(right='CE', strike=25000, expiry='2026-10-15'), dict(right='CE', strike=25050, expiry='2026-10-15'),
              dict(right='PE', strike=24900, expiry='2026-10-15')]
    monkeypatch.setattr(trading, 'get_open_option_contracts', lambda *a: list(opened))
    monkeypatch.setattr(strategy_service, '_write_strategy_to_db', lambda *a: None)
    monkeypatch.setattr(strategy_service, '_registry', {'s': []})
    parent = strategy_service.start_strategy(session, 'UnderlyingTargetProfit', 'CE',
        {'contract_scope':'all_right','underlying_reference_side':'LONG','target_profit_value':25100})
    strategy_service._expand_underlying_exit(parent, session, 25100, 1)
    children = [s for s in strategy_service._registry['s'] if s is not parent]
    assert {s.metadata['desktop_strike'] for s in children} == {25000, 25050}
    assert all(s.metadata['underlying_force_trigger'] and s.metadata['contract_scope'] == 'exact' for s in children)
    opened.append(dict(right='CE',strike=25100,expiry='2026-10-15'))
    strategy_service._expand_underlying_exit(parent, session, 25110, 2)
    assert len(strategy_service._registry['s']) == 3


def test_kite_equity_scope_uses_kite_symbol_not_kotak_suffix():
    session = simulation.SimulationSession('s', 'RELIND', '2026-10-09', '09:15:00', 1,
        instrument_type='equity', execution_broker='Kite')
    assert broker_reports.in_scope(session, {'symbol':'RELIANCE'})
    assert not broker_reports.in_scope(session, {'symbol':'RELIANCE-EQ'})
    assert not broker_reports.in_scope(session, {'symbol':'TATPOWER'})


def test_kite_margin_components_are_not_double_counted(monkeypatch):
    broker = kite_execution.KiteExecutionService()
    monkeypatch.setattr(broker, '_read', lambda *a, **k: {'net':900, 'utilised':{'debits':100, 'span':70, 'exposure':30, 'm2m_realised':10},
        'available':{'opening_balance':1000,'intraday_payin':20,'collateral':0,'adhoc_margin':0}})
    assert broker.get_limits() == {'Net':900,'MarginUsed':100,'RealizedPnl':10,'DayStartCapital':1020}


def test_live_kite_equity_fill_reconstructs_actual_position():
    from app.services import fifo_positions
    session = simulation.SimulationSession('s', 'RELIND', '2026-10-09', '09:15:00', 1,
        instrument_type='equity', execution_broker='Kite')
    session._fifo_executions = []
    filled = Order(session_id='s', user_id='u', symbol='RELIND', side='BUY', quantity=10,
        trigger_price=100, limit_price=100, created_at=1, broker_order_id='equity-fill', execution_broker='kite', broker_filled_quantity=10)
    row = fifo_positions.live_delta(session, filled, 10, 100)
    assert row['symbol'] == 'RELIANCE' and row['broker_order_id'] == 'equity-fill'
    positions = fifo_positions.positions(session, session._fifo_executions)
    assert len(positions) == 1 and positions[0]['quantity'] == 10 and positions[0]['side'] == 'LONG'


def test_kite_stock_option_identity_uses_instrument_underlying_name():
    session = simulation.SimulationSession('s', 'RELIND', '2026-10-09', '09:15:00', 1,
        instrument_type='options', execution_broker='Kite')
    row = {'symbol': 'RELIANCE26OCT2500CE', 'right': 'CE', 'strike': 2500, 'expiry': '2026-10-27'}
    assert broker_reports.in_scope(session, row)
    assert broker_reports.contract(session, row) == {'right':'CE','strike':2500,'expiry':'2026-10-27'}


def test_kotak_account_identity_remains_bound_to_authenticated_client(monkeypatch):
    from app.services import kotak_service
    broker = kotak_service.KotakNeoService()
    broker._authenticated_account = 'original-account'
    monkeypatch.setattr(kotak_service, '_read_kotak_credentials', lambda: {'ucc': 'replacement'})
    assert broker.account_identity() == 'original-account'
    broker.shutdown()
    assert broker.account_identity() != 'original-account'


@pytest.mark.asyncio
async def test_refresh_rejects_changed_account_before_mutating_book(monkeypatch):
    from app.services import real_broker_state
    session = SimpleNamespace(execution_broker='kite', broker_account_id='original-account')
    broker = Mock()
    broker.account_identity.return_value = 'different-account'
    with pytest.raises(ValueError, match='Broker account changed'):
        await real_broker_state.refresh(session, broker)
    broker.get_orders.assert_not_called()
