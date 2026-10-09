import asyncio
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.routers.desktop_trading import PreparationRequest, prepare_session
from app.services import desktop_preparation as prep
from app.services.historical_data_service import HistoricalResult, history_mode

DATE = "2026-10-08"
PANE = dict(id="ce", kind="option", symbol="BSESEN", interval="3", tradingDate=DATE,
            expiry=DATE, strike="71700", right="CE", selection_mode="manual", max_price=None)


def history(prices=(100, 90), times=("09:15:00", "09:15:01"), interval=1, observed=None):
    frame = pd.DataFrame({key: prices for key in ("open", "high", "low", "close")},
                         index=pd.to_datetime([f"{DATE} {value}" for value in times], utc=True))
    frame["observed"] = observed if observed is not None else True
    return HistoricalResult(frame, Path("synthetic.parquet"), "breeze", "breeze", interval)


def test_observed_second_lookup_never_uses_future_or_gap_filled_price():
    result = history((300, 10, 200), ("09:15:00", "09:15:01", "09:15:02"), observed=(True, False, True))
    assert prep.price_before(result, DATE, pd.Timestamp(f"{DATE} 09:15:01", tz="UTC")) == 300


def test_native_minute_close_is_not_available_before_minute_finishes():
    result = history((100,), ("09:15:00",), interval=60)
    assert prep.price_before(result, DATE, pd.Timestamp(f"{DATE} 09:15:59", tz="UTC")) is None
    assert prep.price_before(result, DATE, pd.Timestamp(f"{DATE} 09:16:00", tz="UTC")) == 100


@pytest.mark.parametrize("right,direction", [("CE", 1), ("PE", -1)])
def test_scan_stops_on_first_cap_match_and_preserves_replay_policy(right, direction):
    seen = []
    def load(symbol, date, strike=None, *args):
        assert history_mode() == "replay"
        if strike is None:
            return history((71700,), ("09:15:00",))
        seen.append(strike)
        return history((101 if len(seen) == 1 else 100,), ("09:15:00",))
    with patch.object(prep, "load_history", side_effect=load):
        result = prep.prepare("stepwise", DATE, "09:15:00", [{**PANE, "right": right, "selection_mode": "max_price", "max_price": 100}])
    assert seen == [71700, 71700 + direction * 100]
    assert result["panes"][0]["pane"]["strike"] == str(seen[-1])
    assert result["panes"][0]["premium"] == 100


def test_no_match_is_explicit_and_bounded_without_atm_fallback():
    with patch.object(prep, "load_history", return_value=history((71700,), ("09:15:00",))) as load:
        result = prep.prepare("replay", DATE, "09:15:00", [{**PANE, "selection_mode": "max_price", "max_price": 1}])
    assert load.call_count == 31
    assert result["panes"][0]["availability"] == "error"
    assert result["panes"][0]["premium"] is None


@pytest.mark.parametrize("error", [TimeoutError(), ValueError("Provider parse failure"), RuntimeError("429")])
def test_transient_failures_never_mark_chart_invalid(error):
    with patch.object(prep, "load_history", side_effect=error):
        result = prep.prepare("replay", DATE, "09:15:00", [PANE])
    assert result["panes"][0]["availability"] == "error"


def test_late_first_tick_keeps_pane_waiting():
    with patch.object(prep, "load_history", return_value=history((100,), ("09:16:00",))):
        result = prep.prepare("replay", DATE, "09:15:00", [PANE])
    assert result["panes"][0]["availability"] == "waiting"


def test_context_only_and_gap_only_frames_are_unavailable():
    result = history()
    result.frame.index = result.frame.index - pd.Timedelta(days=1)
    with patch.object(prep, "load_history", return_value=result):
        assert prep.prepare("replay", DATE, "09:15:00", [PANE])["panes"][0]["availability"] == "unavailable"
    with patch.object(prep, "load_history", return_value=history(observed=(False, False))):
        assert prep.prepare("replay", DATE, "09:15:00", [PANE])["panes"][0]["availability"] == "unavailable"


@pytest.mark.parametrize("expiry", ["2026-10-01", "2026-10-15"])
def test_expired_and_unsupported_future_contracts_do_not_fetch(expiry):
    with patch.object(prep, "load_history") as load:
        result = prep.prepare("replay", DATE, "09:15:00", [{**PANE, "expiry": expiry}])
    load.assert_not_called()
    assert result["panes"][0]["availability"] == "unavailable"


def test_missing_file_is_confirmed_unavailable():
    with patch.object(prep, "load_history", side_effect=FileNotFoundError()):
        assert prep.prepare("replay", DATE, "09:15:00", [PANE])["panes"][0]["availability"] == "unavailable"


def test_preparation_requires_identity():
    assert TestClient(app).post("/api/desktop/v1/trading/prepare-session", json={}).status_code == 401


@pytest.mark.parametrize("cap", [0, -1])
def test_invalid_cap_rejected_at_boundary(cap):
    from app.services.desktop_auth_service import _access_token
    response = TestClient(app).post("/api/desktop/v1/trading/prepare-session", headers={"Authorization": f"Bearer {_access_token('test')[0]}"}, json={"mode": "replay", "date": DATE, "panes": [{**PANE, "max_price": cap}]})
    assert response.status_code == 422


def test_owned_active_clock_and_five_panes_reach_worker_without_starting_session():
    current = int(datetime(2026, 10, 8, 10, 30, tzinfo=timezone.utc).timestamp())
    session = SimpleNamespace(date=DATE, current_time=str(current))
    request = PreparationRequest(mode="replay", date=DATE, session_id="owned", panes=[{**PANE, "id": str(i)} for i in range(5)])
    with patch("app.routers.desktop_trading._require_session", return_value=session) as owned, \
         patch("app.routers.desktop_trading._desktop_mode", return_value="replay"), \
         patch.object(prep, "prepare", return_value={"panes": []}) as work:
        asyncio.run(prepare_session(request, "owner"))
    owned.assert_called_once_with("owned", "owner")
    assert work.call_args.args[2] == "10:30:00"
    assert len(work.call_args.args[3]) == 5


def test_wrong_owner_and_duplicate_panes_rejected_before_history():
    request = PreparationRequest(mode="replay", date=DATE, session_id="other", panes=[PANE])
    with patch("app.routers.desktop_trading._require_session", side_effect=HTTPException(404)):
        with pytest.raises(HTTPException):
            asyncio.run(prepare_session(request, "owner"))
    request = PreparationRequest(mode="replay", date=DATE, panes=[PANE, PANE])
    with pytest.raises(HTTPException) as error:
        asyncio.run(prepare_session(request, "owner"))
    assert error.value.status_code == 422


def test_replay_and_live_request_models_accept_five_but_not_six():
    from app.routers.desktop_replay import StartReplayRequest, SyncReplayTilesRequest
    from app.routers.desktop_live import StartLiveRequest
    tiles = [{"tile_id": str(i), "instrument": {"kind": "index", "exchange": "BSE", "symbol": "BSESEN"}, "interval_minutes": 3} for i in range(5)]
    assert len(StartReplayRequest(mode="replay", date=DATE, tiles=tiles).tiles) == 5
    assert len(SyncReplayTilesRequest(tiles=tiles).tiles) == 5
    assert len(StartLiveRequest(tiles=tiles).tiles) == 5
    with pytest.raises(ValueError):
        StartLiveRequest(tiles=tiles + [tiles[0]])


def test_legacy_provenance_and_stale_history_block_premium_selection():
    result = history((71700,), ("09:15:00",))
    result.frame.drop(columns="observed", inplace=True)
    with patch.object(prep, "load_history", return_value=result):
        output = prep.prepare("replay", DATE, "09:15:00", [{**PANE, "selection_mode": "max_price", "max_price": 100}])
    assert output["panes"][0]["availability"] == "error"
    assert "Observation provenance" in output["panes"][0]["reason"]
    from dataclasses import replace
    with patch.object(prep, "load_history", return_value=replace(history(), stale=True)):
        assert prep.prepare("paper", DATE, "09:15:00", [PANE])["panes"][0]["availability"] == "error"


def test_observation_mask_recovered_from_provider_file(tmp_path):
    from dataclasses import replace
    file = tmp_path / "contract.parquet"
    raw = history(observed=(False, True)).frame
    raw.to_parquet(file)
    result = replace(history(), path=file, frame=raw.drop(columns="observed"))
    with patch.object(prep, "load_history", return_value=result):
        loaded = prep._load("BSESEN", DATE)
    assert prep.price_before(loaded, DATE, pd.Timestamp(f"{DATE} 09:15:00", tz="UTC")) is None


def test_late_first_observation_cannot_become_a_desktop_quote_or_tick(tmp_path):
    from app.routers.desktop_trading import _historical_contract_quote
    file = tmp_path / "contract.parquet"
    raw = history((100, 101), ("09:15:00", "09:16:00"), observed=(False, True)).frame
    raw.to_parquet(file)
    ticks = [{"time": int(timestamp.timestamp()), "close": 100} for timestamp in raw.index]
    session = SimpleNamespace(symbol="BSESEN", date=DATE, start_time="09:15:00", current_time=str(ticks[0]["time"]), strike_ce=71700, strike_pe=71300, last_price_ce=100, last_price_pe=80)
    contract = dict(symbol="BSESEN", expiry=DATE, right="CE", strike=71700, contract_key=f"BSESEN:{DATE}:71700:CE")
    with patch("app.services.options_service.options_parquet_path", return_value=file), \
         patch("app.services.options_service.options_iter_ticks", return_value=iter(ticks)):
        assert _historical_contract_quote(session, contract) is None
        assert len(session.desktop_contract_quote_ticks[contract["contract_key"]]) == 1


def test_malformed_option_is_classified_without_fetching():
    with patch.object(prep, "load_history") as load:
        result = prep.prepare("replay", DATE, "09:15:00", [{**PANE, "expiry": ""}])
    load.assert_not_called()
    assert result["panes"][0]["availability"] == "unavailable"


def test_legacy_identity_header_is_not_sufficient_for_preparation():
    response = TestClient(app).post("/api/desktop/v1/trading/prepare-session", headers={"X-User-Id": "test"}, json={"mode": "replay", "date": DATE, "panes": [PANE]})
    assert response.status_code == 401


def test_concurrent_starts_return_creation_ownership_only_once(monkeypatch):
    from app.routers import desktop_trading as router
    monkeypatch.setattr(router.sim_svc, "_sessions", {})
    monkeypatch.setattr(router, "_desktop_mode", lambda session: "replay")
    calls = []
    def snapshot(session, user):
        return SimpleNamespace(session=SimpleNamespace(session_id=session.session_id), owned=True, created_for_request=None)
    monkeypatch.setattr(router, "_snapshot", snapshot)
    async def start(req, user):
        calls.append(user)
        await asyncio.sleep(.01)
        session = SimpleNamespace(session_id="same", user_id=user, date=DATE, symbol="BSESEN", instrument_type="options", state=router.sim_svc.SimulationState.PAUSED)
        router.sim_svc._sessions["same"] = session
        return snapshot(session, user)
    monkeypatch.setattr(router, "_start_desktop_trading", start)
    async def simultaneous():
        request = dict(symbol="BSESEN", instrument_type="options", date=DATE, desktop_mode="replay")
        return await asyncio.gather(*(router.start_desktop_trading(router.DesktopTradingStartRequest(**request), "owner") for _ in range(2)))
    responses = asyncio.run(simultaneous())
    assert calls == ["owner"]
    assert [response.created_for_request for response in responses] == [True, False]


def test_option_history_page_does_not_display_leading_future_backfill(tmp_path):
    from app.routers.desktop import option_historical_page
    file = tmp_path / "contract.parquet"
    raw = history((100, 101), ("09:15:00", "09:18:00"), observed=(False, True)).frame
    raw.to_parquet(file)
    with patch("app.services.options_service.options_parquet_path", return_value=file), \
         patch("app.services.options_service.fetch_options_historical"), \
         patch("app.services.options_service.load_options_dataframe", return_value=raw.drop(columns="observed")):
        page = asyncio.run(option_historical_page("BSESEN", DATE, DATE, 71700, "CE", 3, 0, "owner"))
    assert len(page.candles) == 1
    assert page.candles[0].timestamp == int(raw.index[1].timestamp())
