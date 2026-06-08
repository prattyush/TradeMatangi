"""
Tests for paper/real trading session resume.

When a paper or real session stops (network failure, page refresh) and the user
clicks Start again for the same (user, symbol, date, session_type), the backend
must reuse the same session_id so prior trades and positions remain visible.
"""
import pytest
from unittest.mock import patch, MagicMock

from app.services import simulation as sim
from app.services import trading as trading_svc
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

    def test_restores_strike_ce_pe_from_db(self):
        """strike_ce and strike_pe saved in DB are restored on resume."""
        record = self._make_record(instrument_type="options")
        record["strike"] = 24500
        record["strike_ce"] = 24600
        record["strike_pe"] = 24400
        record["expiry"] = "2026-06-26"
        record["right"] = None
        with patch("app.services.guardrail_service.initialize_guardrails"):
            session = sim.rebuild_session_from_db(record, "user1")
        assert session.strike_ce == 24600
        assert session.strike_pe == 24400

    def test_override_strikes_take_priority_over_db(self):
        """Caller-provided strikes override DB values — user changed OTM on restart."""
        record = self._make_record(instrument_type="options")
        record["strike"] = 24500
        record["strike_ce"] = 24600  # DB has old OTM=2
        record["strike_pe"] = 24400
        record["expiry"] = "2026-06-26"
        record["right"] = None
        with patch("app.services.guardrail_service.initialize_guardrails"):
            session = sim.rebuild_session_from_db(
                record, "user1",
                strike_ce=24750,  # new OTM=5
                strike_pe=24250,
            )
        assert session.strike_ce == 24750
        assert session.strike_pe == 24250

    def test_falls_back_to_strike_when_ce_pe_absent(self):
        """Old sessions without strike_ce/pe in DB default both to ATM."""
        record = self._make_record(instrument_type="options")
        record["strike"] = 24500
        record["expiry"] = "2026-06-26"
        record["right"] = None
        # No strike_ce or strike_pe in record
        with patch("app.services.guardrail_service.initialize_guardrails"):
            session = sim.rebuild_session_from_db(record, "user1")
        assert session.strike_ce == 24500
        assert session.strike_pe == 24500


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


# ── reload_trades_from_db ──────────────────────────────────────────────────


class TestReloadTradesFromDb:
    """Verify that reload_trades_from_db repopulates _trades from DynamoDB on resume."""

    def _raw_trade(self, session_id="sess-1", right=None):
        item = {
            "trade_id": "t1",
            "user_id": "user1",
            "symbol": "NIFTY",
            "side": "BUY",
            "quantity": 50,
            "price": "180.00",
            "timestamp": 1000000,
            "session_id": session_id,
            "instrument_type": "options" if right else "equity",
            "commission": "1.5",
            "session_type": "paper",
        }
        if right:
            item["right"] = right
            item["strike"] = 24000
            item["expiry"] = "2026-06-26"
        return item

    def test_loads_trades_into_memory(self):
        raw = [self._raw_trade()]
        with patch("app.services.analysis_service.get_trades_for_session", return_value=raw):
            trading_svc.reload_trades_from_db("sess-1")
        trades = trading_svc.get_trades("sess-1")
        assert len(trades) == 1
        assert trades[0].quantity == 50
        assert trades[0].side.value == "BUY"

    def test_loads_options_trades_with_right(self):
        raw = [self._raw_trade(right="CE")]
        with patch("app.services.analysis_service.get_trades_for_session", return_value=raw):
            trading_svc.reload_trades_from_db("sess-1")
        trades = trading_svc.get_trades("sess-1")
        assert trades[0].right == "CE"
        assert trades[0].strike == 24000

    def test_empty_when_no_db_trades(self):
        with patch("app.services.analysis_service.get_trades_for_session", return_value=[]):
            trading_svc.reload_trades_from_db("sess-empty")
        assert trading_svc.get_trades("sess-empty") == []

    def test_survives_db_error(self):
        with patch("app.services.analysis_service.get_trades_for_session", side_effect=Exception("DB down")):
            trading_svc.reload_trades_from_db("sess-err")
        assert trading_svc.get_trades("sess-err") == []

    def test_rebuild_session_restores_trades(self):
        """rebuild_session_from_db must call reload_trades_from_db."""
        record = {
            "session_id": "rsess-1", "user_id": "user1", "symbol": "NIFTY",
            "date": "2026-06-05", "start_time": "09:15:00", "speed": "1.0",
            "session_capital": "100000", "state": "ended",
            "session_type": "paper", "instrument_type": "equity", "created_at": 1000,
        }
        raw = [self._raw_trade(session_id="rsess-1")]
        with patch("app.services.guardrail_service.initialize_guardrails"), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=raw):
            sim.rebuild_session_from_db(record, "user1")
        trades = trading_svc.get_trades("rsess-1")
        assert len(trades) == 1
        assert trades[0].session_id == "rsess-1"
