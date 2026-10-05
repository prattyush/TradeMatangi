"""Real SDK contracts and simulated feeds; never authenticate or place live orders."""
import asyncio
import json
import struct
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock
from urllib.parse import parse_qs

import httpx
import pytest

from app.services import kotak_service as ks
from app.services.kotak_stream import KotakFeedBridge


@pytest.fixture
def broker(monkeypatch):
    monkeypatch.setenv("NEO_LOG_FILE_ENABLED", "false")
    from neo_api_client import NeoAPI
    requests, responses = [], []
    def respond(request):
        requests.append(request)
        result = responses.pop(0) if responses else {"stat": "Ok", "stCode": 200, "nOrdNo": "K1"}
        return httpx.Response(200, json=result)
    client = NeoAPI(consumer_key="test-consumer", transport=httpx.MockTransport(respond))
    client.configuration.edit_token = "test-trade"
    client.configuration.edit_sid = "test-sid"
    client.configuration.base_url = "https://broker.invalid"
    client.configuration.data_center = "gdc"
    service = ks.KotakNeoService()
    service._client, service._authenticated = client, True
    yield service, client, requests, responses
    service.shutdown()


def body(request):
    return json.loads(parse_qs(request.content.decode())["jData"][0])


@pytest.mark.parametrize("options,stop", [(False, False), (False, True), (True, False), (True, True)])
def test_placement_against_real_sdk_signature_and_transport(broker, options, stop):
    service, _, requests, _ = broker
    kwargs = dict(symbol="RELIND", side="B", qty=1)
    if options:
        kwargs.update(symbol="NIFTY", right="CE", strike=23500, expiry="2026-05-26", qty=65)
    if stop:
        kwargs.update(trigger_price=99.97, limit_price=100.03)
    else:
        kwargs.update(price=100.03)
    method = (service.place_options_sl_order if stop else service.place_options_limit_order) if options else (
        service.place_sl_order if stop else service.place_limit_order)
    assert method(**kwargs) == "K1"
    data = body(requests[0])
    assert data["es"] == ("nse_fo" if options else "nse_cm")
    assert data["ts"] == ("NIFTY26MAY23500CE" if options else "RELIANCE-EQ")
    assert data["pc"] == "MIS" and data["rt"] == "DAY"
    assert data["pt"] == ("SL" if stop else "L")
    assert data["qt"] == ("65" if options else "1")
    assert data["pr"] == "100.05"
    assert data["tp"] == ("99.95" if stop else "0")
    assert data["mp"] == "0" and "pf" not in data


def test_modify_convert_and_cancel_real_sdk(broker):
    service, _, requests, responses = broker
    responses.extend([{"stat": "Ok", "stCode": 200}] * 3)
    assert service.modify_sl_order("K1", 99.97, 100.03, 65) == "K1"
    assert service.modify_sl_to_limit_order("K1", 100.03, 65) == "K1"
    service.cancel_order("K1")
    assert body(requests[0])["pt"] == "SL"
    assert body(requests[1])["pt"] == "L" and body(requests[1])["tp"] == "0"
    assert body(requests[0])["qt"] == "65"


@pytest.mark.parametrize("method", ["modify", "convert", "cancel"])
@pytest.mark.parametrize("response", [None, {}, "accepted", {"data": []}])
def test_malformed_order_ack_is_never_success(broker, method, response):
    service, _, _, responses = broker
    responses.append(response)
    calls = {"modify": lambda: service.modify_sl_order("K1", 99, 100, 1),
             "convert": lambda: service.modify_sl_to_limit_order("K1", 100, 1),
             "cancel": lambda: service.cancel_order("K1")}
    with pytest.raises(ks.KotakError):
        calls[method]()


@pytest.mark.parametrize("response", [
    {"Error": "invalid quantity"}, {"error": [{"code": "400", "message": "bad request"}]},
    {"data": {"stat": "Not_Ok", "errMsg": "rejected"}},
    {"stCode": 1021, "errMsg": "order is completed", "status_code": 400},
    {"StatusCode": 502}, {"status": "ERROR", "fault": {"code": 400, "message": "bad"}},
])
def test_returned_errors_never_become_success(response):
    with pytest.raises(ks.KotakError):
        ks.KotakNeoService()._check_api_response(response)


@pytest.mark.parametrize("response", [
    {"Error Message": "Complete the 2fa process"},
    {"stCode": "100008", "stat": "Not_Ok"},
    {"error": [{"code": "403", "message": "expired"}]},
    {"data": {"status_code": 401}},
])
def test_expiration_closes_bridge_and_rest(response):
    service = ks.KotakNeoService()
    service._client, service._bridge, service._authenticated = MagicMock(), MagicMock(), True
    client, bridge = service._client, service._bridge
    with pytest.raises(ks.KotakError, match="reconnect"):
        service._check_api_response(response)
    assert not service.is_authenticated()
    bridge.close.assert_called_once()
    client.api_client.rest_client.close.assert_called_once()


@pytest.mark.parametrize("stage", ["login", "validate", "success", "missing_session"])
def test_totp_flow_validates_actual_sdk_responses(broker, monkeypatch, stage):
    service, client, _, responses = broker
    service._client = None  # retain this transport for the new login factory
    service._authenticated = False
    client.configuration.edit_token = client.configuration.edit_sid = None
    # Avoid SDK dynamic-config HTTP lookup; this test concerns the two login calls.
    monkeypatch.setattr(client.configuration, "resolve_dynamic_urls", lambda transport: None)
    monkeypatch.setattr("neo_api_client.NeoAPI", lambda **kwargs: client)
    monkeypatch.setattr(ks, "_read_kotak_credentials", lambda: {
        "access_token": "test-consumer", "mobile": "+910000000000", "ucc": "TEST", "mpin": "000000"})
    monkeypatch.setattr(service, "_start_order_feed", lambda: None)
    monkeypatch.setattr(ks._kotak_broadcaster, "_subscribe_all", lambda **kwargs: None)
    ok = {"data": {"status": "success", "token": "test-token", "sid": "sid", "baseUrl": "https://broker.invalid"}}
    error = {"error": [{"code": "400", "message": "Invalid OTP"}]}
    responses.extend([error if stage == "login" else ok,
                      error if stage == "validate" else ({"data": {"status": "success"}} if stage == "missing_session" else ok)])
    if stage == "success":
        service.login_with_totp("123456")
        assert service.is_authenticated()
    else:
        with pytest.raises(ks.KotakError):
            service.login_with_totp("123456")
        assert not service.is_authenticated()


def test_real_sdk_reports_and_master_keep_existing_shapes(broker):
    service, client, _, responses = broker
    responses.extend([{"Net": "100", "MarginUsed": "20", "stat": "Ok"},
                      {"stat": "Ok", "data": []}, {"stat": "Ok", "data": []}, {"stat": "Ok", "data": []},
                      {"data": {"filesPaths": ["https://broker.invalid/nse_cm-v1.csv"]}}])
    assert service.get_limits()["MarginUsed"] == "20"
    assert service.get_order_history() == []
    assert service.get_trade_history() == []
    assert service.get_positions() == []
    assert client.scrip_master(exchange_segment="nse_cm") == "https://broker.invalid/nse_cm-v1.csv"


def test_protection_tag_and_exact_product_reach_real_sdk(broker):
    service, _, requests, _ = broker
    assert service.place_options_sl_order(symbol="BSESEN", right="PE", strike=71100,
        expiry="2026-10-08", side="S", qty=40, trigger_price=30, limit_price=29.55,
        tag="tmSLoperation", product="NRML") == "K1"
    assert body(requests[0])["ig"] == "tmSLoperation"
    assert body(requests[0])["pc"] == "NRML"


def test_real_sdk_nonempty_account_reports_preserve_cash_units(broker):
    service, _, _, responses = broker
    row = {"nOrdNo": "K1", "trdSym": "NIFTY26MAY23500CE", "sym": "NIFTY", "exSeg": "nse_fo",
           "ordSt": "complete", "trnsTp": "B", "prcTp": "L", "prod": "MIS",
           "qty": 65, "fldQty": 65, "avgPrc": "100", "prc": "100", "lotSz": "65",
           "multiplier": "1", "prcNum": "1", "prcDen": "1"}
    execution = {**row, "flId": "F1", "flPrc": "100", "flDt": "05-Oct-2026", "flTm": "09:15:00"}
    position = {**row, "flBuyQty": "65", "flSellQty": "0", "buyAmt": "6500", "cfBuyQty": "0"}
    responses.extend([{"stat": "Ok", "data": [row]}, {"stat": "Ok", "data": [execution]},
                      {"stat": "Ok", "data": [position]}])
    assert service.get_order_history()[0]["filled_quantity"] == 65
    trade = service.get_trade_history()[0]
    assert trade["quantity"] == 65 and trade["price"] == 100 and trade["price_factor"] == 1
    assert service.get_positions()[0]["buyAmt"] == "6500"


@pytest.mark.asyncio
async def test_funds_route_reports_broker_failure_instead_of_name_error(monkeypatch):
    from fastapi import HTTPException
    from app.routers import kotak
    service = MagicMock()
    service.get_funds.side_effect = ks.KotakError("Broker unavailable")
    monkeypatch.setattr(kotak, "get_service", lambda: service)
    with pytest.raises(HTTPException) as error:
        await kotak.kotak_funds("user")
    assert error.value.status_code == 502
    assert error.value.detail == "Broker unavailable"


@pytest.mark.parametrize("method", ["get_order_history", "get_trade_history", "get_positions"])
def test_failed_reports_are_not_empty_days(broker, method):
    service, _, _, responses = broker
    responses.append({"error": [{"code": "500", "message": "unavailable"}]})
    with pytest.raises(ks.KotakError):
        getattr(service, method)()


NO_DATA = {"stCode": 5203, "errMsg": "No Data", "desc": "data not found", "stat": "Not_Ok"}


@pytest.mark.parametrize("method", ["get_order_history", "get_trade_history", "get_positions"])
@pytest.mark.parametrize("code", [5203, "5203"])
def test_documented_no_data_reports_are_empty(broker, method, code):
    service, _, _, responses = broker
    responses.append({**NO_DATA, "stCode": code})
    assert getattr(service, method)() == []
    assert service.is_authenticated()


@pytest.mark.parametrize("changes", [
    {"stCode": 500}, {"errMsg": "Unavailable"}, {"data": [{"nOrdNo": "K1"}]},
    {"error": [{"code": "401", "message": "Unauthorized"}]}, {"status_code": 503},
])
def test_no_data_report_does_not_hide_other_failures(broker, changes):
    service, _, _, responses = broker
    responses.append({**NO_DATA, **changes})
    with pytest.raises(ks.KotakError, match="trade_report"):
        service.get_trade_history()


def test_no_data_limits_never_supply_a_balance(broker):
    service, _, _, responses = broker
    responses.append(NO_DATA)
    with pytest.raises(ks.KotakError, match="Kotak limits:.*5203"):
        service.get_limits()


def order_update(quantity=1, status="open", price="100", side="B", order_id="K1"):
    from neo_api_client.websocket.orderfeed import OrderUpdate
    return OrderUpdate(data={"nOrdNo": order_id, "ordSt": status, "fldQty": quantity,
                             "qty": 3, "avgPrc": price, "trnsTp": side})


def test_typed_partial_terminal_fills_and_duplicate_replay():
    service, loop, fill = ks.KotakNeoService(), MagicMock(), MagicMock()
    service.register_fill_callback("K1", fill, loop)
    service._on_message(order_update())
    service._on_message(order_update(3, "complete", "101"))
    service._on_message(order_update(3, "complete", "101"))
    assert loop.call_soon_threadsafe.call_args_list[0].args == (fill, "K1", "BUY", 1, 100.0)
    assert loop.call_soon_threadsafe.call_args_list[1].args == (fill, "K1", "BUY", 3, 101.0)
    assert loop.call_soon_threadsafe.call_count == 2
    assert "K1" not in service._pending_fills
    assert "K1" not in service._fill_callbacks


def test_early_fill_keeps_highest_quantity_and_dispatches_once():
    service, loop, fill = ks.KotakNeoService(), MagicMock(), MagicMock()
    service._on_message(order_update(2, side="S"))
    service._on_message(order_update(1, side="S"))
    service._on_message(order_update(3, "complete", "102", "S"))
    service.register_fill_callback("K1", fill, loop)
    loop.call_soon_threadsafe.assert_called_once_with(fill, "K1", "SELL", 3, 102.0)
    assert not service._fill_callbacks and not service._pending_fills


def test_cancelled_partial_fill_before_callback_registration():
    service, loop, fill, reject = ks.KotakNeoService(), MagicMock(), MagicMock(), MagicMock()
    service._on_message(order_update(1, "cancelled"))
    service.register_fill_callback("K1", fill, loop)
    service.register_reject_callback("K1", reject, loop)
    assert loop.call_soon_threadsafe.call_args_list[0].args == (fill, "K1", "BUY", 1, 100.0)
    assert loop.call_soon_threadsafe.call_args_list[1].args[0] is reject
    assert not service._reject_callbacks


@pytest.mark.parametrize("message", ["bad JSON", {"type": "position", "data": {}},
                                    {"type": "order", "data": {"nOrdNo": "K1", "ordSt": "complete", "avgPrc": "NaN", "qty": 1}}])
def test_malformed_and_unrelated_messages_do_not_create_fills(message):
    service = ks.KotakNeoService()
    service._on_message(message)
    assert not service._pending_fills


def test_replaced_login_generation_drops_old_messages(monkeypatch):
    service = ks.KotakNeoService()
    service._client, service._authenticated = MagicMock(), True
    captures = []
    def bridge(client, order, market, expired, **kwargs):
        captures.append((order, market, expired))
        return MagicMock()
    monkeypatch.setattr("app.services.kotak_stream.KotakFeedBridge", bridge)
    service._start_order_feed()
    service.shutdown()
    service._client, service._authenticated = MagicMock(), True
    service._start_order_feed()
    captures[0][0](order_update(3, "complete"))
    captures[0][2]()
    assert service.is_authenticated() and not service._pending_fills
    service.shutdown()


class FakeFeed:
    def __init__(self, failure=None):
        self.failure = failure
        self.queue = asyncio.Queue()
        self.calls = []
        self.closed = False
        self.is_connected = False
    async def connect(self):
        if self.failure:
            raise self.failure
        self.is_connected = True
    def __aiter__(self):
        return self
    async def __anext__(self):
        value = await self.queue.get()
        if value is None:
            self.is_connected = False
            raise StopAsyncIteration
        return value
    async def close(self):
        self.closed = True
        self.is_connected = False
    async def subscribe_scrips(self, tokens):
        self.calls.append(("scrips", tokens))
    async def unsubscribe_scrips(self, tokens):
        self.calls.append(("remove_scrips", tokens))
    async def subscribe_index(self, tokens):
        self.calls.append(("index", tokens))
    async def unsubscribe_index(self, tokens):
        self.calls.append(("remove_index", tokens))


def wait_for(predicate):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("feed condition did not arrive")


@pytest.fixture
def feeds():
    orders, markets, received, expired, kwargs = [], [], [], threading.Event(), []
    def factory(collection, **options):
        kwargs.append(options)
        ws = FakeFeed()
        collection.append(ws)
        return ws
    client = SimpleNamespace(create_order_feed=lambda **kw: factory(orders, **kw),
                             create_websocket=lambda **kw: factory(markets, **kw))
    bridge = KotakFeedBridge(client, received.append, received.append, expired.set, reconnect_delay=0.03, timeout=2)
    yield bridge, orders, markets, received, expired, kwargs
    bridge.close()
    assert not bridge._thread.is_alive()
    assert all(ws.closed for ws in orders + markets)


def subscription(token="123", exchange="nse_fo", index=False):
    return {"instrument_token": token, "exchange_segment": exchange, "is_index": index}


def test_bridge_separate_feeds_and_subscription_intents(feeds):
    bridge, orders, markets, _, _, options = feeds
    wait_for(lambda: orders)
    assert not markets
    bridge.replace_subscriptions([subscription(), subscription("26000", "nse_cm", True), subscription("99", "bse_cm", True)])
    assert len(orders) == len(markets) == 1
    assert all(o == {"max_connect_retries": 0, "max_reconnect_attempts": 0} for o in options)
    calls = markets[0].calls
    assert calls[0][0] == "scrips" and calls[0][1][0].inputtoken == "nse_fo|123"
    assert calls[1][0] == "index"
    assert {t.inputtoken for t in calls[1][1]} == {"nse_cm|Nifty 50", "bse_cm|SENSEX"}
    bridge.replace_subscriptions([subscription()])
    assert markets[0].calls[-1][0] == "remove_index"
    bridge.replace_subscriptions([])
    assert markets[0].closed and not orders[0].closed


def test_reconnect_drops_removed_subscription_and_keeps_order_feed(feeds):
    bridge, orders, markets, _, _, _ = feeds
    bridge.replace_subscriptions([subscription("1"), subscription("2")])
    first = markets[0]
    bridge._call(first.queue.put(None))
    wait_for(lambda: first.closed)
    bridge.replace_subscriptions([subscription("2")])
    wait_for(lambda: len(markets) == 2 and markets[1].calls)
    assert [t.instrument_token for _, tokens in markets[1].calls for t in tokens] == ["2"]
    assert len(orders) == 1


def test_order_feed_reconnect_and_typed_delivery(feeds):
    bridge, orders, markets, received, _, _ = feeds
    wait_for(lambda: orders)
    bridge._call(orders[0].queue.put(order_update()))
    wait_for(lambda: received)
    assert received[0].data.order_id == "K1"
    bridge._call(orders[0].queue.put(None))
    wait_for(lambda: len(orders) == 2)
    assert not markets


def test_market_message_mapping_scaling_and_control_filter(feeds):
    from neo_api_client.websocket.feed import SFeedIndex
    bridge, _, markets, received, _, _ = feeds
    bridge.replace_subscriptions([subscription("26000", "nse_cm", True)])
    message = SFeedIndex(type="index", exchange_segment="nse_cm", instrument_token="999",
                         name="Nifty 50", last_traded_price=23500.25, open_price=23000,
                         high_price=24000, low_price=22000, close_price=23000, change=500.25,
                         net_change_percent=1, yearly_high=25000, yearly_low=20000,
                         last_trade_time=1786442392, precision=2, multiplier=1)
    bridge._call(markets[0].queue.put(message))
    wait_for(lambda: received)
    assert received[0]["data"] == {"tk": "26000", "e": "nse_cm", "ltp": 23500.25, "exchange_timestamp": 1786442392}
    bridge._call(markets[0].queue.put({"type": "cas_change", "ref_price": 1}))
    bridge._call(markets[0].queue.put({"type": "scrip", "exchange_segment": "nse_fo", "instrument_token": "26000", "last_traded_price": 1}))
    time.sleep(0.02)
    assert len(received) == 1


def test_index_mapping_accepts_numeric_identity_and_case_variants(feeds):
    bridge, _, markets, received, _, _ = feeds
    bridge.replace_subscriptions([subscription("26000", "nse_cm", True)])
    for token, name in [("26000", "NIFTY"), ("999", "NIFTY 50")]:
        bridge._call(markets[0].queue.put({"type": "index", "exchange_segment": "nse_cm",
            "instrument_token": token, "name": name, "last_traded_price": 23500,
            "last_update_time": -1, "last_trade_time": 1786442392}))
    wait_for(lambda: len(received) == 2)
    assert all(m["data"]["tk"] == "26000" and m["data"]["exchange_timestamp"] == 1786442392 for m in received)
    bridge._call(markets[0].queue.put({"type": "scrip", "exchange_segment": "nse_cm",
        "instrument_token": "26000", "last_traded_price": 1}))
    time.sleep(0.02)
    assert len(received) == 2


def test_subscription_failure_rolls_back_and_closes_socket(feeds):
    bridge, _, markets, _, _, _ = feeds
    def failing(**kwargs):
        ws = FakeFeed(ConnectionError("offline"))
        markets.append(ws)
        return ws
    bridge.client.create_websocket = failing
    with pytest.raises(RuntimeError, match="failed"):
        bridge.replace_subscriptions([subscription()])
    assert not bridge._desired
    assert markets[0].closed


def test_relogin_restoration_retries_initial_transient_failure(feeds):
    bridge, _, markets, _, _, _ = feeds
    def recover(**kwargs):
        ws = FakeFeed(ConnectionError("offline") if not markets else None)
        markets.append(ws)
        return ws
    bridge.client.create_websocket = recover
    bridge.replace_subscriptions([subscription()], wait=False)
    wait_for(lambda: len(markets) >= 2 and markets[1].calls)
    assert [t.instrument_token for _, tokens in markets[1].calls for t in tokens] == ["123"]


def test_expired_auth_is_not_retried(feeds):
    from neo_api_client.websocket.feed.exceptions import AuthenticationError
    bridge, _, markets, _, expired, _ = feeds
    def failing(**kwargs):
        ws = FakeFeed(AuthenticationError("expired"))
        markets.append(ws)
        return ws
    bridge.client.create_websocket = failing
    with pytest.raises(RuntimeError, match="expired"):
        bridge.replace_subscriptions([subscription()])
    assert expired.is_set()
    time.sleep(0.06)
    assert len(markets) == 1


def test_rejected_order_connection_control_frame(feeds):
    bridge, orders, _, _, expired, _ = feeds
    wait_for(lambda: orders)
    bridge._call(asyncio.to_thread(lambda: None))
    orders[0].on_raw('{"type":"cn","ak":"not_ok"}')
    assert expired.is_set()


def test_broadcaster_reference_counting_exchange_identity_and_ist(monkeypatch):
    service = MagicMock()
    monkeypatch.setattr(ks, "_service", service)
    broadcaster, queue, loop = ks.KotakBroadcaster(), MagicMock(), MagicMock()
    broadcaster.register("one", ["123"], ["nse_fo"], ["CE"], queue, loop)
    broadcaster.register("two", ["123"], ["nse_fo"], ["CE"], queue, loop)
    broadcaster.register("bse", ["123"], ["bse_fo"], ["PE"], queue, loop)
    broadcaster.unregister("one")
    assert len(service.replace_market_subscriptions.call_args.args[0]) == 2
    broadcaster._process_tick({"tk": "123", "e": "nse_fo", "ltp": 100, "exchange_timestamp": 1786442392})
    broadcaster._process_tick({"tk": "123", "e": "nse_fo", "ltp": 101, "exchange_timestamp": 1786442393})
    payload = loop.call_soon_threadsafe.call_args.args[1]
    assert payload["right"] == "CE" and payload["time"] == 1786442392 + 19800
    loop.call_soon_threadsafe.assert_called_once()
    broadcaster.unregister("two")
    assert service.replace_market_subscriptions.call_args.args[0] == [subscription("123", "bse_fo")]
    broadcaster.unregister("bse")
    assert service.replace_market_subscriptions.call_args.args[0] == []
    assert not broadcaster._accumulators


def test_strike_replacement_failure_preserves_previous_registration(monkeypatch):
    service = MagicMock()
    monkeypatch.setattr(ks, "_service", service)
    broadcaster = ks.KotakBroadcaster()
    broadcaster.register("s", ["1"], ["nse_fo"], ["CE"], MagicMock(), MagicMock())
    service.replace_market_subscriptions.side_effect = ks.KotakError("failed")
    with pytest.raises(ks.KotakError):
        broadcaster.update_session_right("s", "CE", "2", "nse_fo", MagicMock(), MagicMock())
    assert broadcaster._session_tokens["s"] == {("nse_fo", "1")}


@pytest.mark.asyncio
async def test_installed_sdk_over_local_websockets(broker):
    """Exercise SDK handshakes, binary decoding, typed orders and reconnect."""
    from websockets.asyncio.server import serve
    service, client, _, _ = broker
    connections, market_messages, fills = {"order": [], "market": []}, [], []
    async def handler(socket):
        first = await socket.recv()
        kind = "order" if first.startswith("{type:cn,") else "market"
        if kind == "market":
            assert json.loads(first)["format"] == "native_batch"
        connections[kind].append(socket)
        if kind == "order":
            await socket.send(json.dumps({"type": "cn", "ak": "ok"}))
            await socket.send(order_update(1).model_dump_json(by_alias=True))
            await socket.send(order_update(3, "complete", "101").model_dump_json(by_alias=True))
            await socket.wait_closed()
        else:
            await socket.send(json.dumps({"message_code": 1117, "format": "native_batch",
                                          "exchanges": {"nse_cm": {"value": 1, "divider": 100}}}))
            async for raw in socket:
                request = json.loads(raw)
                if request.get("event") != "subscribeIndices":
                    continue
                assert request["inputtoken"] == "nse_cm|Nifty 50"
                await socket.send(json.dumps({"message_code": 1109,
                    "trading_symbols": {"nse_cm|Nifty 50": "Nifty 50-IN"}}))
                payload = struct.pack("<IiiiiiQiiidBi21s", 26000, 2300000, 2300000, 2400000,
                                      2200000, 2350025, 1786442392, 2500000, 2000000, 100,
                                      0.0, 2, 100, b"Nifty 50")
                await socket.send(struct.pack("<HHbBBBB", 9 + len(payload), 7207, 1, 0, 0, 1, 0) + payload)
    async def until(predicate):
        async def check():
            while not predicate():
                await asyncio.sleep(0.01)
        await asyncio.wait_for(check(), timeout=4)
    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        # Factories are the real installed SDK; only endpoint selection changes.
        factories = SimpleNamespace(
            create_order_feed=lambda **kw: client.create_order_feed(url=f"ws://127.0.0.1:{port}/orders", **kw),
            create_websocket=lambda **kw: client.create_websocket(url=f"ws://127.0.0.1:{port}/market", **kw))
        loop = asyncio.get_running_loop()
        service.register_fill_callback("K1", lambda *args: fills.append(args), loop)
        bridge = KotakFeedBridge(factories, service._on_message, market_messages.append,
                                 lambda: None, reconnect_delay=0.01, timeout=4)
        try:
            await asyncio.to_thread(bridge.replace_subscriptions, [subscription("26000", "nse_cm", True)])
            await until(lambda: market_messages and len(fills) == 2)
            assert market_messages[0]["data"]["ltp"] == 23500.25
            assert fills == [("K1", "BUY", 1, 100.0), ("K1", "BUY", 3, 101.0)]
            await connections["market"][0].close()
            await connections["order"][0].close()
            await until(lambda: len(connections["market"]) == len(connections["order"]) == 2
                        and len(market_messages) == 2)
            assert len(fills) == 2  # broker replay after reconnect is idempotent
        finally:
            await asyncio.to_thread(bridge.close)
        assert not bridge._thread.is_alive()


@pytest.mark.asyncio
async def test_real_sdk_rejected_order_session_stops_background_loop(broker, monkeypatch):
    from websockets.asyncio.server import serve
    service, client, _, _ = broker
    connections = []
    async def handler(socket):
        await socket.recv()
        connections.append(socket)
        await socket.send('{"type":"cn","ak":"not_ok"}')
        await socket.wait_closed()
    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        factory = client.create_order_feed
        monkeypatch.setattr(client, "create_order_feed", lambda **kw: factory(url=f"ws://127.0.0.1:{port}", **kw))
        service._start_order_feed()
        bridge = service._bridge
        async def stopped():
            while service.is_authenticated() or bridge._thread.is_alive():
                await asyncio.sleep(0.01)
        await asyncio.wait_for(stopped(), timeout=4)
        assert len(connections) == 1
        assert service._client is None and service._bridge is None
