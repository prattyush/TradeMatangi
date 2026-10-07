"""Atomic real-history grants and read-only cross-client access; all data is synthetic."""
import json
from unittest.mock import patch
import boto3
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.routers.desktop_analysis import get_analysis_user_id
from app.services import analysis_sharing
from tests.test_phase20_api import database, seed

@pytest.fixture
def sharing_db(database,monkeypatch):
    database.create_table(TableName='Users',KeySchema=[{'AttributeName':'user_id','KeyType':'HASH'}],AttributeDefinitions=[{'AttributeName':'user_id','AttributeType':'S'},{'AttributeName':'email','AttributeType':'S'}],BillingMode='PAY_PER_REQUEST',GlobalSecondaryIndexes=[{'IndexName':'EmailIndex','KeySchema':[{'AttributeName':'email','KeyType':'HASH'}],'Projection':{'ProjectionType':'ALL'}}])
    database.create_table(TableName='EventSnapshots',KeySchema=[{'AttributeName':'session_id','KeyType':'HASH'},{'AttributeName':'event_id','KeyType':'RANGE'}],AttributeDefinitions=[{'AttributeName':'session_id','AttributeType':'S'},{'AttributeName':'event_id','AttributeType':'S'}],BillingMode='PAY_PER_REQUEST')
    for user in ('alice','bob','carol'):
        database.Table('Users').put_item(Item={'user_id':user,'email':f'{user}@example.com','account_name':user})
    monkeypatch.setattr('app.services.db.get_dynamodb_client',lambda:boto3.client('dynamodb',region_name='us-east-1',aws_access_key_id='fake',aws_secret_access_key='fake'))
    monkeypatch.setattr('app.services.snapshot_service._ENSURED',True)
    return database

@pytest.fixture
def recipient():
    app.dependency_overrides[get_analysis_user_id]=lambda:'bob'
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_analysis_user_id,None)


def test_atomic_normalized_grant_and_removal(sharing_db):
    state=analysis_sharing.save('alice',[' BOB@EXAMPLE.COM ','bob@example.com'])
    assert state['emails']==['bob@example.com']
    assert analysis_sharing.sources('bob')==[{'user_id':'alice','email':'alice@example.com','account_name':'alice'}]
    assert analysis_sharing.sources('carol')==[]
    assert analysis_sharing.can_read({'user_id':'alice','session_type':'real'},'bob')
    for mode in ('paper','sim','stepwise'):
        assert not analysis_sharing.can_read({'user_id':'alice','session_type':mode},'bob')
    analysis_sharing.save('alice',[])
    assert analysis_sharing.sources('bob')==[]
    assert not analysis_sharing.can_read({'user_id':'alice','session_type':'real'},'bob')

@pytest.mark.parametrize('emails',[['not-email'],['missing@example.com'],['alice@example.com']])
def test_invalid_recipients_do_not_modify_existing_grants(sharing_db,emails):
    analysis_sharing.save('alice',['bob@example.com'])
    with pytest.raises(ValueError):analysis_sharing.save('alice',emails)
    assert analysis_sharing.settings('alice')['emails']==['bob@example.com']


def test_reverse_pointer_cannot_grant_access_and_grants_are_not_transitive(sharing_db):
    sharing_db.Table('Users').update_item(Key={'user_id':'bob'},UpdateExpression='ADD real_history_sources :sources',ExpressionAttributeValues={':sources':{'alice'}})
    assert analysis_sharing.sources('bob')==[]
    analysis_sharing.save('alice',['bob@example.com']);analysis_sharing.save('bob',['carol@example.com'])
    assert not analysis_sharing.can_read({'user_id':'alice','session_type':'real'},'carol')


def test_shared_real_detail_orders_labels_snapshots_and_own_paper(recipient,sharing_db):
    seed(sharing_db,user='alice',sid='real',mode='real')
    seed(sharing_db,user='alice',sid='private',mode='paper')
    seed(sharing_db,user='bob',sid='practice',mode='paper')
    sharing_db.Table('Orders').put_item(Item={'session_id':'real','order_id':'cancelled','user_id':'alice','symbol':'NIFTY','order_type':'LIMIT','side':'BUY','quantity':40,'status':'CANCELLED','secret_unrelated_value':'do-not-export'})
    sharing_db.Table('EventSnapshots').put_item(Item={'session_id':'real','event_id':'event','user_id':'alice','timestamp':1,'event_json':json.dumps({'type':'order_filled','description':'Filled'}),'snapshot_json':json.dumps({'wallet_balance':10000,'open_orders':[]})})
    analysis_sharing.save('alice',['bob@example.com'])
    headers={'X-User-Id':'bob'}
    for prefix in ('/api/analysis','/api/desktop/v1/analysis'):
        rows=recipient.get(prefix+'/sessions?include_shared=true',headers=headers)
        assert rows.status_code==200,rows.text
        assert {row['session_id'] for row in rows.json()}=={'real','practice'}
        shared=next(row for row in rows.json() if row['session_id']=='real')
        assert shared['shared'] and shared['owner_email']=='alice@example.com'
        detail=recipient.get(prefix+'/sessions/real',headers=headers)
        assert detail.status_code==200,detail.text
        assert detail.json()['shared'] and len(detail.json()['trades'])==2
        assert detail.json()['orders'][0]['status']=='CANCELLED'
        assert 'secret_unrelated_value' not in detail.json()['orders'][0]
        assert recipient.get(prefix+'/sessions/private',headers=headers).status_code==404
        assert recipient.get(prefix+'/labels?session_id=real',headers=headers).status_code==200
        assert recipient.post(prefix+'/labels',headers=headers,json={'labels':[{'session_id':'real','round_trip_index':0,'entry_tag':'unauthorized'}]}).status_code==404
        report=recipient.get(prefix+'/performance?include_shared=true',headers=headers)
        assert report.status_code==200,report.text
        assert report.json()['summary']['count']==2
        page=recipient.get(prefix+'/performance/cycles?include_shared=true',headers=headers).json()
        cycle=next(row for row in page['items'] if row['session_id']=='real')
        assert recipient.get(prefix+f"/performance/cycles/{cycle['cycle_id']}?session_id=real",headers=headers).status_code==200
    for prefix in ('/api/snapshots','/api/desktop/v1/analysis/snapshots'):
        response=recipient.get(prefix+'?session_id=real',headers=headers)
        assert response.status_code==200,response.text
        assert response.json()[0]['snapshot']['wallet_balance']==10000
        assert recipient.delete(prefix+'?session_id=real',headers=headers).status_code==404
    assert recipient.post('/api/snapshots',headers=headers,json={'event_id':'malicious','session_id':'real','user_id':'alice'}).status_code==404
    analysis_sharing.save('alice',[])
    assert recipient.get('/api/desktop/v1/analysis/sessions/real').status_code==404
    assert recipient.get('/api/snapshots?session_id=real',headers=headers).status_code==404


def test_sharing_settings_web_desktop_parity(sharing_db):
    client=TestClient(app)
    headers={'X-User-Id':'alice','Authorization':'Bearer synthetic'}
    with patch('app.services.desktop_auth_service.verify_access_token',return_value='alice'):
        response=client.put('/api/desktop/v1/settings/real-history-sharing',headers=headers,json={'emails':['bob@example.com']})
        assert response.status_code==200,response.text
        assert client.get('/api/users/real-history-sharing',headers=headers).json()==response.json()
        assert client.put('/api/users/real-history-sharing',headers=headers,json={'emails':[]}).status_code==200
        assert client.get('/api/desktop/v1/settings/real-history-sharing',headers=headers).json()['emails']==[]
    assert client.get('/api/desktop/v1/settings/real-history-sharing',headers={'X-User-Id':'alice'}).status_code==401


def test_snapshot_alias_membership_does_not_duplicate_real_cycles(sharing_db):
    base=seed(sharing_db,user='alice',sid='owner',mode='real')
    sharing_db.Table('Sessions').update_item(Key={'session_id':'owner'},UpdateExpression='SET broker_projection_owner=:owner',ExpressionAttributeValues={':owner':'owner'})
    sharing_db.Table('Sessions').put_item(Item={**base,'session_id':'alias','broker_projection_owner':'owner'})
    analysis_sharing.save('alice',['bob@example.com'])
    rows=analysis_sharing.visible_sessions('bob')
    assert len(rows)==1
    assert rows[0]['snapshot_session_ids']==['alias','owner']


def test_complete_orders_keep_unmanaged_broker_reports_and_exclude_secrets(sharing_db):
    from app.services.analysis_service import get_stored_orders
    session=seed(sharing_db,user='alice',sid='book',mode='real')
    sharing_db.Table('Orders').put_item(Item={'session_id':'book','order_id':'managed','order_type':'LIMIT','kotak_order_id':'1','broker_exchange':'nse_fo','analytics':{'entry_method':'MARKET'}})
    for oid in ('1','2'):
        sharing_db.Table('Orders').put_item(Item={'session_id':'book','order_id':'report:'+oid,'broker_order':{'kotak_order_id':oid,'exchange':'nse_fo','order_type':'MARKET','status':'open','quantity':65,'symbol':'NIFTY','side':'BUY','secret_password':'not-shared'}})
    rows=get_stored_orders(session)
    assert len(rows)==2
    managed=next(row for row in rows if row['order_id']=='managed')
    assert managed['order_type']=='LIMIT' and managed['broker_report']['order_type']=='MARKET'
    raw=next(row for row in rows if row.get('source')=='broker_report')
    assert raw['kotak_order_id']=='2' and raw['status']=='open'
    assert 'secret_password' not in raw['broker_report']
