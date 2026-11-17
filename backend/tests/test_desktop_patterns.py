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
    import re
    for _, path in desktop_routes():
        assert not any(w in path for w in ('order', 'session', 'wallet', 'broker', 'stream', 'guardrail'))
        # "trade" as a whole word is a trading route; "traded" (the user's labelled trades as pattern data, read-only) is not.
        assert not re.search(r'(^|[/_-])trades?($|[/_-])', path), path


def test_identity_is_the_bearer_user_not_a_header(client):
    with patch('app.routers.pattern_logger.svc') as svc:
        svc.list_strategy_names.return_value = ['Breakout']
        r = client.get(f'{BASE}/pattern/strategies', headers={'X-User-Id': 'mallory'})
    assert r.status_code == 200, r.text
    assert r.json() == {'strategies': ['Breakout']}
    svc.list_strategy_names.assert_called_once_with('alice')


def test_deep_dive_routes_are_mirrored_for_the_desktop():
    from app.routers import deep_dive
    mirrored = desktop_routes()
    for r in deep_dive.router.routes:
        for m in r.methods:
            assert (m, f'{BASE}/deep-dive{r.path.removeprefix("/api/deep-dive")}') in mirrored


def test_deep_dive_requires_the_bearer_and_ignores_the_website_header():
    with TestClient(app) as anonymous:
        assert anonymous.get(f'{BASE}/deep-dive/dives', headers={'X-User-Id': 'alice'}).status_code == 401


def test_deep_dive_uses_the_bearer_identity(client):
    with patch('app.routers.deep_dive.svc') as svc:
        svc.list_dives.return_value = []
        r = client.get(f'{BASE}/deep-dive/dives', headers={'X-User-Id': 'mallory'})
    assert r.status_code == 200, r.text
    assert r.json() == {'dives': []}
    svc.list_dives.assert_called_once_with('alice')


def test_traded_pattern_routes_are_mirrored_and_use_the_bearer_identity(client):
    mirrored = desktop_routes()
    for method, path in (('GET', '/traded/summary'), ('GET', '/traded'), ('POST', '/traded/save')):
        assert (method, f'{BASE}/pattern{path}') in mirrored
    with patch('app.services.traded_patterns_service.summary', return_value=[{'strategy': 'ORB'}]) as summary:
        r = client.get(f'{BASE}/pattern/traded/summary', headers={'X-User-Id': 'mallory'})
    assert r.status_code == 200 and r.json() == {'strategies': [{'strategy': 'ORB'}]}
    summary.assert_called_once_with('alice', None, None)
