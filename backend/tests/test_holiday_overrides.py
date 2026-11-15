"""Operator-added market holidays: DATA_DIR/holidays.json and /api/admin/holidays."""
import datetime
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import utils
from app.config import FIXED_USER_ID
from app.main import app

client = TestClient(app)
ADMIN = {"X-User-Id": FIXED_USER_ID}
OTHER = {"X-User-Id": "00000000-0000-0000-0000-000000000099"}
DAY = datetime.date(2026, 11, 11)  # a Wednesday that is not in the built-in list


@pytest.fixture(autouse=True)
def data_dir(tmp_path):
    with patch("app.config.DATA_DIR", tmp_path):
        utils._extra_cache = (None, {})
        yield tmp_path
        utils._extra_cache = (None, {})


def _admin():
    return patch("app.routers.admin.get_user_info", return_value={"user_id": FIXED_USER_ID, "is_admin": True})


def test_weekday_is_a_trading_day_without_override():
    assert utils.is_trading_day(DAY) is True


def test_added_holiday_is_not_a_trading_day_and_removal_restores_it():
    utils.add_extra_holiday(DAY, "Special closure")
    assert utils.is_trading_day(DAY) is False
    assert utils.extra_holidays() == {DAY: "Special closure"}
    utils.remove_extra_holiday(DAY)
    assert utils.is_trading_day(DAY) is True


def test_prior_trading_days_skips_added_holiday():
    utils.add_extra_holiday(DAY)
    # Thu 12th: the two days before are Tue 10th (built-in holiday) and Wed 11th (added), so Mon 9th and Fri 6th.
    assert utils.prior_trading_days("2026-11-12", n=2) == ["2026-11-06", "2026-11-09"]


def test_hand_edited_file_is_picked_up_without_restart(data_dir):
    assert utils.is_trading_day(DAY) is True
    (data_dir / "holidays.json").write_text(json.dumps({"holidays": {"2026-11-11": "x"}}), encoding="utf-8")
    assert utils.is_trading_day(DAY) is False


@pytest.mark.parametrize("content", ["not json", "[]", '{"holidays": ["2026-11-11"]}', '{"holidays": {"bad": "x"}}'])
def test_broken_file_means_no_extra_holidays(data_dir, content):
    (data_dir / "holidays.json").write_text(content, encoding="utf-8")
    assert utils.extra_holidays() == {}
    assert utils.is_trading_day(DAY) is True


def test_admin_adds_lists_and_removes():
    with _admin():
        added = client.post("/api/admin/holidays", json={"date": "2026-11-11", "note": "Closure"}, headers=ADMIN)
        assert added.status_code == 200
        assert added.json()["added"] == [{"date": "2026-11-11", "note": "Closure"}]
        assert "2026-11-10" in added.json()["built_in"]
        assert utils.is_trading_day(DAY) is False
        removed = client.delete("/api/admin/holidays/2026-11-11", headers=ADMIN)
        assert removed.json()["added"] == []
        assert utils.is_trading_day(DAY) is True


def test_bad_date_is_rejected():
    with _admin():
        assert client.post("/api/admin/holidays", json={"date": "11/11/2026"}, headers=ADMIN).status_code == 422
        assert client.delete("/api/admin/holidays/nope", headers=ADMIN).status_code == 422


def test_non_admin_is_refused():
    with patch("app.routers.admin.get_user_info", return_value={"user_id": "x", "is_admin": False}):
        assert client.get("/api/admin/holidays", headers=OTHER).status_code == 403
        assert client.post("/api/admin/holidays", json={"date": "2026-11-11"}, headers=OTHER).status_code == 403
        assert client.delete("/api/admin/holidays/2026-11-11", headers=OTHER).status_code == 403
