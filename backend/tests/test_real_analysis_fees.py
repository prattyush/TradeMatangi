from decimal import Decimal
import copy

import boto3
import pytest
from moto import mock_aws
from fastapi.testclient import TestClient

from app.main import app
from app.services import real_analysis_fees as fees, performance_service as perf, real_broker_state

USER = 'fees-user'
DATE = '2026-10-09'
ACCOUNT = 'broker-account-A'

@pytest.fixture
def db(monkeypatch):
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='ap-south-1')
        client = boto3.client('dynamodb', region_name='ap-south-1')
        monkeypatch.setattr('app.services.db.get_dynamodb_resource', lambda: resource)
        monkeypatch.setattr('app.services.db.get_dynamodb_client', lambda: client)
        real_broker_state._links.clear()
        for name, keys in [('Sessions', [('session_id','S')]), ('Trades', [('session_id','S'),('trade_id','S')]),
                           ('Orders', [('session_id','S'),('order_id','S')]), ('TradeLabels', [('session_id','S'),('round_trip_index','N')]),
                           ('WalletLedgers', [('user_id','S'),('ledger_id','S')])]:
            attrs = [{'AttributeName': k, 'AttributeType': t} for k,t in keys]
            extra = {}
            if name == 'Sessions':
                attrs.append({'AttributeName':'user_id','AttributeType':'S'})
                extra = {'GlobalSecondaryIndexes':[{'IndexName':'UserIdIndex','KeySchema':[{'AttributeName':'user_id','KeyType':'HASH'}], 'Projection':{'ProjectionType':'ALL'}}]}
            resource.create_table(TableName=name, KeySchema=[{'AttributeName':k,'KeyType':'HASH' if i==0 else 'RANGE'} for i,(k,t) in enumerate(keys)], AttributeDefinitions=attrs, BillingMode='PAY_PER_REQUEST', **extra)
        yield resource
        real_broker_state._links.clear()


def seed(db, sid='nifty', symbol='NIFTY', mode='real', account=ACCOUNT, user=USER, open_only=False, estimated=True):
    session = {'session_id':sid,'user_id':user,'date':DATE,'symbol':symbol,'session_type':mode,'instrument_type':'options', 'session_capital':Decimal(100000),'start_time':'09:15:00'}
    db.Table('Sessions').put_item(Item=session)
    for index,(side,price,fee) in enumerate([('BUY',100,1),('SELL',110,2)][:1 if open_only else 2]):
        db.Table('Trades').put_item(Item={'session_id':sid,'trade_id':f'{sid}-{side}','user_id':user,'symbol':symbol,
            'side':side,'price':Decimal(price),'quantity':10,'timestamp':1791537300+index*180,
            'commission':Decimal(fee if estimated else 0),'right':'CE','strike':25000,'expiry':'2026-10-13',
            'broker_account_id':account,'broker_exchange':'NFO','kotak_order_id':f'{sid}-{side}'})
    return session


def test_account_date_total_allocates_before_filters_and_leaves_trading_data_untouched(db):
    seed(db); seed(db,'bank','CNXBAN')
    seed(db,'paper',mode='paper'); seed(db,'replay',mode='sim'); seed(db,'step',mode='stepwise')
    db.Table('WalletLedgers').put_item(Item={'user_id':USER,'ledger_id':f'real:{DATE}','current_balance':Decimal(987654)})
    before = copy.deepcopy(db.Table('Trades').scan()['Items'])
    assert fees.overview(USER, DATE)['accounts'][0]['estimated_total'] == 6
    fees.save(USER, DATE, ACCOUNT, 12)
    all_cycles = perf.load_cycles(USER, session_type='real', start_date=DATE, end_date=DATE)
    assert sum(c['fees'] for c in all_cycles) == pytest.approx(12)
    filtered = perf.load_cycles(USER, session_type='real', symbol='NIFTY', start_date=DATE, end_date=DATE)
    assert len(filtered) == 1 and filtered[0]['fees'] == pytest.approx(6) and filtered[0]['net_pnl'] == 94
    assert filtered[0]['fee_source'] == 'allocated_actual'
    for mode in ['paper','sim','stepwise']:
        assert perf.load_cycles(USER,session_type=mode)[0]['fees'] == pytest.approx(3)
    assert db.Table('Trades').scan()['Items'] == before
    assert db.Table('WalletLedgers').get_item(Key={'user_id':USER,'ledger_id':f'real:{DATE}'})['Item']['current_balance'] == 987654
    fees.remove(USER,DATE,ACCOUNT)
    assert perf.load_cycles(USER,session_type='real',symbol='NIFTY')[0]['fees'] == pytest.approx(3)


def test_fee_change_updates_outcomes_detail_and_session_summary(db):
    seed(db)
    fees.save(USER,DATE,ACCOUNT,120)
    client = TestClient(app); headers={'X-User-Id':USER}
    report=client.get('/api/analysis/performance?session_type=real',headers=headers)
    assert report.status_code==200,report.text
    assert report.json()['summary']['losses']==1 and report.json()['summary']['realized_pnl']==-20
    cycles=client.get('/api/analysis/performance/cycles?session_type=real',headers=headers).json()['items']
    detail=client.get(f"/api/analysis/performance/cycles/{cycles[0]['cycle_id']}?session_id=nifty",headers=headers)
    assert detail.json()['fees']==120
    summary=client.get('/api/analysis/sessions/nifty',headers=headers)
    assert summary.status_code==200,summary.text
    assert summary.json()['total_commission']==120
    assert sum(row['commission'] for row in summary.json()['trades'])==120


@pytest.mark.parametrize('amount',[0,Decimal('.01'),Decimal('12.34')])
def test_cent_totals_zero_estimates_and_open_entry_costs(db,amount):
    seed(db,estimated=False); seed(db,'open','RELIND',open_only=True,estimated=False)
    fees.save(USER,DATE,ACCOUNT,amount)
    cycles=perf.load_cycles(USER,session_type='real')
    allocated=sum(row['commission'] for c in cycles for row in c['executions'])
    assert allocated==pytest.approx(float(amount))
    opened=next(c for c in cycles if c['state']=='open')
    assert opened['fees']==0 and opened['open_entry_fees']>=0
    assert sum(c['fees']+c['open_entry_fees'] for c in cycles)==pytest.approx(float(amount))


def test_refresh_does_not_overwrite_override_but_changed_history_is_estimated(db):
    session=seed(db)
    fees.save(USER,DATE,ACCOUNT,9)
    # Broker refresh recomputes raw estimates. Corrections are separate.
    db.Table('Trades').update_item(Key={'session_id':'nifty','trade_id':'nifty-BUY'},UpdateExpression='SET commission=:fee',ExpressionAttributeValues={':fee':Decimal(2)})
    assert perf.load_session_cycles(session)[0]['fees']==9
    seed(db,'late','RELIND')
    assert fees.overview(USER,DATE)['accounts'][0]['history_changed'] is True
    assert perf.load_cycles(USER,session_type='real',symbol='RELIND')[0]['fee_source']=='estimated_history_changed'
    fees.save(USER,DATE,ACCOUNT,15)
    assert sum(c['fees'] for c in perf.load_cycles(USER,session_type='real'))==pytest.approx(15)


def test_owned_real_only_and_desktop_auth_boundary(db):
    seed(db); seed(db,'other',account='other-account',user='other-user')
    client=TestClient(app); headers={'X-User-Id':USER}
    body={'date':DATE,'account_id':ACCOUNT,'actual_total':9}
    assert client.post('/api/analysis/performance/real-fees',headers={'X-User-Id':'other-user'},json=body).status_code==404
    assert client.post('/api/analysis/performance/real-fees',headers=headers,json={**body,'actual_total':-1}).status_code==422
    assert client.post('/api/analysis/performance/real-fees',headers=headers,json={**body,'actual_total':1.001}).status_code==422
    from app.services.desktop_auth_service import _access_token
    desktop_headers={'Authorization': f'Bearer {_access_token(USER)[0]}'}
    result=client.post('/api/desktop/v1/analysis/performance/real-fees',headers=desktop_headers,json=body)
    assert result.status_code==200,result.text
    assert result.json()['accounts'][0]['actual_total']==9
    assert client.get(f'/api/desktop/v1/analysis/performance/real-fees?date={DATE}',headers=desktop_headers).status_code==200
    assert client.delete(f'/api/desktop/v1/analysis/performance/real-fees?date={DATE}&account_id={ACCOUNT}',headers=desktop_headers).status_code==200


def test_partial_fills_and_reversal_fees_are_not_duplicated(db):
    session=seed(db)
    db.Table('Trades').update_item(Key={'session_id':'nifty','trade_id':'nifty-SELL'},UpdateExpression='SET quantity=:q, commission=:fee',ExpressionAttributeValues={':q':15,':fee':Decimal(3)})
    fees.save(USER,DATE,ACCOUNT,12)
    stored=fees.read(USER,DATE,ACCOUNT)
    assert sum(row['actual'] for row in stored['orders'].values())==Decimal(12)
    cycles=perf.load_session_cycles(session)
    assert len(cycles)==2
    closed=next(c for c in cycles if c['state']=='closed')
    opened=next(c for c in cycles if c['state']=='open')
    assert closed['fees']==pytest.approx(9)
    assert opened['open_entry_fees']==pytest.approx(3)
    assert sum(row['commission'] for c in cycles for row in c['executions'])==pytest.approx(12)


def test_storage_failure_does_not_change_fills_or_report_success(db,monkeypatch):
    seed(db)
    before=copy.deepcopy(db.Table('Trades').scan()['Items'])
    real=fees.table()
    class FailingTable:
        def __getattr__(self,name): return getattr(real,name)
        def put_item(self,**kwargs): raise RuntimeError('storage unavailable')
    monkeypatch.setattr(fees,'table',lambda:FailingTable())
    response=TestClient(app).post('/api/analysis/performance/real-fees',headers={'X-User-Id':USER},json={'date':DATE,'account_id':ACCOUNT,'actual_total':9})
    assert response.status_code==503
    assert db.Table('Trades').scan()['Items']==before
    assert fees.read(USER,DATE,ACCOUNT) is None


def test_other_accounts_and_dates_are_not_adjusted(db):
    seed(db);seed(db,'second',account='account-B')
    fees.save(USER,DATE,ACCOUNT,9)
    assert perf.load_cycles(USER,session_type='real')[0]['fees']==pytest.approx(9)
    assert perf.load_cycles(USER,session_type='real')[1]['fees']==pytest.approx(3)
    response=TestClient(app).delete(f'/api/analysis/performance/real-fees?date={DATE}&account_id={ACCOUNT}',headers={'X-User-Id':'other-user'})
    assert response.status_code==404
    assert fees.read(USER,DATE,ACCOUNT)['actual_total']==9


def test_broker_execution_partial_fills_use_account_correction(db):
    session = seed(db)
    # Aggregated orders are expanded into execution chronology by analytics.
    for side, price in [('BUY', 100), ('SELL', 110)]:
        for index, quantity in enumerate([4, 6]):
            db.Table('Orders').put_item(Item={
                'session_id': 'nifty', 'order_id': f'execution:{side}:{index}',
                'broker_execution': {'exchange': 'NFO', 'kotak_order_id': f'nifty-{side}',
                    'execution_id': f'{side}-{index}', 'side': side, 'quantity': quantity,
                    'price': Decimal(price), 'timestamp': 1791537300 + (180 if side == 'SELL' else 0) + index,
                    'right': 'CE', 'strike': 25000, 'expiry': '2026-10-13'}})
    assert fees.overview(USER, DATE)['accounts'][0]['order_count'] == 2
    fees.save(USER, DATE, ACCOUNT, 12)
    cycles = perf.load_session_cycles(session)
    assert len(cycles) == 1
    assert cycles[0]['fees'] == pytest.approx(12)
    assert cycles[0]['net_pnl'] == pytest.approx(88)
    assert len(cycles[0]['executions']) == 4
    assert all(row['fee_source'] == 'allocated_actual' for row in cycles[0]['executions'])
    assert sum(row['commission'] for row in cycles[0]['executions']) == pytest.approx(12)


def test_shared_reports_read_owner_correction_without_write_access(db, monkeypatch):
    session = seed(db)
    fees.save(USER, DATE, ACCOUNT, 9)
    monkeypatch.setattr('app.services.analysis_sharing.visible_sessions', lambda viewer: [{**session, 'shared':True}])
    cycles = perf.load_cycles('viewer',session_type='real',include_shared=True)
    assert cycles[0]['fees'] == pytest.approx(9)
    assert cycles[0]['shared'] is True
    assert fees.overview('viewer', DATE)['accounts'] == []
    client = TestClient(app)
    assert client.post('/api/analysis/performance/real-fees',headers={'X-User-Id':'viewer'},
        json={'date':DATE,'account_id':ACCOUNT,'actual_total':0}).status_code == 404


def test_other_date_and_projection_alias_do_not_duplicate_bill(db):
    session = seed(db)
    alias = {**session, 'session_id':'nifty-alias', 'broker_projection_owner':'nifty'}
    db.Table('Sessions').put_item(Item=alias)
    old = seed(db, 'old-date')
    db.Table('Sessions').update_item(Key={'session_id':old['session_id']},
        UpdateExpression='SET #date=:date',ExpressionAttributeNames={'#date':'date'},
        ExpressionAttributeValues={':date':'2026-10-08'})
    assert fees.overview(USER, DATE)['accounts'][0]['estimated_total'] == 3
    fees.save(USER, DATE, ACCOUNT, 9)
    cycles = perf.load_cycles(USER,session_type='real')
    assert len(cycles) == 2
    assert next(c for c in cycles if c['session_id']=='nifty')['fees'] == pytest.approx(9)
    assert next(c for c in cycles if c['session_id']=='old-date')['fees'] == pytest.approx(3)
    assert fees.overview(USER, '2026-10-08')['accounts'][0]['actual_total'] is None


def test_kite_day_corrections_are_separate_from_kotak_same_account(db):
    seed(db, 'kotak')
    session = seed(db, 'kite')
    session['execution_broker'] = 'kite'
    db.Table('Sessions').put_item(Item=session)
    for side in ('BUY','SELL'):
        row = db.Table('Trades').get_item(Key={'session_id':'kite','trade_id':f'kite-{side}'})['Item']
        row['broker_order_id'] = row.pop('kotak_order_id')
        row['execution_broker'] = 'kite'
        db.Table('Trades').put_item(Item=row)
    accounts = fees.overview(USER,DATE)['accounts']
    assert {item['execution_broker'] for item in accounts} == {'kotak','kite'}
    fees.save(USER,DATE,ACCOUNT,9,'kite')
    assert perf.load_session_cycles(session)[0]['fees'] == pytest.approx(9)
    assert perf.load_cycles(USER,session_type='real',symbol='NIFTY')[0]['fee_source'] in {'estimated','allocated_actual'}
    cycles = {cycle['session_id']:cycle for cycle in perf.load_cycles(USER,session_type='real')}
    assert cycles['kotak']['fees'] == pytest.approx(3)
    assert cycles['kite']['fees'] == pytest.approx(9)
    fees.remove(USER,DATE,ACCOUNT,'kite')
    assert fees.read(USER,DATE,ACCOUNT,'kite') is None


def test_swing_books_are_excluded_from_finalized_day_charges(db):
    day = seed(db,'day')
    swing = seed(db,'swing')
    swing.update(trading_style='swing', portfolio_id='portfolio')
    db.Table('Sessions').put_item(Item=swing)
    assert fees.overview(USER,DATE)['accounts'][0]['estimated_total'] == 3
    fees.save(USER,DATE,ACCOUNT,12)
    assert perf.load_session_cycles(day)[0]['fees'] == pytest.approx(12)
    assert perf.load_session_cycles(swing)[0]['fees'] == pytest.approx(3)
    assert all(row['fee_source']=='estimated' for cycle in perf.load_session_cycles(swing) for row in cycle['executions'])


def test_legacy_kotak_charge_record_is_readable_and_cannot_resurrect(db):
    session=seed(db)
    fees.save(USER,DATE,ACCOUNT,9)
    ledger=db.Table('WalletLedgers')
    record=fees.read(USER,DATE,ACCOUNT)
    ledger.delete_item(Key=fees.key(USER,DATE,ACCOUNT))
    ledger.put_item(Item={**record,**fees.legacy_key(USER,DATE,ACCOUNT)})
    assert perf.load_session_cycles(session)[0]['fees']==9
    assert fees.read(USER,DATE,ACCOUNT,'kite') is None
    fees.save(USER,DATE,ACCOUNT,12)
    assert perf.load_session_cycles(session)[0]['fees']==pytest.approx(12)
    fees.remove(USER,DATE,ACCOUNT)
    assert fees.read(USER,DATE,ACCOUNT) is None
    assert perf.load_session_cycles(session)[0]['fees']==pytest.approx(3)


def test_kite_fee_endpoint_requires_owned_broker_scope(db):
    session=seed(db,'kite')
    session['execution_broker']='kite'
    db.Table('Sessions').put_item(Item=session)
    client=TestClient(app)
    body={'date':DATE,'account_id':ACCOUNT,'actual_total':9,'execution_broker':'kite'}
    # Old trade rows inherit the pinned session broker when they lack this field.
    result=client.post('/api/analysis/performance/real-fees',headers={'X-User-Id':USER},json=body)
    assert result.status_code==200,result.text
    assert result.json()['accounts'][0]['execution_broker']=='kite'
    assert client.post('/api/analysis/performance/real-fees',headers={'X-User-Id':'other'},json=body).status_code==404
    assert client.delete(f'/api/analysis/performance/real-fees?date={DATE}&account_id={ACCOUNT}',headers={'X-User-Id':USER}).status_code==404
    assert client.delete(f'/api/analysis/performance/real-fees?date={DATE}&account_id={ACCOUNT}&execution_broker=kite',headers={'X-User-Id':USER}).status_code==200


def test_failed_removal_keeps_legacy_and_current_charge_metadata(db,monkeypatch):
    seed(db)
    fees.save(USER,DATE,ACCOUNT,9)
    record=fees.read(USER,DATE,ACCOUNT)
    db.Table('WalletLedgers').put_item(Item={**record,**fees.legacy_key(USER,DATE,ACCOUNT)})
    class Failure:
        def transact_write_items(self,**kwargs): raise RuntimeError('Storage unavailable')
    monkeypatch.setattr('app.services.db.get_dynamodb_client',lambda:Failure())
    response=TestClient(app).delete(f'/api/analysis/performance/real-fees?date={DATE}&account_id={ACCOUNT}',headers={'X-User-Id':USER})
    assert response.status_code==503
    assert db.Table('WalletLedgers').get_item(Key=fees.key(USER,DATE,ACCOUNT))['Item']['actual_total']==9
    assert db.Table('WalletLedgers').get_item(Key=fees.legacy_key(USER,DATE,ACCOUNT))['Item']['actual_total']==9
