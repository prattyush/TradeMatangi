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


class TestBackfillBarHistory:
    """Tests for _backfill_bar_history — last-15-bars on first hook fire."""

    def _make_df(self, date: str, n_seconds: int) -> "pd.DataFrame":
        start = pd.Timestamp(f"{date} 09:15:00", tz="UTC")
        idx = pd.date_range(start, periods=n_seconds, freq="s")
        return pd.DataFrame(
            {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5},
            index=idx,
        )

    def test_equity_backfill_returns_correct_candle_count(self):
        date = "2026-05-06"
        df = self._make_df(date, 360)  # 6 min of second data → 2 completed 3-min candles
        slot_ts = int(pd.Timestamp(f"{date} 09:21:00", tz="UTC").timestamp())

        session = sim.create_session("NIFTY", date, "09:15:00", 1.0)

        with patch("app.services.data_loader.load_dataframe", return_value=df):
            result = sim._backfill_bar_history(session, None, slot_ts)

        assert len(result) == 2
        # Oldest bar should start at market open
        assert result[0]["time"].startswith(f"{date}T09:15:00")
        assert result[1]["time"].startswith(f"{date}T09:18:00")
        assert result[0]["open"] == 100.0

    def test_options_backfill_uses_correct_strike_for_right(self):
        date = "2026-05-06"
        df = self._make_df(date, 360)
        slot_ts = int(pd.Timestamp(f"{date} 09:21:00", tz="UTC").timestamp())

        session = sim.create_session(
            "NIFTY", date, "09:15:00", 1.0,
            instrument_type="options",
            strike=24400, expiry="2026-05-08",
            right=None, strike_ce=24400, strike_pe=24400,
        )

        captured = {}

        def fake_load(symbol, date_, strike, expiry, right):
            captured["strike"] = strike
            captured["right"] = right
            return df

        with patch("app.services.options_service.load_options_dataframe", fake_load):
            result = sim._backfill_bar_history(session, "CE", slot_ts)

        assert captured["strike"] == 24400
        assert captured["right"] == "CE"
        assert len(result) == 2

    def test_backfill_returns_empty_list_on_exception(self):
        date = "2026-05-06"
        slot_ts = int(pd.Timestamp(f"{date} 09:21:00", tz="UTC").timestamp())
        session = sim.create_session("NIFTY", date, "09:15:00", 1.0)

        with patch("app.services.data_loader.load_dataframe", side_effect=FileNotFoundError("no file")):
            result = sim._backfill_bar_history(session, None, slot_ts)

        assert result == []
