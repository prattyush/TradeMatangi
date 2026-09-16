"""Phase 16 desktop boundary: it must be authorised and chart-only."""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
HEADERS = {"X-User-Id": "desktop-user"}


def test_desktop_routes_require_an_explicit_identity():
    response = client.get("/api/desktop/v1/capabilities")
    assert response.status_code == 401
    assert response.json()["detail"] == "Authentication required"


def test_capabilities_are_versioned_and_exclude_trading():
    response = client.get("/api/desktop/v1/capabilities", headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert data["api_version"] == "v1"
    assert data["trading_capabilities"] == []


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
