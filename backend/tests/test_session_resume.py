"""
Tests for paper/real trading session resume.

When a paper or real session stops (network failure, page refresh) and the user
clicks Start again for the same (user, symbol, date, session_type), the backend
must reuse the same session_id so prior trades and positions remain visible.
"""
import pytest
from unittest.mock import patch, MagicMock

from app.services import simulation as sim
from app.models.schemas import SimulationState


@pytest.fixture(autouse=True)
def clean_sessions():
    sim._sessions.clear()
    yield
    sim._sessions.clear()


@pytest.fixture(autouse=True)
def no_wallet():
    with patch("app.services.wallet_service.get_balance", return_value=100_000.0), \
         patch("app.services.wallet_service._write_wallet_to_db"), \
         patch("app.services.simulation._upsert_session_to_db"):
        yield


# ── find_session_by_context ────────────────────────────────────────────────


class TestFindSessionByContext:
    def test_returns_none_for_sim(self):
        """Simulation sessions always create fresh — never resume."""
        result = sim.find_session_by_context("user1", "NIFTY", "2026-06-05", "sim")
        assert result is None

    def test_returns_none_when_db_empty(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {"Items": []}
        mock_db = MagicMock()
        mock_db.Table.return_value = mock_table
        with patch("app.services.simulation.get_dynamodb_resource" if False else "app.services.db.get_dynamodb_resource"), \
             patch("app.services.simulation._find_table", mock_table, create=True):
            # Patch the internal DynamoDB call directly
            with patch("app.services.db.get_dynamodb_resource", return_value=mock_db):
                result = sim.find_session_by_context("user1", "NIFTY", "2026-06-05", "paper")
        assert result is None

    def test_returns_none_for_different_date(self):
        mock_table = MagicMock()
        mock_table.query.return_value = {
            "Items": [{
                "session_id": "old-session",
                "user_id": "user1",
                "symbol": "NIFTY",
                "date": "2026-06-04",  # different date
                "session_type": "paper",
                "created_at": 1000,
            }]
        }
        mock_db = MagicMock()
        mock_db.Table.return_value = mock_table
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_db):
            result = sim.find_session_by_context("user1", "NIFTY", "2026-06-05", "paper")
        assert result is None

    def test_returns_matching_paper_session(self):
        record = {
            "session_id": "paper-session-1",
            "user_id": "user1",
            "symbol": "NIFTY",
            "date": "2026-06-05",
            "session_type": "paper",
            "instrument_type": "equity",
            "start_time": "09:15:00",
            "speed": "1.0",
            "session_capital": "100000",
            "state": "ended",
            "created_at": 1000,
        }
        mock_table = MagicMock()
        mock_table.query.return_value = {"Items": [record]}
        mock_db = MagicMock()
        mock_db.Table.return_value = mock_table
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_db):
            result = sim.find_session_by_context("user1", "NIFTY", "2026-06-05", "paper")
        assert result is not None
        assert result["session_id"] == "paper-session-1"

    def test_returns_most_recent_when_multiple(self):
        records = [
            {
                "session_id": "old-session",
                "user_id": "user1",
                "symbol": "NIFTY",
                "date": "2026-06-05",
                "session_type": "paper",
                "created_at": 1000,
            },
            {
                "session_id": "new-session",
                "user_id": "user1",
                "symbol": "NIFTY",
                "date": "2026-06-05",
                "session_type": "paper",
                "created_at": 9999,
            },
        ]
        mock_table = MagicMock()
        mock_table.query.return_value = {"Items": records}
        mock_db = MagicMock()
        mock_db.Table.return_value = mock_table
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_db):
            result = sim.find_session_by_context("user1", "NIFTY", "2026-06-05", "paper")
        assert result["session_id"] == "new-session"

    def test_returns_none_on_db_error(self):
        mock_db = MagicMock()
        mock_db.Table.side_effect = Exception("DynamoDB unavailable")
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_db):
            result = sim.find_session_by_context("user1", "NIFTY", "2026-06-05", "paper")
        assert result is None  # errors are swallowed; fresh session will be created


# ── rebuild_session_from_db ────────────────────────────────────────────────


class TestRebuildSessionFromDb:
    def _make_record(self, session_id="resumed-session-id", session_type="paper", instrument_type="equity"):
        return {
            "session_id": session_id,
            "user_id": "user1",
            "symbol": "NIFTY",
            "date": "2026-06-05",
            "start_time": "09:15:00",
            "speed": "1.0",
            "session_capital": "100000",
            "state": "ended",
            "session_type": session_type,
            "instrument_type": instrument_type,
            "created_at": 5000,
        }

    def test_reuses_same_session_id(self):
        record = self._make_record()
        with patch("app.services.guardrail_service.initialize_guardrails"):
            session = sim.rebuild_session_from_db(record, "user1")
        assert session.session_id == "resumed-session-id"

    def test_registers_in_sessions_dict(self):
        record = self._make_record()
        with patch("app.services.guardrail_service.initialize_guardrails"):
            session = sim.rebuild_session_from_db(record, "user1")
        assert sim.get_session("resumed-session-id") is session

    def test_resume_event_is_set(self):
        record = self._make_record()
        with patch("app.services.guardrail_service.initialize_guardrails"):
            session = sim.rebuild_session_from_db(record, "user1")
        assert session.resume_event.is_set()

    def test_preserves_created_at_from_db(self):
        record = self._make_record()
        with patch("app.services.guardrail_service.initialize_guardrails"):
            session = sim.rebuild_session_from_db(record, "user1")
        assert session.created_at == 5000

    def test_rebuilds_options_session(self):
        record = self._make_record(instrument_type="options")
        record["strike"] = 24000
        record["expiry"] = "2026-06-26"
        record["right"] = "CE"
        with patch("app.services.guardrail_service.initialize_guardrails"):
            session = sim.rebuild_session_from_db(record, "user1")
        assert session.instrument_type == "options"
        assert session.strike == 24000
        assert session.expiry == "2026-06-26"
        assert session.right == "CE"

    def test_calls_initialize_guardrails(self):
        record = self._make_record()
        with patch("app.services.guardrail_service.initialize_guardrails") as mock_gr:
            sim.rebuild_session_from_db(record, "user1")
        mock_gr.assert_called_once()

    def test_uses_provided_brokerage_and_interval(self):
        record = self._make_record()
        with patch("app.services.guardrail_service.initialize_guardrails"):
            session = sim.rebuild_session_from_db(record, "user1", brokerage_per_order=20.0, strategy_interval_secs=300)
        assert session.brokerage_per_order == 20.0
        assert session.strategy_interval_secs == 300


# ── created_at written at session creation ─────────────────────────────────


class TestCreatedAtField:
    def test_create_session_sets_created_at(self):
        s = sim.create_session("NIFTY", "2026-06-05", "09:15:00", 1.0, session_type="paper")
        assert s.created_at > 0

    def test_sim_session_also_sets_created_at(self):
        s = sim.create_session("NIFTY", "2026-06-05", "09:15:00", 1.0, session_type="sim")
        assert s.created_at > 0

    def test_two_sessions_have_increasing_created_at(self):
        s1 = sim.create_session("NIFTY", "2026-06-05", "09:15:00", 1.0)
        s2 = sim.create_session("NIFTY", "2026-06-05", "09:15:00", 1.0)
        # Both have created_at set; s2 >= s1 (monotonic, usually strictly greater)
        assert s2.created_at >= s1.created_at
