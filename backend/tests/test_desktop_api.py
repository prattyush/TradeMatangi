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


def test_initial_catalogue_is_the_five_chart_symbols():
    response = client.get("/api/desktop/v1/catalogue", headers=HEADERS)
    assert response.status_code == 200
    instruments = response.json()["instruments"]
    assert {item["symbol"] for item in instruments} == {"NIFTY", "BSESEN", "TATPOW", "TATMOT", "RELIND"}
    assert next(item for item in instruments if item["symbol"] == "NIFTY")["chart_type"] == "index"


def test_option_metadata_is_date_aware_for_non_trading_days():
    response = client.get("/api/desktop/v1/option-metadata?symbol=NIFTY&as_of_date=2026-05-02", headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert data["available"] is False
    assert data["expiries"] == []


def test_trade_label_metadata_uses_the_authenticated_desktop_user():
    with patch("app.services.pattern_logger_service.list_category_names", return_value=["Breakout"] ) as categories, \
         patch("app.services.pattern_logger_service.list_strategy_names", return_value=["Opening Range"] ) as strategies, \
         patch("app.services.trade_label_service.list_entry_tags", return_value=["ORB"] ) as entry_tags, \
         patch("app.services.trade_label_service.list_exit_tags", return_value=["Target"] ) as exit_tags:
        response = client.get("/api/desktop/v1/trading/trade-labels/metadata", headers={"X-User-Id": "label-owner"})

    assert response.status_code == 200
    assert response.json() == {
        "categories": ["Breakout"],
        "strategies": ["Opening Range"],
        "entry_tags": ["ORB"],
        "exit_tags": ["Target"],
    }
    for method in (categories, strategies, entry_tags, exit_tags):
        method.assert_called_once_with("label-owner")
