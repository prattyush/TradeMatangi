"""Raw shared SDK callbacks must stay isolated through the real feed adapter."""
import asyncio
from unittest.mock import MagicMock, patch

import pytest

from app.services import breeze_service as breeze, market_data, simulation


class InlineBreezeAdapter(market_data.ProviderAdapter):
    async def open(self, source, instrument, delivery, loop):
        # The SDK/master are mocked; run their synchronous setup on this loop.
        return super().open(source, instrument, delivery, loop)


@pytest.mark.asyncio
@pytest.mark.parametrize("session_type", ["paper", "real"])
async def test_sensex_index_never_enters_primary_or_supplemental_option_feeds(session_type, monkeypatch):
    hub = market_data.MarketDataHub(InlineBreezeAdapter())
    monkeypatch.setattr(market_data, "get_hub", lambda: hub)
    sessions = [simulation.SimulationSession(session_id=f"user-{number}", symbol="BSESEN",
        date="2026-10-01", start_time="09:15:00", speed=1, session_type=session_type,
        instrument_type="options", strike_ce=72900, strike_pe=71900, expiry="2026-10-01")
        for number in range(2)]
    feeds = [market_data.SessionFeed(s, market_data.FeedGroup("breeze", real=session_type == "real")) for s in sessions]
    def mapping(stock, exchange, strike, right, expiry):
        return {f"{strike}-{right}": (strike, right)}
    with patch("app.services.broker_service._get_breeze", return_value=MagicMock()), \
         patch.object(breeze.BreezeStreamManager, "_build_scrip_map", side_effect=mapping), \
         patch.object(breeze._time, "time", return_value=1000) as clock:
        try:
            for feed in feeds:
                await feed.start()
            extra = {"symbol": "BSESEN", "right": "CE", "strike": 72000, "expiry": "2026-10-01",
                     "contract_key": "BSESEN:2026-10-01:72000:CE"}
            await hub.subscribe({"kind": "option", "exchange": "BFO", "underlying": "BSESEN",
                "strike": 72000, "right": "CE", "expiry": "2026-10-01"}, "extra", feeds[0].group,
                simulation._ContractTickQueue(sessions[0], extra))

            async def emit(raw, timestamp):
                clock.return_value = timestamp
                breeze._dispatch_multiplexed_ticks(raw)
                await asyncio.sleep(0)  # dispatch onto the engine queues

            index = {"symbol": "1!sensex", "stock_name": "SENSEX", "exchange": "BSE", "last": 72500}
            await emit(index, 1000)
            await emit({**index, "last": 72510}, 1001)
            for s in sessions:
                observed = []
                while not s.paper_tick_queue.empty():
                    observed.append(s.paper_tick_queue.get_nowait())
                assert len(observed) == 1, observed
                assert observed[0].get("right") is None
                assert observed[0]["close"] == 72500
            for strike, right, price, timestamp in ((72900, "CE", 105, 1002), (71900, "PE", 40, 1004), (72000, "CE", 150, 1006)):
                raw = {"symbol": f"4.1!{strike}-{right}", "OI": 100, "last": price}
                await emit(raw, timestamp)
                # Interleave an index tick while the option candle is open.
                await emit({**index, "last": 71500}, timestamp)
                for s in sessions:
                    underlying = s.paper_tick_queue.get_nowait()
                    assert underlying.get("right") is None
                    assert s.paper_tick_queue.empty()
                await emit({**raw, "last": price + 1}, timestamp + 1)
                for number, s in enumerate(sessions):
                    if strike == 72000 and number == 1:
                        assert s.paper_tick_queue.empty()
                        continue
                    payload = s.paper_tick_queue.get_nowait()
                    assert (payload["right"], payload["strike"], payload["close"]) == (right, strike, price)
                    assert s.paper_tick_queue.empty()
        finally:
            hub.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("session_type", ["paper", "real"])
async def test_breeze_live_task_sse_and_order_evaluation_keep_option_premiums(session_type, monkeypatch):
    import json
    from datetime import datetime, timezone
    hub = market_data.MarketDataHub(InlineBreezeAdapter())
    monkeypatch.setattr(market_data, "get_hub", lambda: hub)
    monkeypatch.setattr(market_data, "selected_provider", lambda: "breeze")
    s = simulation.SimulationSession(session_id=f"breeze-e2e-{session_type}", symbol="BSESEN",
        date="2026-10-01", start_time="09:15:00", speed=1, session_type=session_type,
        instrument_type="options", strike=72900, strike_ce=72900, strike_pe=71900, expiry="2026-10-01")
    s.resume_event.set()
    simulation._sessions[s.session_id] = s
    base = int(datetime(2026, 10, 1, 4, tzinfo=timezone.utc).timestamp())
    def mapping(stock, exchange, strike, right, expiry):
        return {f"{strike}-{right}": (strike, right)}
    async def inline_thread(fn, *args, **kwargs):
        return fn(*args, **kwargs)
    with patch("app.services.broker_service._get_breeze", return_value=MagicMock()), \
         patch.object(breeze.BreezeStreamManager, "_build_scrip_map", side_effect=mapping), \
         patch.object(breeze._time, "time", return_value=base) as clock, \
         patch("asyncio.to_thread", side_effect=inline_thread), \
         patch("app.services.broker_service.fetch_historical"), \
         patch("app.services.options_service.fetch_options_historical"), \
         patch("app.services.options_service.options_iter_ticks", return_value=iter(())), \
         patch("app.services.data_loader.iter_ticks", return_value=iter(())), \
         patch.object(simulation, "iter_ticks", return_value=iter(())), \
         patch("app.services.order_service.check_orders", return_value=[]) as check_orders, \
         patch("app.services.strategy_service.on_tick") as strategy_tick, \
         patch("app.services.kotak_service.get_service") as broker:
        runner = simulation._run_real_session if session_type == "real" else simulation._run_paper_session
        task = asyncio.create_task(runner(s))
        try:
            async def wait_live():
                while s.paper_stream_source != "breeze":
                    assert not task.done()
                    await asyncio.sleep(0)
            await asyncio.wait_for(wait_live(), 2)
            # Six seconds alternate index ticks with CE/PE prices. Index ticks
            # are broadcast while the option candles are accumulating too.
            for second in range(6):
                clock.return_value = base + second
                for raw in (
                    {"symbol": "1!sensex", "stock_name": "SENSEX", "exchange": "BSE", "last": 71500 + second},
                    {"symbol": "4.1!72900-CE", "OI": 100, "last": 105 + second},
                    {"symbol": "4.1!71900-PE", "OI": 100, "last": 40 + second},
                ):
                    breeze._dispatch_multiplexed_ticks(raw)
                await asyncio.sleep(0)
                async def drained():
                    while not s.paper_tick_queue.empty():
                        assert not task.done()
                        await asyncio.sleep(0)
                await asyncio.wait_for(drained(), 1)
            assert not task.done()
            assert (s.last_price_ce, s.last_price_pe) == (109, 44)
            assert check_orders.call_count == 15
            for call in check_orders.call_args_list:
                price = call.args[1]
                right = call.kwargs["tick_right"]
                assert (71500 <= price <= 71504) if right is None else (105 <= price <= 109) if right == "CE" else (40 <= price <= 44)
            if session_type == "paper":
                assert strategy_tick.call_count == 15
                assert all(call.args[1]["close"] < 200 for call in strategy_tick.call_args_list if call.args[2])
            broker.return_value.place_options_limit_order.assert_not_called()
            from app.routers.stream import stream_session
            response = await stream_session(s.session_id, user_id=s.user_id,
                request_user_id=s.user_id, last_event_id=0, last_event_id_header=None)
            events = [await anext(response.body_iterator) for _ in range(s.queue.latest_id())]
            ticks = [json.loads(event.split('data: ', 1)[1]) for event in events if '"type": "tick"' in event]
            assert len(ticks) == 15
            assert all(tick["close"] < 200 for tick in ticks if tick.get("right"))
            await response.body_iterator.aclose()
        finally:
            s.state = simulation.SimulationState.ENDED
            s.paper_tick_queue.close()
            task.cancel()
            await task
            simulation._sessions.pop(s.session_id, None)
            hub.shutdown()
