from copy import deepcopy
import pytest
from app.services.day_journey import journeys
from app.services.performance_service import build_cycles, report


def cycle(i, pnl, **updates):
    return dict(cycle_id=str(i), session_id="session", user_id="user", mode="paper", date="2026-10-15", starting_capital=100,
                symbol="NIFTY", state="closed", entry_time=i*10+1, exit_time=i*10+9, net_pnl=pnl,
                entries=[dict(timestamp=i*10+1, analytics={})], **updates)


def test_cumulative_percent_and_zero_start():
    path=journeys([cycle(0,4),cycle(1,-2),cycle(2,4)])[0]
    assert [p["pnl_pct"] for p in path["points"]] == [4,2,6]
    assert path["max_drawdown_pct"]==2
    assert path["giveback_pct"]==0


@pytest.mark.parametrize("path,expected", [([4,-1,-5,2,10],9),([2,6,4,9,12],2)])
def test_comparison_paths(path,expected):
    increments=[v-(path[i-1] if i else 0) for i,v in enumerate(path)]
    result=journeys([cycle(i,v) for i,v in enumerate(increments)])[0]
    assert [p["pnl_pct"] for p in result["points"]]==path
    assert result["max_drawdown_pct"]==expected
    assert result["downward_pct"]==expected


def test_average_capital_once_per_session_and_canonical_cycle():
    rows=[cycle(0,100),cycle(1,100),cycle(2,100)]
    rows[0]["starting_capital"]=10000;rows[1]["starting_capital"]=10000
    rows[2].update(session_id="second",starting_capital=30000)
    rows.append({**rows[0],"session_id":"alias"})
    path=journeys(rows)[0]
    assert path["capital"]==20000 and path["sessions"]==2
    assert path["completed"]==3 and path["net_pnl_pct"]==1.5


def test_missing_capital_keeps_money_not_made_up_percentage():
    row=cycle(0,-10);row["starting_capital"]=None
    path=journeys([row])[0]
    assert path["net_pnl"]==-10 and path["net_pnl_pct"] is None
    assert path["max_drawdown"]==10 and path["giveback"]==10


def test_sizing_state_uses_only_previous_completed_cycles():
    rows=[cycle(0,4),cycle(1,-7),cycle(2,8)]
    for row,allocation,risk in zip(rows,[10,20,40],[1,2,4]):
        row["entries"][0]["analytics"]={"effective_allocation_pct":allocation,"effective_risk_pct":risk}
    # This addition was placed while the first trade had not closed; its eventual
    # outcome cannot be used to classify this earlier entry.
    rows[2]["entries"].append(dict(timestamp=3,analytics={"effective_allocation_pct":5}))
    path=journeys(rows)[0]
    assert path["sizing"]["flat"]["entries"]==2
    assert path["sizing"]["up"]["median_allocation_pct"]==20
    assert path["sizing"]["down"]["median_allocation_pct"]==40
    assert path["sizing_ratio"]=={"allocation":2,"risk":2}
    assert path["sizing"]["flat"]["risk_count"]==1


def test_same_second_close_and_entry_unknown_and_missing_metadata():
    first,second=cycle(0,-4),cycle(1,8)
    second["entries"][0]["timestamp"]=first["exit_time"]
    path=journeys([first,second])[0]
    assert path["sizing"]["unknown"]["entries"]==1
    assert path["sizing"]["flat"]["median_allocation_pct"] is None
    assert path["sizing_ratio"]["allocation"] is None


def test_scopes_never_mix_users_modes_accounts_and_exclude_swing():
    rows=[cycle(0,4)]
    for field,value in (("user_id","other"),("mode","real"),("broker_account_id","other-account"),("execution_broker","kite"),("date","2026-10-16")):
        rows.append({**cycle(1,5),field:value})
    rows.append({**cycle(2,9),"trading_style":"swing"})
    assert len(journeys(rows))==6


def test_completed_fifo_cycles_fees_partial_exits_and_reversal():
    session=dict(session_id="s",user_id="u",session_type="sim",date="2026-10-15",symbol="TEST",session_capital=1000)
    def fill(i,side,qty,price):
        return dict(trade_id=str(i),timestamp=i,side=side,quantity=qty,price=price,commission=qty)
    partial=build_cycles(session,[fill(1,"BUY",2,100),fill(2,"SELL",1,110)])
    path=journeys(partial)[0]
    assert path["points"]==[] and path["open_cycles"]==1
    complete=build_cycles(session,[fill(1,"BUY",2,100),fill(2,"SELL",1,110),fill(3,"SELL",1,90)])
    path=journeys(complete)[0]
    assert path["net_pnl"]==-4 and path["completed"]==1 and path["capital"]==1000
    reversal=build_cycles(session,[fill(1,"BUY",1,100),fill(2,"SELL",2,110)])
    path=journeys(reversal)[0]
    assert path["completed"]==1 and path["open_cycles"]==1 and path["net_pnl"]==8
    assert report(complete)["day_paths"][0]["net_pnl"]==report(complete)["summary"]["net_pnl"]


def test_order_independent_and_input_not_mutated():
    rows=[cycle(2,5),cycle(0,4),cycle(1,-2)]
    original=deepcopy(rows)
    assert journeys(rows)==journeys(list(reversed(rows)))
    assert rows==original


def test_giveback_and_multiple_downswings():
    result=journeys([cycle(0,10),cycle(1,-4),cycle(2,5),cycle(3,-3)])[0]
    assert result["max_drawdown"]==4
    assert result["downward"]==7 and result["giveback"]==3


def test_website_detail_response_keeps_cycles():
    from app.routers.analysis import SessionDetail
    detail=SessionDetail(session_id="s",user_id="u",symbol="NIFTY",date="2026-10-15",cycles=[cycle(0,4)])
    assert detail.model_dump()["cycles"][0]["net_pnl"]==4


def test_all_cycles_in_report_not_a_visible_page():
    session=dict(session_id="s",user_id="u",session_type="sim",date="2026-10-15",symbol="TEST",session_capital=1000)
    fills=[]
    for i in range(60):
        fills.extend([dict(trade_id=f"{i}-buy",timestamp=i*10+1,side="BUY",quantity=1,price=100,commission=0),
                      dict(trade_id=f"{i}-sell",timestamp=i*10+2,side="SELL",quantity=1,price=101,commission=0)])
    data=report(build_cycles(session,fills))
    assert data["day_paths"][0]["completed"]==60
    assert data["day_paths"][0]["net_pnl"]==60


def test_precise_same_second_closes_use_actual_execution_order():
    rows=[]
    for ident,pnl,micro in [('a',-5,100),('c',10,200),('b',-5,300)]:
        c=cycle(0,pnl);c.update(cycle_id=ident,exit_time=10,exit_sort_time=10_000_000+micro)
        rows.append(c)
    path=journeys(rows)[0]
    assert [p['pnl'] for p in path['points']]==[-5,5,0]
    assert path['max_drawdown']==5 and path['giveback']==5
    assert all(not p['grouped'] for p in path['points'])


@pytest.mark.parametrize('stamps',[[None,None,None],[10_000_100,10_000_100,10_000_100],[10_000_100,None,10_000_300],[9_000_100,10_000_200,10_000_300]])
def test_unresolved_same_second_closes_group_without_invented_drawdown(stamps):
    rows=[]
    for ident,pnl,stamp in zip(['a','c','b'],[-5,10,-5],stamps):
        c=cycle(0,pnl);c.update(cycle_id=ident,exit_time=10,exit_sort_time=stamp);rows.append(c)
    path=journeys(rows)[0]
    assert path['completed']==3 and len(path['points'])==1
    assert path['points'][0]['grouped'] and len(path['points'][0]['members'])==3
    assert path['max_drawdown']==0 and path['net_pnl']==0
    assert path['downward']==10 # Individual losing trades still count.
    assert {m['cycle_id'] for m in path['points'][0]['members']}=={'a','b','c'}


def test_final_closing_execution_supplies_precision_not_partial_exit():
    session=dict(session_id='s',user_id='u',symbol='TEST',date='2026-10-15',session_capital=1000,session_type='sim')
    rows=[dict(trade_id='1',side='BUY',quantity=2,price=100,timestamp=1),
          dict(trade_id='2',side='SELL',quantity=1,price=101,timestamp=2,execution_sort_time=2_000_100),
          dict(trade_id='3',side='SELL',quantity=1,price=102,timestamp=3,execution_sort_time=3_000_200)]
    assert build_cycles(session,rows)[0]['exit_sort_time']==3_000_200
    rows[-1].pop('execution_sort_time')
    assert build_cycles(session,rows)[0]['exit_sort_time'] is None
