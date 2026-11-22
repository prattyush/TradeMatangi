"""The "Next expiry on expiry days" setting: a session started on the day its contracts expire uses the next expiry instead."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import desktop_preparation as prep
from app.services import options_service as svc
from app.services import user_settings_service

client = TestClient(app)
WEB = {"X-User-Id": "alice"}
DESKTOP = {"X-User-Id": "desktop-user"}


def setting(value):
    return patch.object(user_settings_service, "get_settings", lambda user_id, **kw: {"next_expiry_on_expiry_day": value})


# ── The date rule ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("symbol, date, plain, next_expiry", [
    ("NIFTY", "2026-11-17", "2026-11-17", "2026-11-23"),   # a Tuesday expiry; the next Tuesday (the 24th) is a holiday, so the Monday before
    ("NIFTY", "2026-12-01", "2026-12-01", "2026-12-08"),
    ("BSESEN", "2026-11-19", "2026-11-19", "2026-11-26"),  # SENSEX expires on Thursdays
    ("NIFTY", "2026-11-23", "2026-11-23", "2026-12-01"),   # expiry moved back to the Monday because the Tuesday is a holiday: the next one is not the same day again
    ("TATMOT", "2026-11-23", "2026-11-23", "2026-12-29"),  # an equity: the month's last expiry day, then next month's
])
def test_an_expiry_day_uses_the_next_expiry_when_the_setting_is_on(symbol, date, plain, next_expiry):
    assert svc.get_expiry_date(symbol, date) == plain and svc.is_expiry_day(symbol, date)
    assert svc.trading_expiry(symbol, date, True) == next_expiry
    assert svc.trading_expiry(symbol, date, False) == plain, "off: nothing changes"


@pytest.mark.parametrize("symbol, date", [("NIFTY", "2026-11-16"), ("NIFTY", "2026-11-18"), ("BSESEN", "2026-11-18"), ("TATMOT", "2026-11-17")])
def test_any_other_day_keeps_the_nearest_expiry(symbol, date):
    assert not svc.is_expiry_day(symbol, date)
    assert svc.trading_expiry(symbol, date, True) == svc.get_expiry_date(symbol, date)


def test_the_next_expiry_is_always_later():
    for date in ("2026-10-27", "2026-11-03", "2026-11-10", "2026-11-17", "2026-11-23", "2026-12-29"):
        expiry = svc.get_expiry_date("NIFTY", date)
        assert svc.next_expiry_after("NIFTY", expiry) > expiry


# ── The setting is read per user ─────────────────────────────────────────────

def test_the_setting_is_read_for_the_user_and_defaults_to_off():
    assert user_settings_service.DEFAULT_SETTINGS["next_expiry_on_expiry_day"] is False
    with setting(True):
        assert svc.trading_expiry_for_user("alice", "NIFTY", "2026-11-17") == "2026-11-23"
    with setting(False):
        assert svc.trading_expiry_for_user("alice", "NIFTY", "2026-11-17") == "2026-11-17"
    assert svc.trading_expiry_for_user(None, "NIFTY", "2026-11-17") == "2026-11-17"
    with patch.object(user_settings_service, "get_settings", side_effect=RuntimeError("down")):
        assert svc.trading_expiry_for_user("alice", "NIFTY", "2026-11-17") == "2026-11-17", "an unreadable setting never stops a session"


# ── Routes ───────────────────────────────────────────────────────────────────

def test_website_expiry_route_follows_the_setting_only_for_trading():
    url = "/api/data/expiry?symbol=NIFTY&date=2026-11-17"
    with setting(True):
        assert client.get(url, headers=WEB).json()["expiry"] == "2026-11-17", "analysis tools and Browse keep the nearest expiry"
        assert client.get(url + "&purpose=trading", headers=WEB).json()["expiry"] == "2026-11-23"
        assert client.get(url + "&purpose=nonsense", headers=WEB).status_code == 422
    with setting(False):
        assert client.get(url + "&purpose=trading", headers=WEB).json()["expiry"] == "2026-11-17"


def test_desktop_option_metadata_follows_the_setting_only_for_trading():
    url = "/api/desktop/v1/option-metadata?symbol=NIFTY&as_of_date=2026-11-17"
    with setting(True):
        assert client.get(url, headers=DESKTOP).json()["expiries"] == ["2026-11-17"]
        trading = client.get(url + "&purpose=trading", headers=DESKTOP).json()
        assert trading["expiries"] == ["2026-11-23"] and trading["available"] is True
    with setting(False):
        assert client.get(url + "&purpose=trading", headers=DESKTOP).json()["expiries"] == ["2026-11-17"]


def test_a_session_start_is_given_the_setting_aware_expiry():
    from app.models.schemas import SimulationStartRequest
    from app.routers import simulation
    req = SimulationStartRequest(symbol="NIFTY", date="2026-11-17", instrument_type="options", expiry="2026-11-17", strike=24500, strike_ce=24500, strike_pe=24500,
                                 session_type="paper", start_time="09:20:00")
    with setting(True), patch("app.services.options_service.get_underlying_price_at", return_value=24500.0):
        simulation._normalise_option_contract_request(req, "alice")
    assert req.expiry == "2026-11-23", "the nearest expiry sent by a stale client is corrected on an expiry day"
    req.expiry = "2026-11-17"
    with setting(False), patch("app.services.options_service.get_underlying_price_at", return_value=24500.0):
        simulation._normalise_option_contract_request(req, "alice")
    assert req.expiry == "2026-11-17"


# ── prepare-session (Windows app) ────────────────────────────────────────────

PANE = dict(id="ce", kind="option", symbol="NIFTY", interval="3", tradingDate="2026-11-17", expiry="2026-11-17", strike="24500", right="CE", selection_mode="manual", max_price=None)


def prepared(mode, expiry, next_on_expiry_day, existing=False):
    with patch.object(prep, "_load", side_effect=RuntimeError("no data")), patch.object(prep, "_load_minute", side_effect=RuntimeError("no data")):
        return prep.prepare(mode, "2026-11-17", "09:30:00", [{**PANE, "expiry": expiry}], next_on_expiry_day, existing)["panes"][0]


def test_prepare_session_requires_the_next_expiry_for_a_new_trading_session_only():
    unsupported = "Expiry is outside the supported date-aware option range"
    assert "next expiry (2026-11-23)" in (prepared("replay", "2026-11-17", True).get("reason") or "")
    assert unsupported not in (prepared("replay", "2026-11-23", True).get("reason") or ""), "the next expiry is accepted"
    assert unsupported not in (prepared("replay", "2026-11-17", False).get("reason") or ""), "setting off: the nearest expiry as before"
    assert unsupported in (prepared("replay", "2026-12-01", False).get("reason") or "")
    # Browse never follows the setting (Max Price on an expiry day keeps working), and a session that is already open accepts both
    assert unsupported not in (prepared("browse", "2026-11-17", True).get("reason") or "") and "next expiry" not in (prepared("browse", "2026-11-17", True).get("reason") or "")
    assert "next expiry" not in (prepared("replay", "2026-11-17", True, existing=True).get("reason") or "")
