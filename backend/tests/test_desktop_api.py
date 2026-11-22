"""Desktop boundary: it must be authorised and versioned."""
from fastapi.testclient import TestClient
from unittest.mock import patch

from app.main import app

client = TestClient(app)
HEADERS = {"X-User-Id": "desktop-user"}


def test_desktop_routes_require_an_explicit_identity():
    response = client.get("/api/desktop/v1/capabilities")
    assert response.status_code == 401
    assert response.json()["detail"] == "Authentication required"


def test_capabilities_are_versioned_and_advertise_stepwise_trading():
    response = client.get("/api/desktop/v1/capabilities", headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert data["api_version"] == "v1"
    assert "stepwise" in data["trading_capabilities"]
    assert "flatten" in data["trading_capabilities"]


def test_catalogue_has_nifty100_index_constituents_and_preserves_legacy_chart_keys():
    response = client.get("/api/desktop/v1/catalogue", headers=HEADERS)
    assert response.status_code == 200
    instruments = response.json()["instruments"]
    assert len(instruments) == 174  # 2 indices + Nifty 100 (incl. 3 legacy stocks) + 72 Midcap 50 / sectoral extras
    assert {"NIFTY", "BSESEN", "TATPOW", "TATMOT", "RELIND", "HDFCBANK", "INFY", "NAUKRI", "SAIL", "UBL"} <= {item["symbol"] for item in instruments}
    assert next(item for item in instruments if item["symbol"] == "UBL")["option_eligible"] is False
    assert next(item for item in instruments if item["symbol"] == "NIFTY")["chart_type"] == "index"


def test_option_metadata_is_date_aware_for_non_trading_days():
    response = client.get("/api/desktop/v1/option-metadata?symbol=NIFTY&as_of_date=2026-05-02", headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert data["available"] is False
    assert data["expiries"] == []


def label_metadata(deep_dive):
    with patch("app.services.pattern_logger_service.list_category_names", return_value=["Breakout"]) as categories, \
         patch("app.services.pattern_logger_service.list_strategy_names", return_value=["Opening Range"]) as strategies, \
         patch("app.services.trade_label_service.list_entry_tags", return_value=["ORB"]) as entry_tags, \
         patch("app.services.trade_label_service.list_exit_tags", return_value=["Target"]) as exit_tags, \
         patch("app.services.deep_dive_service.stats_all", **deep_dive) as stats:
        response = client.get("/api/desktop/v1/trading/trade-labels/metadata", headers={"X-User-Id": "label-owner"})
    return response, (categories, strategies, entry_tags, exit_tags), stats


def test_trade_label_metadata_uses_the_authenticated_desktop_user():
    response, methods, stats = label_metadata({"return_value": []})
    assert response.status_code == 200
    assert response.json() == {
        "categories": ["Breakout"],
        "strategies": ["Opening Range"],
        "entry_tags": ["ORB"],
        "exit_tags": ["Target"],
        "deep_dive": [],
    }
    for method in methods:
        method.assert_called_once_with("label-owner")
    stats.assert_called_once_with("label-owner")


def test_trade_label_metadata_carries_the_deep_dive_percentages():
    entry = {"category": "Breakout", "strategy": "Opening Range", "owner_id": "label-owner", "shared": False}
    response, _, _ = label_metadata({"return_value": [entry]})
    assert response.status_code == 200
    assert response.json()["deep_dive"] == [entry]


def test_a_failing_deep_dive_read_never_fails_the_label_values():
    response, _, _ = label_metadata({"side_effect": RuntimeError("table unavailable")})
    assert response.status_code == 200
    body = response.json()
    assert body["deep_dive"] == [] and body["categories"] == ["Breakout"] and body["entry_tags"] == ["ORB"]


def test_a_slow_deep_dive_read_is_cut_off_instead_of_delaying_the_label_values():
    """The label values wait at most the timeout for the percentages (the worker thread may finish later; nothing waits for it)."""
    import asyncio
    import time
    from app.routers import desktop_trading

    async def timed():
        started = time.monotonic()
        return await desktop_trading._deep_dive_stats("label-owner"), time.monotonic() - started

    with patch.object(desktop_trading, "DEEP_DIVE_STATS_TIMEOUT_SECONDS", 0.05), \
         patch("app.services.deep_dive_service.stats_all", side_effect=lambda user_id: time.sleep(0.5) or [{"strategy": "late"}]):
        result, elapsed = asyncio.run(timed())
    assert result == [] and elapsed < 0.3
