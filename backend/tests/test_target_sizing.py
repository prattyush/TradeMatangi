"""Target % uses current quotes, Capital lot rules and existing market execution."""
from unittest.mock import Mock
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from app.models.schemas import PlaceOrderRequest, Position, OrderType
from app.routers import orders, desktop_trading
from app.services import target_sizing, execution_analytics as analytics, order_service, trading
from tests.test_execution_gaps import real  # noqa: F401


def request(session, **updates):
    return PlaceOrderRequest(**dict(session_id=session.session_id,side='BUY',order_type='LIMIT',
        limit_price=999,market_order=True,target_profit_pct=2,sizing_target_price=110,
        entry_sl_price=90,group_id='target-sizing',**updates))


@pytest.mark.parametrize('margin', [1,.2])
@pytest.mark.parametrize('side,target', [('BUY',110),('SELL',90)])
def test_profit_size_is_not_multiplied_by_leverage(margin,side,target):
    assert target_sizing.quantity(symbol='TATPOW',capital=100000,target_pct=2,entry=100,
        target=target,side=side,reservation_price=101,wallet=100000,lot_size=1,margin_rate=margin)==200


def test_complete_lots_and_capital_minimum_lot():
    def size(pct):
        return target_sizing.quantity(symbol='NIFTY',capital=100000,target_pct=pct,entry=100,
            target=110,side='BUY',reservation_price=101,wallet=100000,lot_size=65,margin_rate=1)
    assert size(2)==195
    assert size(.01)==65


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['sim','stepwise','paper','real'])
@pytest.mark.parametrize('surface', ['website','desktop'])
@pytest.mark.parametrize('option', [False,True])
async def test_target_entry_uses_server_quote_and_records_sizing(real,monkeypatch,mode,surface,option):
    session, broker, _ = real
    session.session_type=mode;session.session_capital=100000
    monkeypatch.setattr(orders,'_wallet_balance_for_session',lambda _:100000)
    monkeypatch.setattr(trading,'get_position',lambda *a,**k:Position(symbol=session.symbol,side="FLAT",quantity=0,avg_entry_price=0))
    contract={}
    if option:
        session.instrument_type='options';session.symbol='NIFTY';session.expiry='2026-10-08'
        session.strike_ce=24000;session.last_price_ce=100
        contract=dict(right='CE',strike=24000,expiry=session.expiry)
        item=dict(symbol=session.symbol,**contract,contract_key=f'{session.symbol}:{session.expiry}:24000:CE')
        session.desktop_contracts=[item]
        session.desktop_contract_quotes={item['contract_key']:{**item,'price':100,'timestamp':int(session.current_time),'source':'test_quote'}}
        monkeypatch.setattr(desktop_trading,'_refresh_contract_quotes',lambda _:session.desktop_contract_quotes)
        monkeypatch.setattr(desktop_trading,'_paper_chart_quote',lambda *a:session.desktop_contract_quotes[item['contract_key']])
    if surface=='website':
        order=await orders.place_order(request(session,**contract))
    else:
        # Immediate checks are covered separately; inspect the placement payload here.
        monkeypatch.setattr('app.services.simulation._emit_tick_and_check_orders',lambda *a,**k:[])
        order=await desktop_trading.place_chart_order(session.session_id,desktop_trading.ChartOrderIntent(
            symbol=session.symbol,side='BUY',intent='market',target_profit_pct=2,sizing_target_price=110,
            entry_sl_price=90,group_id='target-sizing',**contract),session.user_id)
    assert order.quantity==(195 if option else 200)
    assert order.quote_price==100 and order.limit_price==101 and order.entry_sl_price==90
    assert order.order_type==OrderType.LIMIT and order.market_order
    assert order.analytics['entry_method']=='MARKET'
    assert order.analytics['sizing_method']=='TARGET_PERCENT' and order.analytics['requested_pct']==2
    assert order.analytics['requested_budget']==2000
    assert order.analytics['sizing_target_price']==110
    assert order.analytics['projected_target_profit']==order.quantity*10
    assert order.analytics['effective_target_pct']==pytest.approx(order.quantity*.01)


@pytest.mark.asyncio
@pytest.mark.parametrize('updates', [dict(sizing_target_price=100),dict(sizing_target_price=95),dict(quantity=1),dict(funds_ratio_pct=.2),dict(risk_pct=2),dict(risk_ratio_pct=.02),dict(market_order=False),dict(entry_sl_price=None)])
async def test_invalid_target_requests_do_not_place_orders(real,monkeypatch,updates):
    session,_,_=real
    values=request(session).model_dump();values.update(updates)
    with pytest.raises(HTTPException): await orders.place_order(PlaceOrderRequest(**values))
    assert not order_service.get_open_orders(session.session_id)


@pytest.mark.asyncio
async def test_insufficient_funds_uses_existing_reservation_failure(real,monkeypatch):
    from app.services.wallet_service import InsufficientFundsError
    session,_,_=real
    monkeypatch.setattr(orders,'_wallet_balance_for_session',lambda _:1)
    monkeypatch.setattr('app.services.wallet_service.debit',Mock(side_effect=InsufficientFundsError(1,4040)))
    with pytest.raises(HTTPException) as exc: await orders.place_order(request(session))
    assert exc.value.status_code==402
    assert not order_service.get_open_orders(session.session_id)


def test_fills_recompute_target_projection_without_comparing_allocation_to_profit_budget():
    meta=dict(sizing_method='TARGET_PERCENT',side='BUY',capital=100000,requested_budget=2000,
        sizing_target_price=110,margin_rate=.2,initial_stop=90)
    first=analytics.filled(meta,101,65)
    assert first['projected_target_profit']==585 and first['effective_target_pct']==.585
    assert first['budget_exceeded'] is False
    combined=analytics.filled(meta,102,195)
    assert combined['projected_target_profit']==1560
    assert combined['effective_target_pct']==1.56
    restored=analytics.normalize_metadata({k:str(v) if isinstance(v,(int,float)) else v for k,v in combined.items()})
    assert restored['sizing_target_price']==110 and restored['projected_target_profit']==1560


@pytest.mark.parametrize('field,value', [('target_profit_pct',float('nan')),('target_profit_pct',0),('target_profit_pct',101),('sizing_target_price',float('inf'))])
def test_target_values_are_finite_and_bounded(field,value):
    with pytest.raises(ValidationError):
        PlaceOrderRequest(session_id='s',side='BUY',**{field:value})


@pytest.mark.asyncio
@pytest.mark.parametrize('issue',['no_quote','wrong_contract','future_quote','ended','missing_target'])
async def test_quote_and_session_guards(real,monkeypatch,issue):
    from app.models.schemas import SimulationState
    session,_,_=real
    values=request(session).model_dump()
    if issue=='no_quote': session.last_price=0
    if issue=='wrong_contract':
        session.instrument_type='options';session.expiry='2026-10-08';session.strike_ce=24000
        values.update(right='CE',strike=24100,expiry=session.expiry)
    if issue=='future_quote':
        session.session_type='stepwise';session.instrument_type='options';session.expiry='2026-10-08';session.strike_ce=24000
        values.update(right='CE',strike=24000,expiry=session.expiry)
        session.desktop_contract_quotes={f'{session.symbol}:{session.expiry}:24000:CE':{'price':100,'timestamp':int(session.current_time)+1}}
    if issue=='ended':session.state=SimulationState.ENDED
    if issue=='missing_target':values['sizing_target_price']=None
    with pytest.raises(HTTPException):await orders.place_order(PlaceOrderRequest(**values))
    assert not order_service.get_open_orders(session.session_id)


def test_target_sizing_survives_partial_fill_grouping_and_stats():
    from app.services.performance_service import build_cycles,report
    from tests.test_phase20_performance import SESSION,fill
    meta=dict(version=1,side='BUY',sizing_method='TARGET_PERCENT',entry_method='MARKET',client='website',
        action_id='target-entry',capital=100000,requested_pct=2,requested_budget=2000,
        sizing_target_price=110,reference_price=100,margin_rate=1,initial_stop=90,initial_risk=650)
    rows=[fill(1,'BUY',65,100,analytics=meta),fill(2,'BUY',65,102,analytics=meta),
          fill(3,'SELL',130,110,analytics={'action_id':'manual-exit','exit_method':'MARKET'})]
    cycles=build_cycles({**SESSION,'session_capital':100000},rows)
    entry=cycles[0]['entries'][0]
    assert entry['quantity']==130 and entry['average_price']==101
    assert entry['sizing_method']=='TARGET_PERCENT' and entry['entry_method']=='MARKET'
    assert entry['analytics']['projected_target_profit']==1170
    assert entry['analytics']['effective_target_pct']==1.17
    assert any(row['key']=='TARGET_PERCENT' for row in report(cycles)['comparisons']['sizing'])


@pytest.mark.parametrize('lot',[1,20,65])
@pytest.mark.parametrize('lots',[1,2,3,10])
def test_exact_lot_boundary_is_not_lost_to_float_conversion(lot,lots):
    pct=lots*lot*10/100000*100
    assert target_sizing.quantity(symbol='TEST',capital=100000,target_pct=pct,entry=118.5,
        target=128.5,side='BUY',reservation_price=119.7,wallet=1000000,lot_size=lot,margin_rate=.2)==lot*lots
