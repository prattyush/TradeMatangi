"""Use the installed SDK with mocked HTTP: no broker credentials or live requests."""
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock
import threading

import pytest
import requests
import breeze_connect.breeze_connect as sdk

from app.services import breeze_history as history, broker_service as broker


@pytest.fixture
def transport(monkeypatch):
    transport = Mock()
    transport.get.return_value.json.return_value = {"Status": 200, "Success": []}
    monkeypatch.setattr(sdk, "requests", transport)
    history.install_history_timeout()
    return transport


def client():
    return sdk.ApificationBreeze(SimpleNamespace(api_key="test-key", user_id="test-user", session_key="test-session"))


def params(stock="NIFTY", **extra):
    return dict(interval="1second", from_date="2026-10-13 09:15:00",
                to_date="2026-10-13 09:31:30", stock_code=stock,
                exchange_code="NSE", product_type="cash", **extra)


def test_real_sdk_history_uses_timeout_and_preserves_validation(transport):
    handler = client()
    response = history.request_history(handler, **params())
    assert response["Status"] == 200
    call = transport.get.call_args.kwargs
    assert call["timeout"] == (10, 30)
    assert call["params"]["stock_code"] == "NIFTY"
    assert call["headers"]["apikey"] == "test-key"
    transport.reset_mock()
    handler.get_historical_data_v2(**{**params(), "interval": "invalid"})
    transport.get.assert_not_called()


def test_other_endpoints_and_global_requests_are_unchanged(transport):
    original_get = requests.get
    sdk.requests.get(url="https://example.invalid/login", params={"test": True})
    assert "timeout" not in transport.get.call_args.kwargs
    history.install_history_timeout()  # repeated authentication setup is idempotent
    sdk.requests.get(url=sdk.config.BREEZE_NEW_URL + sdk.api_endpoint.HIST_CHART.value, timeout=7)
    assert transport.get.call_args.kwargs["timeout"] == 7
    assert requests.get is original_get
    assert sdk.requests._transport is transport


def test_real_sdk_options_keeps_expiry_strike_right_and_exchange(transport):
    history.request_history(client(), **{
        **params(), "exchange_code": "NFO", "product_type": "options",
        "expiry_date": "2026-10-13T07:00:00.000Z", "strike_price": "22750", "right": "call",
    })
    call = transport.get.call_args.kwargs
    assert call["timeout"] == (10, 30)
    assert call["params"]["exch_code"] == "NFO"
    assert call["params"]["expiry_date"] == "2026-10-13T07:00:00.000Z"
    assert call["params"]["strike_price"] == "22750"
    assert call["params"]["right"] == "call"


def test_one_sdk_client_keeps_concurrent_contract_headers_and_parameters_separate(transport):
    handler = client()
    barrier = threading.Barrier(history._MAX_IN_FLIGHT)
    def get(**kwargs):
        barrier.wait(timeout=2)
        return SimpleNamespace(json=lambda: {"Status": 200, "Success": [kwargs["params"]["stock_code"]]})
    transport.get.side_effect = get
    stocks = ("NIFTY", "RELIND")[:history._MAX_IN_FLIGHT]
    with ThreadPoolExecutor(max_workers=len(stocks)) as workers:
        futures = [workers.submit(history.request_history, handler, **params(stock)) for stock in stocks]
        assert [job.result(timeout=3)["Success"] for job in futures] == [[stock] for stock in stocks]
    assert all(call.kwargs["headers"]["apikey"] == "test-key" for call in transport.get.call_args_list)


def test_sdk_timeout_cancels_batch_and_workers_accept_next_download(transport):
    transport.get.side_effect = requests.ReadTimeout("test read timed out")
    handler = client()
    with pytest.raises(Exception, match="test read timed out"):
        history.fetch_chunks(list(range(30)), lambda _, cancelled: history.request_history(
            handler, _cancelled=cancelled, **params())["Success"])
    assert transport.get.call_count <= 3
    transport.get.side_effect = None
    transport.get.return_value.json.return_value = {"Status": 200, "Success": ["recovered"]}
    assert history.fetch_chunks([0], lambda _, cancelled: history.request_history(
        handler, _cancelled=cancelled, **params())["Success"]) == ["recovered"]


@pytest.mark.parametrize("response", [
    {"Status": 200, "Error": "history unavailable", "Success": []},
    {"Status": 500, "Success": []},
])
def test_equity_error_response_cannot_be_accepted_as_empty_success(response):
    breeze = SimpleNamespace(get_historical_data_v2=lambda **kwargs: response)
    with pytest.raises(RuntimeError, match="Breeze API error"):
        broker._fetch_day_paginated(breeze, {"breeze_stock_code": "NIFTY", "exchange_code": "NSE", "product_type": "cash"}, "2026-10-13")


def test_shared_client_authenticates_once_and_replaces_only_on_credential_change(monkeypatch, transport):
    credentials = {"api_key": "test-key", "api_secret": "test-secret", "session_token": "test-token"}
    monkeypatch.setattr(broker, "_read_breeze_credentials", lambda: dict(credentials))
    monkeypatch.setattr(broker, "_cached_breeze", None)
    monkeypatch.setattr(broker, "_cached_breeze_creds", None)
    factory = Mock(side_effect=lambda **kwargs: Mock(generate_session=Mock(return_value=None)))
    monkeypatch.setattr("breeze_connect.BreezeConnect", factory)
    with ThreadPoolExecutor(max_workers=4) as workers:
        clients = list(workers.map(lambda _: broker._get_breeze(), range(4)))
    assert all(item is clients[0] for item in clients)
    assert factory.call_count == 1
    clients[0].generate_session.assert_called_once_with(api_secret="test-secret", session_token="test-token")
    credentials["session_token"] = "test-new-token"
    replacement = broker._get_breeze()
    assert replacement is not clients[0]
    assert broker._get_breeze() is replacement
    assert factory.call_count == 2


CONNECT_ERROR = ("Error in get_historical_data_v2(): HTTPSConnectionPool(host='breezeapi.icicidirect.com', port=443): "
                 "Max retries exceeded (Caused by ConnectTimeoutError('Connection to breezeapi.icicidirect.com timed out. (connect timeout=10)'))")


def test_connect_timeout_is_retried_and_the_chunk_succeeds():
    calls = []
    def flaky(**kwargs):
        calls.append(kwargs)
        if len(calls) < 3:
            raise Exception(CONNECT_ERROR)
        return {"Status": 200, "Success": ["ok"]}
    assert history.request_history(SimpleNamespace(get_historical_data_v2=flaky), **params())["Success"] == ["ok"]
    assert len(calls) == 3  # first try plus two retries


def test_connect_timeout_gives_up_after_the_retries():
    breeze = SimpleNamespace(get_historical_data_v2=Mock(side_effect=Exception(CONNECT_ERROR)))
    with pytest.raises(Exception, match="connect timeout"):
        history.request_history(breeze, **params())
    assert breeze.get_historical_data_v2.call_count == 1 + history._CONNECT_RETRIES


@pytest.mark.parametrize("message", ["read timed out", "Status 500", "invalid session token"])
def test_other_failures_are_not_retried(message):
    breeze = SimpleNamespace(get_historical_data_v2=Mock(side_effect=Exception(message)))
    with pytest.raises(Exception, match=message):
        history.request_history(breeze, **params())
    assert breeze.get_historical_data_v2.call_count == 1


def test_a_cancelled_download_stops_waiting_to_retry(monkeypatch):
    monkeypatch.setattr(history, "_CONNECT_BACKOFF", 30.0)
    cancelled = threading.Event()
    def failing(**kwargs):
        cancelled.set()
        raise Exception(CONNECT_ERROR)
    breeze = SimpleNamespace(get_historical_data_v2=failing)
    started = __import__("time").monotonic()
    with pytest.raises(__import__("concurrent.futures").futures.CancelledError):
        history.request_history(breeze, _cancelled=cancelled, **params())
    assert __import__("time").monotonic() - started < 5

