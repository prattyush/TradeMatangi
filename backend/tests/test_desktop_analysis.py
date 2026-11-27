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
    web_detail = client.get('/api/analysis/sessions/session', headers={'X-User-Id':'alice'})
    assert web_detail.status_code == 200, web_detail.text
    assert web_detail.json()['cycles'][0]['cycle_id'] == body['cycles'][0]['cycle_id']
    assert web_detail.json()['cycles'][0]['net_pnl'] == 398
    assert desktop['day_paths'][0]['net_pnl'] == 398


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


@pytest.mark.parametrize('kind', ['categories', 'strategies'])
def test_pattern_name_registration_is_exposed_for_desktop_user(client, kind):
    with patch('app.services.pattern_logger_service.add_name', return_value='Breakout') as add, \
         patch('app.services.pattern_logger_service._list_names', return_value=['Breakout']):
        response = client.post(f'/api/desktop/v1/analysis/pattern/{kind}', json={'name': 'Breakout'})
    assert response.status_code == 200
    assert response.json() == {kind: ['Breakout']}
    add.assert_called_once_with('alice', 'category' if kind == 'categories' else 'strategy', 'Breakout')


def test_pattern_name_registration_requires_bearer_auth():
    with TestClient(app) as anonymous:
        assert anonymous.post('/api/desktop/v1/analysis/pattern/categories', json={'name': 'x'}, headers={'X-User-Id': 'alice'}).status_code == 401


def test_pattern_chart_writes_are_not_exposed(client):
    assert client.post('/api/desktop/v1/analysis/pattern/chart', json={}).status_code in (404, 405)


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


def test_the_read_only_deep_dive_routes_are_the_only_ones_on_the_analysis_transport(client):
    """Phase 26: label forms read the percentages, and Analysis reads a practice run's review and the run list, here; the Deep Dive
    itself and starting a practice run live on the patterns transport."""
    routes = {(m, r.path) for r in desktop_analysis.router.routes for m in r.methods if 'deep-dive' in r.path}
    assert routes == {('GET', '/api/desktop/v1/analysis/deep-dive/stats/all'), ('GET', '/api/desktop/v1/analysis/deep-dive/practice/evaluate'),
                      ('GET', '/api/desktop/v1/analysis/deep-dive/practice/runs')}
    with patch('app.routers.deep_dive.svc') as svc:
        svc.stats_all.return_value = [{'category': 'Breakout', 'strategy': 'ORB'}]
        response = client.get('/api/desktop/v1/analysis/deep-dive/stats/all', headers={'X-User-Id': 'mallory'})
    assert response.status_code == 200, response.text
    assert response.json() == {'dives': [{'category': 'Breakout', 'strategy': 'ORB'}]}
    svc.stats_all.assert_called_once_with('alice')
    for method, path in (('POST', 'stats/all'), ('GET', 'dives'), ('PUT', 'setup'), ('POST', 'tags'), ('POST', 'practice/runs'), ('POST', 'practice/evaluate'),
                         ('GET', 'practice/pick'), ('POST', 'practice/pick'), ('GET', 'practice/strategies')):
        assert client.request(method, f'/api/desktop/v1/analysis/deep-dive/{path}').status_code in (404, 405)


def test_a_practice_review_is_read_through_the_analysis_transport_for_the_bearer_identity(client):
    with patch('app.routers.desktop_analysis.owned_session'), patch('app.routers.deep_dive.practice', create=True), \
            patch('app.services.strategy_practice_service.evaluate', return_value={'session_id': 's1', 'negative': False}) as evaluate, \
            patch('app.services.strategy_practice_service.list_runs', return_value=[{'session_id': 's1'}]) as runs:
        review = client.get('/api/desktop/v1/analysis/deep-dive/practice/evaluate?session_id=s1', headers={'X-User-Id': 'mallory'})
        listing = client.get('/api/desktop/v1/analysis/deep-dive/practice/runs', headers={'X-User-Id': 'mallory'})
    assert review.status_code == 200 and review.json()['session_id'] == 's1', review.text
    assert listing.status_code == 200 and listing.json() == {'runs': [{'session_id': 's1'}]}
    evaluate.assert_called_once_with('alice', 's1')  # the bearer's identity, never the header's
    runs.assert_called_once_with('alice')


def test_deep_dive_stats_requires_the_bearer():
    with TestClient(app) as anonymous:
        assert anonymous.get('/api/desktop/v1/analysis/deep-dive/stats/all', headers={'X-User-Id': 'alice'}).status_code == 401
