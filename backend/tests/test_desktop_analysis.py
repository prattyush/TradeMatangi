"""Desktop adapter ownership, history validation and canonical FIFO parity."""
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.dependencies import get_desktop_user_id
from app.routers import desktop_analysis
from tests.test_phase20_api import database, seed


@pytest.fixture
def client():
    app.dependency_overrides[desktop_analysis.get_analysis_user_id] = lambda: 'alice'
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(desktop_analysis.get_analysis_user_id, None)


def test_desktop_requires_bearer_auth():
    with TestClient(app) as client:
        assert client.get('/api/desktop/v1/analysis/sessions', headers={'X-User-Id': 'alice'}).status_code == 401


@pytest.mark.parametrize('path,method', [
    ('sessions/other', 'GET'), ('round-trips?session_id=other', 'GET'),
    ('labels?session_id=other', 'GET'), ('snapshots?session_id=other', 'GET'),
    ('snapshots?session_id=other', 'DELETE'),
])
def test_owned_reads_and_snapshot_delete(client, database, path, method):
    seed(database, user='bob', sid='other')
    with patch('app.services.snapshot_service.get_snapshots') as read, patch('app.services.snapshot_service.delete_snapshots') as delete:
        assert client.request(method, '/api/desktop/v1/analysis/'+path).status_code == 404
        read.assert_not_called()
        delete.assert_not_called()


def test_reports_and_session_detail_match_website(client, database):
    seed(database)
    seed(database, user='bob', sid='other')
    desktop = client.get('/api/desktop/v1/analysis/performance').json()
    website = client.get('/api/analysis/performance', headers={'X-User-Id': 'alice'}).json()
    assert desktop == website
    detail = client.get('/api/desktop/v1/analysis/sessions/session')
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert len(body['trades']) == 2
    assert sum(t['quantity'] for t in body['trades']) == 80
    assert body['net_pnl'] == 398
    assert body['cycles'][0]['matches'][0]['quantity'] == 40


def test_reversal_is_one_physical_fill_with_two_roles(client, database):
    seed(database)
    database.Table('Trades').update_item(Key={'session_id':'session','trade_id':'2'}, UpdateExpression='SET quantity = :q', ExpressionAttributeValues={':q':60})
    response = client.get('/api/desktop/v1/analysis/sessions/session')
    assert response.status_code == 200, response.text
    body = response.json()
    fill = next(t for t in body['trades'] if t['trade_id'] == '2')
    assert fill['quantity'] == 60 and fill['commission'] == 1
    roles = [e for c in body['cycles'] for e in c['executions'] if e['trade_id'] == '2']
    assert {(e['role'], e['quantity']) for e in roles} == {('exit',40), ('entry',20)}


def test_read_failure_is_not_empty_report(client):
    with patch.object(desktop_analysis.labels.svc, '_load_session', side_effect=RuntimeError('database unavailable')):
        response = client.get('/api/desktop/v1/analysis/sessions/session')
    assert response.status_code == 503


def test_history_signature_validation_and_scope(client):
    response = client.get('/api/desktop/v1/analysis/data/options-historical?symbol=NIFTY')
    assert response.status_code == 422
    required = {e['loc'][-1] for e in response.json()['detail']}
    assert {'date', 'strike', 'expiry', 'right'} <= required
    desktop_route = next(r for r in desktop_analysis.router.routes if r.path.endswith('/data/historical'))
    from app.services.historical_data_service import historical_request_scope
    assert any(d.dependency is historical_request_scope for d in desktop_route.dependencies)


def test_trading_and_snapshot_creation_are_not_exposed(client):
    assert client.post('/api/desktop/v1/analysis/snapshots', json={}).status_code == 405
    assert client.post('/api/desktop/v1/analysis/orders', json={}).status_code == 404


def test_bearer_identity_replaces_legacy_header():
    with patch('app.services.desktop_auth_service.verify_access_token', return_value='alice') as verify, patch('app.services.analysis_service.get_sessions_for_user', return_value=[]) as load:
        with TestClient(app) as client:
            response = client.get('/api/desktop/v1/analysis/sessions', headers={'Authorization':'Bearer synthetic', 'X-User-Id':'bob'})
    assert response.status_code == 200
    verify.assert_called_once_with('synthetic')
    assert load.call_args.args[0] == 'alice'


def test_desktop_history_worker_keeps_context_and_website_executor():
    import asyncio
    import threading
    from contextvars import ContextVar
    from app.services.history_workers import desktop_history_scope, run_data_history
    evidence = ContextVar('history_test', default='unset')
    async def exercise():
        evidence.set('captured')
        with desktop_history_scope():
            name, value = await run_data_history(lambda: (threading.current_thread().name, evidence.get()))
        default_name = await run_data_history(lambda: threading.current_thread().name)
        return name, value, default_name
    name, value, default_name = asyncio.run(exercise())
    assert name.startswith('desktop-history') and value == 'captured'
    assert not default_name.startswith('desktop-history')
