from types import SimpleNamespace
import csv
import pytest
from app.models.schemas import Order, SimulationStartRequest
from app.services import broker_reports, options_service, kite_service, breeze_master, simulation


def test_integer_contract_keys_remain_integer_after_float_inputs():
    request = SimulationStartRequest(symbol='CANBK', date='2026-10-09', strike=125.0)
    assert type(request.strike) is int
    session = simulation.SimulationSession('s','CANBK','2026-10-09','09:15:00',1,strike=125.0,strike_ce=125.5)
    assert type(session.strike) is int and session.strike_ce == 125.5
    order = Order(session_id='s',user_id='u',symbol='CANBK',side='BUY',quantity=675,created_at=1,trigger_price=10,limit_price=10,strike=125.5)
    assert order.strike == 125.5


def test_fractional_broker_strike_does_not_collide_with_neighbour():
    session = SimpleNamespace(symbol='CANBK',instrument_type='options',execution_broker='kite',expiry='2026-10-27',strike_ce=125,strike_pe=125)
    row = broker_reports.normalize_order({'symbol':'CANBK26OCT125.5CE','right':'CE','strike':125.5,'expiry':session.expiry})
    assert row['strike'] == 125.5
    assert broker_reports.contract(session,row)['strike'] == 125.5
    assert breeze_master._normalise_strike('125.5') == 125.5
    assert options_service.get_atm_strike('CANBK',125.5) == 125.5


def test_kite_master_lookup_requires_exact_fractional_strike(tmp_path):
    path = tmp_path/'master.csv'
    with path.open('w',newline='') as handle:
        writer=csv.DictWriter(handle,fieldnames=['instrument_type','strike','expiry','name','instrument_token'])
        writer.writeheader()
        for strike,token in [(125,1),(125.25,2),(125.5,3)]:
            writer.writerow({'instrument_type':'CE','strike':strike,'expiry':'2026-10-27','name':'CANBK','instrument_token':token})
    assert kite_service._lookup_options_token(path,'CANBK','2026-10-27',125.25,'CE') == 2
    assert kite_service._lookup_options_token(path,'CANBK','2026-10-27',125.5,'CE') == 3


def test_kotak_legacy_stock_key_resolves_exchange_option_underlying():
    session = SimpleNamespace(symbol='RELIND',instrument_type='options',execution_broker='kotak')
    row={'symbol':'RELIANCE26OCT2500CE','right':'CE','strike':2500,'expiry':'2026-10-27'}
    assert broker_reports.in_scope(session,row)
    assert broker_reports.contract(session,row)=={'right':'CE','strike':2500,'expiry':'2026-10-27'}


def test_monthly_symbol_without_row_or_master_expiry_falls_back_to_session_expiry():
    """A settled/older contract can roll off Kotak's current instrument
    master, with its own report row carrying no expiry field at all
    (reproduces the production UnknownContractError for NIFTY26OCT22300PE/
    NIFTY26OCT23200CE). The session's own expiry is a safe fallback as long
    as it independently matches the symbol's encoded year/month."""
    session = SimpleNamespace(symbol='NIFTY', instrument_type='options', execution_broker='kotak', expiry='2026-10-27')
    row = {'symbol': 'NIFTY26OCT22300PE', 'right': 'PE', 'strike': 22300, 'expiry': ''}
    assert broker_reports.contract(session, row) == {'right': 'PE', 'strike': 22300, 'expiry': '2026-10-27'}


def test_monthly_symbol_without_any_expiry_source_still_raises():
    session = SimpleNamespace(symbol='NIFTY', instrument_type='options', execution_broker='kotak', expiry=None)
    row = {'symbol': 'NIFTY26OCT22300PE', 'right': 'PE', 'strike': 22300, 'expiry': ''}
    import pytest
    from app.services.broker_reports import UnknownContractError
    with pytest.raises(UnknownContractError):
        broker_reports.contract(session, row)


def test_monthly_symbol_session_expiry_mismatch_still_raises():
    """A different session expiry (e.g. November) must not be wrongly
    accepted for an October contract."""
    session = SimpleNamespace(symbol='NIFTY', instrument_type='options', execution_broker='kotak', expiry='2026-11-24')
    row = {'symbol': 'NIFTY26OCT22300PE', 'right': 'PE', 'strike': 22300, 'expiry': ''}
    import pytest
    from app.services.broker_reports import UnknownContractError
    with pytest.raises(UnknownContractError):
        broker_reports.contract(session, row)


def _unresolvable_execution():
    """A monthly-style execution whose contract can never resolve for this
    session (session.expiry is a different month, no master supplied) --
    reproduces the exact UnknownContractError shape from production."""
    return broker_reports.normalize_execution(dict(flId='fill-bad', nOrdNo='order-bad', fldQty=75, flPrc=50,
        trnsTp='B', trdSym='NIFTY26OCT22300PE', exSeg='nse_fo', flDt='09-Oct-2026', flTm='10:05:00'))


def _resolvable_execution():
    """A weekly-style execution that resolves its contract directly from
    the symbol, independent of session.expiry/master."""
    return broker_reports.normalize_execution(dict(flId='fill-good', nOrdNo='order-good', fldQty=65, flPrc=100,
        trnsTp='B', trdSym='NIFTY26O0924000CE', exSeg='nse_fo', flDt='09-Oct-2026', flTm='10:00:00'))


def test_aggregate_isolates_one_unresolvable_contract_from_the_rest():
    """One execution whose contract can't be resolved must not abort the
    whole aggregate() call for every other resolvable execution -- only
    refresh()'s own strict=False pass gets this behavior; the default
    (strict=True) preserves the original raise, for callers (protection/
    recovery) that have their own retry-with-master handling."""
    from app.services import real_broker_state
    session = SimpleNamespace(session_id='s', user_id='u', symbol='NIFTY', date='2026-10-09',
        instrument_type='options', execution_broker='kotak', expiry='2026-11-24', brokerage_per_order=0)
    good, bad = _resolvable_execution(), _unresolvable_execution()
    with pytest.raises(broker_reports.UnknownContractError):
        real_broker_state.aggregate(session, [good, bad], 'account')
    unresolved = []
    trades = real_broker_state.aggregate(session, [good, bad], 'account', strict=False, unresolved=unresolved)
    assert [t.broker_order_id for t in trades] == ['order-good']
    assert len(unresolved) == 1 and unresolved[0]['execution_id'] == 'fill-bad'


def test_build_orders_isolates_one_unresolvable_contract_from_the_rest():
    """Same isolation guarantee as aggregate(), for a broker order-report
    row instead of an execution."""
    from app.services import real_broker_state, order_service
    session = SimpleNamespace(session_id='build-orders-isolation', user_id='u', symbol='NIFTY',
        instrument_type='options', execution_broker='kotak', expiry='2026-11-24')
    order_service._orders[session.session_id] = {}
    try:
        good = broker_reports.normalize_order(dict(nOrdNo='order-good', ordSt='open', trnsTp='B', qty=65,
            fldQty=0, trdSym='NIFTY26O0924000CE', exSeg='nse_fo', prcTp='L', prc=100, ordDtTm='09-Oct-2026 10:00:00'))
        bad = broker_reports.normalize_order(dict(nOrdNo='order-bad', ordSt='open', trnsTp='B', qty=75,
            fldQty=0, trdSym='NIFTY26OCT22300PE', exSeg='nse_fo', prcTp='L', prc=50, ordDtTm='09-Oct-2026 10:05:00'))
        with pytest.raises(broker_reports.UnknownContractError):
            real_broker_state.build_orders(session, [good, bad])
        unresolved = []
        result = real_broker_state.build_orders(session, [good, bad], strict=False, unresolved=unresolved)
        assert {o.broker_order_id for o in result.values()} == {'order-good'}
        assert len(unresolved) == 1 and unresolved[0]['broker_order_id'] == 'order-bad'
    finally:
        order_service._orders.pop(session.session_id, None)
