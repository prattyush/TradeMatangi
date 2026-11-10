"""
Tests for two guardrails added with Phase 24:
  - Max per entry: an entry is reduced to a per-entry cap (never rejected unless one lot is too big).
  - Minimum gap between entries: a new entry must wait N minutes after the previous entry filled.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from unittest.mock import MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.models.schemas import Position, SimulationState, Trade, TradeSide
from app.services import guardrail_service as gsvc
from app.services import order_service

POS_PATH = "app.services.trading.get_position"
TRADES_PATH = "app.services.trading.get_trades"
SESSION = "entry-guardrails-session"


@dataclass
class MockSession:
    session_id: str = SESSION
    session_capital: float = 100_000.0
    symbol: str = "NIFTY"
    instrument_type: str = "equity"
    right: str | None = None
    session_type: str = "sim"
    current_time: int = 34_500
    guardrail_maxentry_enabled: bool = True
    guardrail_maxentry_mode: str = "percentage"
    guardrail_maxentry_pct: float = 12.0
    guardrail_maxentry_value: float = 0.0
    guardrail_mingap_enabled: bool = True
    guardrail_mingap_minutes: int = 5
    queue: object = field(default_factory=lambda: MagicMock())


def _pos(side="FLAT", qty=0, avg=0.0):
    return Position(symbol="NIFTY", quantity=qty, avg_entry_price=avg, side=side)


def _trade(side: TradeSide, qty: int, ts: int, right=None, strike=None, expiry=None) -> Trade:
    return Trade(user_id="u", symbol="NIFTY", side=side, quantity=qty, price=100.0, timestamp=ts,
                 session_id=SESSION, right=right, strike=strike, expiry=expiry)


def _margin(rate: float):
    return patch("app.services.guardrail_service._capital_margin_rate", return_value=rate)


# ── Max per entry ─────────────────────────────────────────────────────────────

class TestCapEntryQuantity:
    def test_reduces_24_percent_entry_to_12_percent(self):
        sess = MockSession()
        # 24% of 100,000 at Rs100 = 240 shares; 12% cap = 120 shares.
        with patch(POS_PATH, return_value=_pos()), _margin(1.0):
            qty, requested = gsvc.cap_entry_quantity(sess, 100.0, 240, "BUY")
        assert (qty, requested) == (120, 240)

    def test_equity_margin_counts_only_the_margin_used(self):
        sess = MockSession()
        # 20% margin: 12,000 cap buys 12,000 / (100 * 0.2) = 600 shares.
        with patch(POS_PATH, return_value=_pos()), _margin(0.2):
            qty, requested = gsvc.cap_entry_quantity(sess, 100.0, 1000, "BUY")
        assert (qty, requested) == (600, 1000)

    def test_smaller_entry_is_unchanged(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_pos()), _margin(1.0):
            assert gsvc.cap_entry_quantity(sess, 100.0, 100, "BUY") == (100, None)

    def test_exactly_at_cap_is_unchanged(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_pos()), _margin(1.0):
            assert gsvc.cap_entry_quantity(sess, 100.0, 120, "BUY") == (120, None)

    def test_disabled_does_nothing(self):
        sess = MockSession(guardrail_maxentry_enabled=False)
        with patch(POS_PATH, return_value=_pos()), _margin(1.0):
            assert gsvc.cap_entry_quantity(sess, 100.0, 240, "BUY") == (240, None)

    def test_value_mode(self):
        sess = MockSession(guardrail_maxentry_mode="value", guardrail_maxentry_value=5_000.0)
        with patch(POS_PATH, return_value=_pos()), _margin(1.0):
            assert gsvc.cap_entry_quantity(sess, 100.0, 240, "BUY") == (50, 240)

    def test_option_quantity_rounds_down_to_whole_lots(self):
        sess = MockSession(instrument_type="options", right="CE")
        # Rs100 premium, lot 75 => one lot Rs7,500; 12% cap Rs12,000 allows 1 lot (75).
        with patch(POS_PATH, return_value=_pos()), _margin(1.0):
            qty, requested = gsvc.cap_entry_quantity(sess, 100.0, 225, "BUY", right="CE", lot_size=75)
        assert (qty, requested) == (75, 225)

    def test_one_lot_above_cap_is_rejected(self):
        sess = MockSession(instrument_type="options", right="CE")
        # One lot costs Rs15,000 against a Rs12,000 cap.
        with patch(POS_PATH, return_value=_pos()), _margin(1.0):
            with pytest.raises(ValueError, match="MAXSIZE: one lot costs"):
                gsvc.cap_entry_quantity(sess, 200.0, 75, "BUY", right="CE", lot_size=75)

    def test_value_mode_zero_rejects(self):
        sess = MockSession(guardrail_maxentry_mode="value", guardrail_maxentry_value=0.0)
        with patch(POS_PATH, return_value=_pos()), _margin(1.0):
            with pytest.raises(ValueError):
                gsvc.cap_entry_quantity(sess, 100.0, 10, "BUY")

    def test_pure_exit_is_never_reduced(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_pos("LONG", 500, 90.0)), _margin(1.0):
            assert gsvc.cap_entry_quantity(sess, 100.0, 500, "SELL") == (500, None)

    def test_reversal_caps_only_the_new_part(self):
        sess = MockSession()
        # Long 100, sell 400 => closes 100 and opens 300 short. Cap allows 120 opening.
        with patch(POS_PATH, return_value=_pos("LONG", 100, 90.0)), _margin(1.0):
            qty, requested = gsvc.cap_entry_quantity(sess, 100.0, 400, "SELL")
        assert (qty, requested) == (220, 400)

    def test_add_to_position_is_capped_like_a_new_entry(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_pos("LONG", 500, 90.0)), _margin(1.0):
            assert gsvc.cap_entry_quantity(sess, 100.0, 240, "BUY") == (120, 240)


# ── Minimum gap ───────────────────────────────────────────────────────────────

class TestLastEntryFillTime:
    def test_empty_session_has_no_entry(self):
        with patch(TRADES_PATH, return_value=[]):
            assert gsvc._last_entry_fill_time(SESSION) is None

    def test_latest_opening_fill_wins_over_a_later_exit(self):
        trades = [_trade(TradeSide.BUY, 10, 1000), _trade(TradeSide.BUY, 5, 1300), _trade(TradeSide.SELL, 15, 1600)]
        with patch(TRADES_PATH, return_value=trades):
            assert gsvc._last_entry_fill_time(SESSION) == 1300

    def test_partial_exit_is_not_an_entry(self):
        trades = [_trade(TradeSide.BUY, 10, 1000), _trade(TradeSide.SELL, 4, 1500)]
        with patch(TRADES_PATH, return_value=trades):
            assert gsvc._last_entry_fill_time(SESSION) == 1000

    def test_flip_counts_as_an_entry(self):
        trades = [_trade(TradeSide.BUY, 10, 1000), _trade(TradeSide.SELL, 15, 1500)]
        with patch(TRADES_PATH, return_value=trades):
            assert gsvc._last_entry_fill_time(SESSION) == 1500

    def test_contracts_are_tracked_separately(self):
        trades = [_trade(TradeSide.BUY, 75, 1000, "CE", 24000, "e"), _trade(TradeSide.SELL, 75, 1100, "PE", 24000, "e")]
        # The PE sell opens a short on a different contract, so it is an entry.
        with patch(TRADES_PATH, return_value=trades):
            assert gsvc._last_entry_fill_time(SESSION) == 1100


class TestCheckMinGap:
    def test_second_entry_inside_gap_is_refused(self):
        sess = MockSession(current_time=1000 + 120)
        with patch(TRADES_PATH, return_value=[_trade(TradeSide.BUY, 10, 1000)]), patch(POS_PATH, return_value=_pos("LONG", 10, 100.0)):
            blocked, reason = gsvc.check_min_gap(sess, "BUY", 5)
        assert blocked is True
        assert reason.startswith("MINGAP:")
        assert "3 min" in reason  # 5 minute gap, 2 minutes elapsed

    def test_entry_after_gap_passes(self):
        sess = MockSession(current_time=1000 + 300)
        with patch(TRADES_PATH, return_value=[_trade(TradeSide.BUY, 10, 1000)]), patch(POS_PATH, return_value=_pos("LONG", 10, 100.0)):
            assert gsvc.check_min_gap(sess, "BUY", 5) == (False, "")

    def test_exit_is_never_refused(self):
        sess = MockSession(current_time=1010)
        with patch(TRADES_PATH, return_value=[_trade(TradeSide.BUY, 10, 1000)]), patch(POS_PATH, return_value=_pos("LONG", 10, 100.0)):
            assert gsvc.check_min_gap(sess, "SELL", 10) == (False, "")

    def test_reversal_counts_as_an_entry(self):
        sess = MockSession(current_time=1010)
        with patch(TRADES_PATH, return_value=[_trade(TradeSide.BUY, 10, 1000)]), patch(POS_PATH, return_value=_pos("LONG", 10, 100.0)):
            blocked, _ = gsvc.check_min_gap(sess, "SELL", 25)
        assert blocked is True

    def test_first_entry_of_the_session_passes(self):
        sess = MockSession()
        with patch(TRADES_PATH, return_value=[]), patch(POS_PATH, return_value=_pos()):
            assert gsvc.check_min_gap(sess, "BUY", 5) == (False, "")

    def test_disabled_does_nothing(self):
        sess = MockSession(guardrail_mingap_enabled=False, current_time=1010)
        with patch(TRADES_PATH, return_value=[_trade(TradeSide.BUY, 10, 1000)]), patch(POS_PATH, return_value=_pos("LONG", 10, 100.0)):
            assert gsvc.check_min_gap(sess, "BUY", 5) == (False, "")

    def test_clock_behind_last_entry_does_not_block(self):
        # A replay seek back puts the session clock before the earlier fill.
        sess = MockSession(current_time=900)
        with patch(TRADES_PATH, return_value=[_trade(TradeSide.BUY, 10, 1000)]), patch(POS_PATH, return_value=_pos("LONG", 10, 100.0)):
            assert gsvc.check_min_gap(sess, "BUY", 5) == (False, "")

    def test_minute_boundary_rounds_remaining_time_up(self):
        sess = MockSession(current_time=1000 + 299)
        with patch(TRADES_PATH, return_value=[_trade(TradeSide.BUY, 10, 1000)]), patch(POS_PATH, return_value=_pos("LONG", 10, 100.0)):
            _, reason = gsvc.check_min_gap(sess, "BUY", 5)
        assert "1 min" in reason


# ── Settings ──────────────────────────────────────────────────────────────────

class TestSettingsSnapshot:
    def test_initialize_guardrails_copies_new_settings(self):
        sess = MockSession()
        stored = {
            "guardrail_maxentry_enabled": True, "guardrail_maxentry_mode": "value",
            "guardrail_maxentry_pct": 7.5, "guardrail_maxentry_value": 9000.0,
            "guardrail_mingap_enabled": True, "guardrail_mingap_minutes": 11,
        }
        with patch("app.services.user_settings_service.get_settings", return_value=stored):
            gsvc.initialize_guardrails(sess, "u")
        assert sess.guardrail_maxentry_enabled is True
        assert sess.guardrail_maxentry_mode == "value"
        assert sess.guardrail_maxentry_pct == 7.5
        assert sess.guardrail_maxentry_value == 9000.0
        assert sess.guardrail_mingap_enabled is True
        assert sess.guardrail_mingap_minutes == 11

    def test_defaults_are_off(self):
        sess = MockSession()
        with patch("app.services.user_settings_service.get_settings", return_value={}):
            gsvc.initialize_guardrails(sess, "u")
        assert sess.guardrail_maxentry_enabled is False
        assert sess.guardrail_mingap_enabled is False
        assert sess.guardrail_mingap_minutes == 5


class TestSettingsApi:
    HEADERS = {"X-User-Id": "00000000-0000-0000-0000-000000000001"}

    def test_round_trip_and_validation(self):
        from fastapi.testclient import TestClient
        client = TestClient(app)
        stored = {
            "guardrail_maxentry_enabled": True, "guardrail_maxentry_mode": "value",
            "guardrail_maxentry_pct": 12.0, "guardrail_maxentry_value": 5000.0,
            "guardrail_mingap_enabled": True, "guardrail_mingap_minutes": 9,
        }
        with patch("app.routers.guardrails.settings_svc.update_settings", return_value=stored) as update:
            data = client.post("/api/guardrails/settings", json=stored, headers=self.HEADERS).json()
        assert data["guardrail_maxentry_enabled"] is True
        assert data["guardrail_maxentry_value"] == 5000.0
        assert data["guardrail_mingap_minutes"] == 9
        assert update.call_args.args[1] == stored
        for bad in ({"guardrail_mingap_minutes": 0}, {"guardrail_mingap_minutes": 391},
                    {"guardrail_maxentry_pct": 0.5}, {"guardrail_maxentry_pct": 101},
                    {"guardrail_maxentry_value": -1}, {"guardrail_maxentry_mode": "other"}):
            assert client.post("/api/guardrails/settings", json=bad, headers=self.HEADERS).status_code == 422, bad

    def test_get_returns_new_fields_with_defaults(self):
        from fastapi.testclient import TestClient
        with patch("app.routers.guardrails.settings_svc.get_settings", return_value={}):
            data = TestClient(app).get("/api/guardrails/settings", headers=self.HEADERS).json()
        assert data["guardrail_maxentry_enabled"] is False
        assert data["guardrail_maxentry_pct"] == 12.0
        assert data["guardrail_mingap_minutes"] == 5


# ── Order routes ──────────────────────────────────────────────────────────────

def _route_session(**overrides):
    from app.config import FIXED_USER_ID
    session = MagicMock()
    session.session_id = SESSION
    session.symbol = "NIFTY"
    session.date = "2026-05-06"
    session.current_time = 1_746_518_100
    session.state = SimulationState.RUNNING
    session.user_id = FIXED_USER_ID
    session.session_type = "sim"
    session.wallet_ledger_id = ""
    session.expiry = "2026-05-07"
    session.strike = session.strike_ce = session.strike_pe = 24000
    session.right = None
    session.instrument_type = "equity"
    session.guardrail_ban_active = False
    session.guardrail_block_until_bar = 0
    session.guardrail_maxsize_enabled = False
    session.session_capital = 100_000.0
    session.interval = 180
    session.guardrail_maxentry_enabled = True
    session.guardrail_maxentry_mode = "percentage"
    session.guardrail_maxentry_pct = 12.0
    session.guardrail_maxentry_value = 0.0
    session.guardrail_mingap_enabled = False
    session.guardrail_mingap_minutes = 5
    for key, value in overrides.items():
        setattr(session, key, value)
    return session


@pytest.fixture
def clean_orders():
    order_service.clear_session(SESSION)
    with patch("app.services.order_service._write_order_to_db"), \
         patch("app.services.wallet_service.debit"), patch("app.services.wallet_service.credit"):
        yield
    order_service.clear_session(SESSION)


@pytest.mark.asyncio
class TestOrdersRoute:
    async def _post(self, session, body):
        with patch("app.routers.orders.sim_svc.get_session", return_value=session), \
             patch("app.routers.orders._wallet_balance_for_session", return_value=1_000_000), \
             patch(POS_PATH, return_value=_pos()), patch(TRADES_PATH, return_value=[]), _margin(1.0):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                return await client.post("/api/orders", json={"session_id": SESSION, **body})

    async def test_typed_quantity_is_reduced_to_the_cap(self, clean_orders):
        resp = await self._post(_route_session(), {"side": "BUY", "order_type": "LIMIT", "limit_price": 100.0, "quantity": 240})
        assert resp.status_code == 200
        assert resp.json()["quantity"] == 120

    async def test_funds_ratio_24_percent_places_12_percent(self, clean_orders):
        resp = await self._post(_route_session(), {"side": "BUY", "order_type": "LIMIT", "limit_price": 100.0, "funds_ratio_pct": 0.24})
        assert resp.status_code == 200
        assert resp.json()["quantity"] == 120

    async def test_cap_disabled_places_the_full_size(self, clean_orders):
        resp = await self._post(_route_session(guardrail_maxentry_enabled=False),
                                {"side": "BUY", "order_type": "LIMIT", "limit_price": 100.0, "quantity": 240})
        assert resp.status_code == 200
        assert resp.json()["quantity"] == 240

    async def test_one_lot_above_the_cap_returns_403(self, clean_orders):
        resp = await self._post(_route_session(guardrail_maxentry_pct=1.0),
                                {"side": "BUY", "order_type": "LIMIT", "limit_price": 5000.0, "quantity": 1})
        assert resp.status_code == 403
        assert "MAXSIZE: one lot costs" in resp.json()["detail"]

    async def test_total_maxsize_still_applies_after_reduction(self, clean_orders):
        session = _route_session(guardrail_maxsize_enabled=True, guardrail_maxsize_mode="percentage", guardrail_maxsize_pct=5.0)
        resp = await self._post(session, {"side": "BUY", "order_type": "LIMIT", "limit_price": 100.0, "quantity": 240})
        assert resp.status_code == 403
        assert resp.json()["detail"].startswith("MAXSIZE: trade would bring")

    async def test_min_gap_refuses_a_second_entry(self, clean_orders):
        session = _route_session(guardrail_maxentry_enabled=False, guardrail_mingap_enabled=True)
        recent = [_trade(TradeSide.BUY, 10, int(session.current_time) - 60)]
        with patch("app.routers.orders.sim_svc.get_session", return_value=session), \
             patch("app.routers.orders._wallet_balance_for_session", return_value=1_000_000), \
             patch(POS_PATH, return_value=_pos("LONG", 10, 100.0)), patch(TRADES_PATH, return_value=recent), _margin(1.0):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION, "side": "BUY", "order_type": "LIMIT", "limit_price": 100.0, "quantity": 5})
                exit_resp = await client.post("/api/orders", json={
                    "session_id": SESSION, "side": "SELL", "order_type": "LIMIT", "limit_price": 100.0, "quantity": 10})
        assert resp.status_code == 403
        assert resp.json()["detail"].startswith("MINGAP:")
        assert exit_resp.status_code == 200

    async def test_stoploss_orders_are_not_capped_or_gated(self, clean_orders):
        session = _route_session(guardrail_mingap_enabled=True)
        recent = [_trade(TradeSide.BUY, 500, int(session.current_time) - 30)]
        with patch("app.routers.orders.sim_svc.get_session", return_value=session), \
             patch("app.routers.orders._wallet_balance_for_session", return_value=1_000_000), \
             patch(POS_PATH, return_value=_pos("LONG", 500, 100.0)), patch(TRADES_PATH, return_value=recent), _margin(1.0):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION, "side": "SELL", "order_type": "STOPLOSS", "trigger_price": 90.0,
                    "quantity": 500, "is_stoploss": True})
        assert resp.status_code == 200
        assert resp.json()["quantity"] == 500


# ── Direct buy / sell ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestDirectTradeRoute:
    async def test_direct_buy_is_capped_and_recorded_with_the_original(self):
        session = _route_session()
        recorded = {}

        def _record(*args, **kwargs):
            recorded.update(kwargs)
            return MagicMock(model_dump=lambda **_: {})

        with patch("app.routers.trading.sim_svc.get_session", return_value=session), \
             patch("app.routers.trading._get_price_for_right", return_value=100.0), \
             patch("app.routers.trading._emit_trade_event"), \
             patch("app.routers.trading.trading_svc.settle_wallet_for_trade"), \
             patch("app.routers.trading.trading_svc.record_trade", side_effect=_record), \
             patch(POS_PATH, return_value=_pos()), patch(TRADES_PATH, return_value=[]), _margin(1.0), \
             patch("app.routers.trading._direct_trade_quantity", return_value=240), \
             patch("app.routers.trading._margin_rate_for", return_value=1.0):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/trades/buy", json={"session_id": SESSION})
        assert resp.status_code == 200, resp.text
        assert recorded["quantity"] == 120
        assert recorded["analytics"]["entry_cap_requested_qty"] == 240

    async def test_direct_sell_inside_gap_is_refused_but_exit_is_not(self):
        session = _route_session(guardrail_maxentry_enabled=False, guardrail_mingap_enabled=True)
        recent = [_trade(TradeSide.BUY, 10, int(session.current_time) - 60)]
        patches = dict(
            sess=patch("app.routers.trading.sim_svc.get_session", return_value=session),
            price=patch("app.routers.trading._get_price_for_right", return_value=100.0),
            qty=patch("app.routers.trading._direct_trade_quantity", return_value=10),
            trades=patch(TRADES_PATH, return_value=recent),
        )
        with patches["sess"], patches["price"], patches["qty"], patches["trades"], _margin(1.0), \
             patch(POS_PATH, return_value=_pos("SHORT", 10, 100.0)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                # SHORT 10 then SELL adds to the short: that is an entry inside the gap.
                resp = await client.post("/api/trades/sell", json={"session_id": SESSION})
        assert resp.status_code == 403
        assert resp.json()["detail"].startswith("MINGAP:")
