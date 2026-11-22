"""Desktop adapters for Patterns, Chart Structures and Fine Structures."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import desktop_patterns

BASE = '/api/desktop/v1/patterns'


@pytest.fixture
def client():
    app.dependency_overrides[desktop_patterns.get_patterns_user_id] = lambda: 'alice'
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(desktop_patterns.get_patterns_user_id, None)


def desktop_routes():
    return {(m, r.path) for r in desktop_patterns.router.routes for m in r.methods}


def test_requires_bearer_and_ignores_website_header():
    with TestClient(app) as c:
        assert c.get(f'{BASE}/pattern/strategies', headers={'X-User-Id': 'alice'}).status_code == 401
        assert c.get(f'{BASE}/chart-structures/types').status_code == 401
        assert c.get(f'{BASE}/data/symbols').status_code == 401


def test_every_website_route_in_the_three_families_is_mirrored():
    from app.routers import chart_structures, fine_structures, pattern_logger
    mirrored = desktop_routes()
    for source, old, new in ((pattern_logger, '/api/pattern', '/pattern'),
                             (chart_structures, '/api/chart-structures', '/chart-structures'),
                             (fine_structures, '/api/fine-structures', '/fine-structures')):
        for r in source.router.routes:
            for m in r.methods:
                assert (m, f'{BASE}{new}{r.path.removeprefix(old)}') in mirrored


def test_only_listed_data_helpers_are_exposed():
    data_routes = {p.removeprefix(f'{BASE}/data/') for _, p in desktop_routes() if p.startswith(f'{BASE}/data/')}
    assert data_routes == {'symbols', 'price-at', 'expiry', 'options/find-strike-by-price'}


def test_no_trading_or_order_paths_are_exposed():
    for _, path in desktop_routes():
        assert not any(w in path for w in ('order', 'session', 'trade', 'wallet', 'broker', 'stream', 'guardrail'))


def test_identity_is_the_bearer_user_not_a_header(client):
    with patch('app.routers.pattern_logger.svc') as svc:
        svc.list_strategy_names.return_value = ['Breakout']
        r = client.get(f'{BASE}/pattern/strategies', headers={'X-User-Id': 'mallory'})
    assert r.status_code == 200, r.text
    assert r.json() == {'strategies': ['Breakout']}
    svc.list_strategy_names.assert_called_once_with('alice')
