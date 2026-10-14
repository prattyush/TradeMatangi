from types import SimpleNamespace
import csv
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
