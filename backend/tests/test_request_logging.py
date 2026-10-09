import asyncio
import logging

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app.request_logging import RequestLoggingMiddleware


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 409, 503])
async def test_request_start_and_failure_status_share_id_without_secrets(caplog, status):
    async def endpoint(request):
        return JSONResponse({"detail": "synthetic"}, status_code=status)
    app = RequestLoggingMiddleware(Starlette(routes=[Route('/api/wallet', endpoint, methods=['POST'])]))
    with caplog.at_level(logging.DEBUG, logger='app.requests'):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/wallet?token=secret-query', json={'password': 'secret-body'}, headers={'Authorization': 'Bearer secret-header'})
    request_id = response.headers['x-request-id']
    assert f'http_request_start request_id={request_id}' in caplog.text
    assert f'http_response request_id={request_id}' in caplog.text
    assert f'status={status}' in caplog.text
    assert 'secret-' not in caplog.text
    record = next(row for row in caplog.records if row.message.startswith('http_response'))
    assert record.levelno == (logging.ERROR if status >= 500 else logging.WARNING if status >= 400 else logging.DEBUG)


@pytest.mark.asyncio
async def test_pending_request_is_logged_before_response(caplog):
    async def endpoint(request):
        await asyncio.sleep(.04)
        return JSONResponse({})
    app = RequestLoggingMiddleware(Starlette(routes=[Route('/api/auth/google', endpoint)]), pending_after_s=.01)
    with caplog.at_level(logging.DEBUG, logger='app.requests'):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            await client.get('/api/auth/google')
    events = [record.message.split()[0] for record in caplog.records if record.name == 'app.requests']
    assert events == ['http_request_start', 'http_request_pending', 'http_response']


@pytest.mark.asyncio
async def test_unhandled_failure_records_traceback(caplog):
    async def endpoint(request):
        raise RuntimeError('synthetic failure')
    app = RequestLoggingMiddleware(Starlette(routes=[Route('/api/data/historical', endpoint)]))
    with caplog.at_level(logging.DEBUG, logger='app.requests'):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url='http://test') as client:
            response = await client.get('/api/data/historical')
    assert response.status_code == 500
    assert 'http_request_failed' in caplog.text
    assert any(record.exc_info for record in caplog.records if record.name == 'app.requests')


@pytest.mark.asyncio
async def test_request_id_propagates_into_background_storage_work():
    from app.request_logging import current_request_id
    async def endpoint(request):
        return JSONResponse({"request_id": await asyncio.to_thread(current_request_id.get)})
    app = RequestLoggingMiddleware(Starlette(routes=[Route('/api/wallet', endpoint)]))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/api/wallet')
    assert response.json()['request_id'] == response.headers['x-request-id']
    assert current_request_id.get() is None
