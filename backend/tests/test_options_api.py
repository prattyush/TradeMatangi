"""
Tests for Sprint 3 API endpoints:
  GET /api/data/price-at
  GET /api/data/expiry
  POST /api/simulation/start (options instrument_type)
"""
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _make_equity_df(date: str, price: float = 24000.0) -> pd.DataFrame:
    idx = pd.date_range(start=f"{date} 09:15:00", end=f"{date} 15:29:59", freq="1s")
    return pd.DataFrame(
        {"open": price, "high": price + 10, "low": price - 10, "close": price},
        index=idx,
    )


def _make_options_df(date: str, price: float = 150.0) -> pd.DataFrame:
    idx = pd.date_range(start=f"{date} 09:15:00", end=f"{date} 15:29:59", freq="1s")
    return pd.DataFrame(
        {"open": price, "high": price + 5, "low": price - 5, "close": price},
        index=idx,
    )


# ---------------------------------------------------------------------------
# GET /api/data/price-at
# ---------------------------------------------------------------------------

class TestPriceAtEndpoint:
    def test_happy_path(self):
        date = "2026-05-06"
        df = _make_equity_df(date, price=23900.0)
        with patch("app.routers.data.fetch_historical"), \
             patch("app.routers.data.load_dataframe", return_value=df.copy().pipe(
                 lambda d: d.set_index(d.index.tz_localize("UTC"))
             )):
            resp = client.get(f"/api/data/price-at?symbol=NIFTY&date={date}&time=09:15")
        assert resp.status_code == 200
        body = resp.json()
        assert body["symbol"] == "NIFTY"
        assert body["date"] == date
        assert body["time"] == "09:15:00"
        assert body["price"] == pytest.approx(23900.0, abs=1.0)

    def test_time_hhmm_normalised(self):
        date = "2026-05-06"
        df = _make_equity_df(date)
        with patch("app.routers.data.fetch_historical"), \
             patch("app.routers.data.load_dataframe", return_value=df.copy().pipe(
                 lambda d: d.set_index(d.index.tz_localize("UTC"))
             )):
            resp = client.get(f"/api/data/price-at?symbol=NIFTY&date={date}&time=09%3A15")
        assert resp.status_code == 200
        assert resp.json()["time"] == "09:15:00"

    def test_unsupported_symbol(self):
        resp = client.get("/api/data/price-at?symbol=UNKNOWN&date=2026-05-06&time=09:15")
        assert resp.status_code == 400

    def test_invalid_time_format(self):
        with patch("app.routers.data.fetch_historical"):
            resp = client.get("/api/data/price-at?symbol=NIFTY&date=2026-05-06&time=9-15")
        assert resp.status_code == 422

    def test_time_past_market_close(self):
        date = "2026-05-06"
        df = _make_equity_df(date)
        tz_df = df.copy()
        tz_df.index = tz_df.index.tz_localize("UTC")
        with patch("app.routers.data.fetch_historical"), \
             patch("app.routers.data.load_dataframe", return_value=tz_df):
            resp = client.get(f"/api/data/price-at?symbol=NIFTY&date={date}&time=16:00:00")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/data/expiry
# ---------------------------------------------------------------------------

class TestExpiryEndpoint:
    def test_nifty_weekly_pre_cutoff(self):
        resp = client.get("/api/data/expiry?symbol=NIFTY&date=2025-05-06")
        assert resp.status_code == 200
        body = resp.json()
        assert body["symbol"] == "NIFTY"
        assert body["date"] == "2025-05-06"
        assert body["expiry"] == "2025-05-08"  # Thursday

    def test_nifty_weekly_post_cutoff(self):
        resp = client.get("/api/data/expiry?symbol=NIFTY&date=2025-09-15")
        assert resp.status_code == 200
        assert resp.json()["expiry"] == "2025-09-16"  # Tuesday

    def test_equity_monthly(self):
        resp = client.get("/api/data/expiry?symbol=TATPOW&date=2025-05-06")
        assert resp.status_code == 200
        assert resp.json()["expiry"] == "2025-05-29"  # last Thursday of May 2025

    def test_unsupported_symbol(self):
        resp = client.get("/api/data/expiry?symbol=BADTICKER&date=2025-05-06")
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# POST /api/simulation/start — options mode
# ---------------------------------------------------------------------------

class TestOptionsSimulationStart:
    def _patch_data(self, date: str):
        eq_df = _make_equity_df(date)
        opt_df = _make_options_df(date)
        return eq_df, opt_df

    def test_missing_strike_returns_400(self):
        resp = client.post("/api/simulation/start", json={
            "symbol": "NIFTY",
            "date": "2026-05-06",
            "instrument_type": "options",
            "expiry": "2026-05-19",
            "right": "CE",
        })
        assert resp.status_code == 400
        assert "strike" in resp.json()["detail"]

    def test_missing_expiry_returns_400(self):
        resp = client.post("/api/simulation/start", json={
            "symbol": "NIFTY",
            "date": "2026-05-06",
            "instrument_type": "options",
            "strike": 24000,
            "right": "CE",
        })
        assert resp.status_code == 400

    def test_invalid_right_returns_400(self):
        resp = client.post("/api/simulation/start", json={
            "symbol": "NIFTY",
            "date": "2026-05-06",
            "instrument_type": "options",
            "strike": 24000,
            "expiry": "2026-05-19",
            "right": "INVALID",
        })
        assert resp.status_code == 400
        assert "CE" in resp.json()["detail"] or "PE" in resp.json()["detail"]

    def test_invalid_instrument_type_returns_400(self):
        resp = client.post("/api/simulation/start", json={
            "symbol": "NIFTY",
            "date": "2026-05-06",
            "instrument_type": "futures",
        })
        assert resp.status_code == 400

    def test_options_session_started_successfully(self):
        date = "2026-05-06"
        with patch("app.routers.simulation._ensure_session_data"), \
             patch("app.routers.simulation._ensure_options_data"), \
             patch("app.services.wallet_service.get_balance", return_value=150000.0), \
             patch("app.services.simulation._upsert_session_to_db"):
            resp = client.post("/api/simulation/start", json={
                "symbol": "NIFTY",
                "date": date,
                "instrument_type": "options",
                "strike": 24000,
                "expiry": "2026-05-19",
                "right": "CE",
                "speed": 100.0,
            })
        assert resp.status_code == 200
        body = resp.json()
        assert body["instrument_type"] == "options"
        assert body["strike"] == 24000
        assert body["expiry"] == "2026-05-19"
        assert body["right"] == "CE"

    def test_equity_session_unaffected(self):
        # Use an equity symbol (not options_only) — TATPOW supports equity sessions
        with patch("app.routers.simulation._ensure_session_data"), \
             patch("app.services.wallet_service.get_balance", return_value=150000.0), \
             patch("app.services.simulation._upsert_session_to_db"):
            resp = client.post("/api/simulation/start", json={
                "symbol": "TATPOW",
                "date": "2026-05-06",
                "instrument_type": "equity",
                "speed": 100.0,
            })
        assert resp.status_code == 200
        body = resp.json()
        assert body["instrument_type"] == "equity"
        assert body["strike"] is None
        assert body["expiry"] is None
        assert body["right"] is None

    def test_options_only_symbol_rejects_equity_session(self):
        # NIFTY and BSESEN are options_only — equity sessions must be rejected
        for symbol in ("NIFTY", "BSESEN"):
            resp = client.post("/api/simulation/start", json={
                "symbol": symbol,
                "date": "2026-05-06",
                "instrument_type": "equity",
                "speed": 100.0,
            })
            assert resp.status_code == 400, f"{symbol} should reject equity sessions"
            assert "index" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# Naked short margin check (via orders endpoint)
# ---------------------------------------------------------------------------

class TestNakedShortMarginCheck:
    def _create_options_session(self, session_id: str, symbol: str = "NIFTY"):
        from app.services import simulation as sim_svc
        from app.services.simulation import SimulationSession, SimulationState
        import asyncio
        session = SimulationSession(
            session_id=session_id,
            symbol=symbol,
            date="2026-05-06",
            start_time="09:15:00",
            speed=1.0,
            state=SimulationState.RUNNING,
            current_time="1746511500",
            last_price=150.0,
            session_capital=150000.0,
            instrument_type="options",
            strike=24000,
            expiry="2026-05-19",
            right="CE",
        )
        session.resume_event.set()
        sim_svc._sessions[session_id] = session
        return session

    def test_naked_short_blocked_when_wallet_insufficient(self):
        import uuid
        session_id = str(uuid.uuid4())
        session = self._create_options_session(session_id)

        # Margin for NIFTY = 24000 * 75 * 0.20 = 360000; wallet = 50000 < margin
        with patch("app.routers.orders.get_balance", return_value=50000.0), \
             patch("app.services.options_service.get_underlying_price_at", return_value=24000.0):
            resp = client.post("/api/orders", json={
                "session_id": session_id,
                "side": "SELL",
                "order_type": "LIMIT",
                "limit_price": 150.0,
                "quantity": 75,
            })
        assert resp.status_code == 402
        assert "margin" in resp.json()["detail"].lower()

        from app.services import simulation as sim_svc
        sim_svc._sessions.pop(session_id, None)

    def test_naked_short_allowed_when_wallet_sufficient(self):
        import uuid
        session_id = str(uuid.uuid4())
        session = self._create_options_session(session_id)

        # Margin = 360000; wallet = 500000 > margin
        with patch("app.routers.orders.get_balance", return_value=500000.0), \
             patch("app.services.options_service.get_underlying_price_at", return_value=24000.0), \
             patch("app.services.order_service.place_order") as mock_place:
            from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
            import time
            mock_place.return_value = Order(
                session_id=session_id,
                user_id="abc12300-0000-0000-0000-000000000001",
                symbol="NIFTY",
                side=TradeSide.SELL,
                order_type=OrderType.LIMIT,
                quantity=75,
                trigger_price=150.0,
                limit_price=150.0,
                status=OrderStatus.PENDING,
                created_at=int(time.time()),
            )
            resp = client.post("/api/orders", json={
                "session_id": session_id,
                "side": "SELL",
                "order_type": "LIMIT",
                "limit_price": 150.0,
                "quantity": 75,
            })
        assert resp.status_code == 200

        from app.services import simulation as sim_svc
        sim_svc._sessions.pop(session_id, None)

    def test_covered_sell_no_margin_check(self):
        import uuid
        session_id = str(uuid.uuid4())
        session = self._create_options_session(session_id)

        # Simulate open LONG position
        from app.services.trading import ensure_session, _trades
        from app.models.schemas import Trade, TradeSide
        ensure_session(session_id)
        _trades[session_id].append(Trade(
            user_id="abc12300-0000-0000-0000-000000000001",
            symbol="NIFTY",
            side=TradeSide.BUY,
            quantity=75,
            price=150.0,
            timestamp=1746511500,
            session_id=session_id,
            right="CE",
        ))

        with patch("app.routers.orders.get_balance", return_value=50000.0), \
             patch("app.services.order_service.place_order") as mock_place:
            from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
            import time
            mock_place.return_value = Order(
                session_id=session_id,
                user_id="abc12300-0000-0000-0000-000000000001",
                symbol="NIFTY",
                side=TradeSide.SELL,
                order_type=OrderType.LIMIT,
                quantity=75,
                trigger_price=150.0,
                limit_price=150.0,
                status=OrderStatus.PENDING,
                created_at=int(time.time()),
            )
            resp = client.post("/api/orders", json={
                "session_id": session_id,
                "side": "SELL",
                "order_type": "LIMIT",
                "limit_price": 150.0,
                "quantity": 75,
            })
        # No margin check since position is LONG
        assert resp.status_code == 200

        from app.services import simulation as sim_svc
        from app.services.trading import _trades
        sim_svc._sessions.pop(session_id, None)
        _trades.pop(session_id, None)
