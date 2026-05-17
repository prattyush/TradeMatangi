import asyncio
import json
import pytest
import pandas as pd
import numpy as np
from unittest.mock import patch

from app.services import simulation as sim
from app.models.schemas import SimulationState


def make_tiny_df(n_seconds: int = 5) -> pd.DataFrame:
    start = pd.Timestamp("2026-05-06 09:15:00")
    idx = pd.date_range(start, periods=n_seconds, freq="s")
    data = {
        "open": [24200.0] * n_seconds,
        "high": [24210.0] * n_seconds,
        "low": [24190.0] * n_seconds,
        "close": [24205.0] * n_seconds,
        "volume": [0.0] * n_seconds,
    }
    return pd.DataFrame(data, index=idx)


@pytest.fixture(autouse=True)
def clean_sessions():
    sim._sessions.clear()
    yield
    sim._sessions.clear()


@pytest.fixture(autouse=True)
def no_wallet():
    with patch("app.services.wallet_service.get_balance", return_value=150_000.0), \
         patch("app.services.wallet_service._write_wallet_to_db"), \
         patch("app.services.simulation._upsert_session_to_db"):
        yield


class TestCreateSession:
    def test_returns_session_with_id(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0)
        assert s.session_id
        assert s.symbol == "NIFTY"
        assert s.state == SimulationState.IDLE

    def test_session_registered(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0)
        assert sim.get_session(s.session_id) is s

    def test_unique_ids_per_session(self):
        s1 = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0)
        s2 = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0)
        assert s1.session_id != s2.session_id


@pytest.mark.asyncio
class TestRunSession:
    async def test_emits_started_and_ended_events(self, tmp_path):
        df = make_tiny_df(3)
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pkl)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 0.0)
            sim.start_session(s)
            await asyncio.sleep(0.1)

        events = []
        while not s.queue.empty():
            events.append(json.loads(s.queue.get_nowait()))

        types = [e["type"] for e in events]
        assert "session_started" in types
        assert "session_ended" in types

    async def test_emits_tick_events(self, tmp_path):
        n = 4
        df = make_tiny_df(n)
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pkl)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 0.0)
            sim.start_session(s)
            await asyncio.sleep(0.2)

        events = []
        while not s.queue.empty():
            events.append(json.loads(s.queue.get_nowait()))

        tick_events = [e for e in events if e["type"] == "tick"]
        assert len(tick_events) == n

    def test_pause_sets_paused_state_and_clears_event(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0)
        s.state = SimulationState.RUNNING
        sim.pause_session(s)
        assert s.state == SimulationState.PAUSED
        assert not s.resume_event.is_set()

    def test_resume_sets_running_state_and_sets_event(self):
        s = sim.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0)
        s.state = SimulationState.RUNNING
        sim.pause_session(s)
        sim.resume_session(s)
        assert s.state == SimulationState.RUNNING
        assert s.resume_event.is_set()
