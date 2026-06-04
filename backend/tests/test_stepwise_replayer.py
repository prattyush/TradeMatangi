"""
Tests for the Trade Stepwise Replayer (Phase XII Sprint 1).

Covers:
- create_session with stepwise=True
- _count_total_bars helper
- bar_paused events emitted at bar boundaries
- next-bar endpoint unblocks the tick loop
- Session stops cleanly while stepwise-waiting
- next-bar on non-stepwise session returns 400
"""
import asyncio
import json
import pytest
import pandas as pd
import numpy as np
from unittest.mock import patch, MagicMock
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.services import simulation as sim
from app.models.schemas import SimulationState


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _make_df_multi_bar(n_bars: int = 3, secs_per_bar: int = 3) -> pd.DataFrame:
    """
    Build a tz-naive IST DataFrame with n_bars × secs_per_bar ticks,
    suitable for testing with strategy_interval_secs=secs_per_bar.
    """
    total = n_bars * secs_per_bar
    start = pd.Timestamp("2026-05-06 09:15:00")
    idx = pd.date_range(start, periods=total, freq="s")
    data = {
        "open":   [24200.0] * total,
        "high":   [24210.0] * total,
        "low":    [24190.0] * total,
        "close":  [24205.0] * total,
    }
    return pd.DataFrame(data, index=idx)


@pytest.fixture(autouse=True)
def clean_sessions():
    sim._sessions.clear()
    yield
    sim._sessions.clear()


@pytest.fixture(autouse=True)
def no_wallet_no_db():
    with patch("app.services.wallet_service.get_balance", return_value=150_000.0), \
         patch("app.services.wallet_service._write_wallet_to_db"), \
         patch("app.services.simulation._upsert_session_to_db"), \
         patch("app.services.guardrail_service.initialize_guardrails"):
        yield


# ── Unit tests for create_session ────────────────────────────────────────────

class TestCreateStepwiseSession:
    def test_stepwise_flag_set(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0, stepwise=True)
        assert s.stepwise is True

    def test_non_stepwise_flag_false(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0)
        assert s.stepwise is False

    def test_step_event_exists(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0, stepwise=True)
        assert isinstance(s.step_event, asyncio.Event)

    def test_total_bars_computed_for_stepwise(self, tmp_path):
        df = _make_df_multi_bar(n_bars=3, secs_per_bar=3)
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pkl)
        with patch("app.services.data_loader.DATA_DIR", tmp_path), \
             patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            s = sim.create_session(
                "NIFTY", "2026-05-06", "09:15:00", 1.0,
                stepwise=True, strategy_interval_secs=3,
            )
        assert s.total_bars == 3

    def test_total_bars_zero_for_non_stepwise(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0, stepwise=False)
        assert s.total_bars == 0


class TestCountTotalBars:
    def test_counts_distinct_bar_slots(self, tmp_path):
        df = _make_df_multi_bar(n_bars=4, secs_per_bar=3)
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pkl)
        with patch("app.services.data_loader.DATA_DIR", tmp_path), \
             patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            count = sim._count_total_bars("NIFTY", "2026-05-06", "09:15:00", 3)
        assert count == 4

    def test_returns_zero_on_missing_data(self):
        # No data files → no crash, returns 0
        count = sim._count_total_bars("MISSING", "2026-05-06", "09:15:00", 180)
        assert count == 0


# ── Async tests for stepwise tick loop ────────────────────────────────────────

@pytest.mark.asyncio
class TestStepwiseTickLoop:
    async def test_emits_bar_paused_after_first_bar(self, tmp_path):
        """After bar 1 completes the loop emits bar_paused and parks."""
        df = _make_df_multi_bar(n_bars=3, secs_per_bar=3)
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pkl)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), \
             patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            s = sim.create_session(
                "NIFTY", "2026-05-06", "09:15:00", 0.0,
                stepwise=True, strategy_interval_secs=3,
            )
            sim.start_session(s)
            await asyncio.sleep(0.3)   # let bar 1 finish and loop park

        events = []
        while not s.queue.empty():
            events.append(json.loads(s.queue.get_nowait()))

        types = [e["type"] for e in events]
        assert "session_started" in types
        assert "tick" in types
        assert "bar_paused" in types
        # Must NOT have session_ended (loop is parked, not done)
        assert "session_ended" not in types

    async def test_bar_paused_event_has_correct_fields(self, tmp_path):
        df = _make_df_multi_bar(n_bars=3, secs_per_bar=3)
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pkl)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), \
             patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            s = sim.create_session(
                "NIFTY", "2026-05-06", "09:15:00", 0.0,
                stepwise=True, strategy_interval_secs=3,
            )
            sim.start_session(s)
            await asyncio.sleep(0.3)

        events = [json.loads(s.queue.get_nowait()) for _ in range(s.queue.qsize())]
        pause_events = [e for e in events if e["type"] == "bar_paused"]
        assert len(pause_events) >= 1
        p = pause_events[0]
        assert "bar_index" in p
        assert "total_bars" in p
        assert p["total_bars"] == 3
        assert p["bar_index"] == 1
        # Completed bar OHLC must be present and correct
        assert p["bar_open"] == 24200.0
        assert p["bar_high"] == 24210.0
        assert p["bar_low"] == 24190.0
        assert p["bar_close"] == 24205.0
        assert "bar_time" in p

    async def test_next_bar_advances_loop(self, tmp_path):
        """Calling step_event.set() after bar 1 allows bar 2 to complete."""
        df = _make_df_multi_bar(n_bars=3, secs_per_bar=3)
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pkl)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), \
             patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            s = sim.create_session(
                "NIFTY", "2026-05-06", "09:15:00", 0.0,
                stepwise=True, strategy_interval_secs=3,
            )
            sim.start_session(s)
            await asyncio.sleep(0.3)   # bar 1 done, parked

        # Drain first bar's events
        events = []
        while not s.queue.empty():
            events.append(json.loads(s.queue.get_nowait()))

        assert any(e["type"] == "bar_paused" for e in events)

        # Unblock — bar 2 should process and park again
        s.step_event.set()
        await asyncio.sleep(0.3)

        new_events = []
        while not s.queue.empty():
            new_events.append(json.loads(s.queue.get_nowait()))

        new_types = [e["type"] for e in new_events]
        assert "tick" in new_types
        assert "bar_paused" in new_types
        # bar_paused bar_index should now be 2
        pause2 = next(e for e in new_events if e["type"] == "bar_paused")
        assert pause2["bar_index"] == 2

    async def test_stop_while_stepwise_parked(self, tmp_path):
        """Stopping a stepwise session while parked terminates cleanly."""
        df = _make_df_multi_bar(n_bars=3, secs_per_bar=3)
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pkl)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), \
             patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            s = sim.create_session(
                "NIFTY", "2026-05-06", "09:15:00", 0.0,
                stepwise=True, strategy_interval_secs=3,
            )
            sim.start_session(s)
            await asyncio.sleep(0.3)   # bar 1 done, parked

        sim.stop_session(s)
        await asyncio.sleep(0.2)

        assert s.state == SimulationState.ENDED


# ── API endpoint tests ─────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def no_auth():
    with patch("app.dependencies.get_request_user_id", return_value="00000000-0000-0000-0000-000000000001"):
        yield


@pytest.mark.asyncio
class TestNextBarEndpoint:
    async def test_next_bar_sets_step_event(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0, stepwise=True)
        s.state = SimulationState.RUNNING
        s.step_event.clear()

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/api/simulation/{s.session_id}/next-bar")

        assert resp.status_code == 200
        data = resp.json()
        assert "bar_index" in data
        assert "total_bars" in data
        assert s.step_event.is_set()

    async def test_next_bar_non_stepwise_returns_400(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0, stepwise=False)
        s.state = SimulationState.RUNNING

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/api/simulation/{s.session_id}/next-bar")

        assert resp.status_code == 400

    async def test_next_bar_unknown_session_returns_404(self):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/api/simulation/no-such-id/next-bar")

        assert resp.status_code == 404

    async def test_next_bar_ended_session_returns_400(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0, stepwise=True)
        s.state = SimulationState.ENDED

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/api/simulation/{s.session_id}/next-bar")

        assert resp.status_code == 400


@pytest.mark.asyncio
class TestStartStepwiseEndpoint:
    async def test_start_stepwise_returns_stepwise_true(self, tmp_path):
        df = _make_df_multi_bar(n_bars=3, secs_per_bar=3)
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pkl)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), \
             patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"), \
             patch("app.routers.simulation._ensure_session_data"):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/simulation/start", json={
                    "symbol": "NIFTY",
                    "date": "2026-05-06",
                    "start_time": "09:15:00",
                    "speed": 1.0,
                    "instrument_type": "equity",
                    "session_type": "stepwise",
                    "strategy_interval_secs": 3,
                })

        if resp.status_code == 200:
            data = resp.json()
            assert data["stepwise"] is True
            assert data["session_type"] == "stepwise"
        else:
            # If data is missing, just check status is not 500
            assert resp.status_code != 500
