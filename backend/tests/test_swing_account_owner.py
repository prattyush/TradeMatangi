import pytest
from app.services import swing_account_owner as owners, swing_funding_store as funding
from tests.test_swing_funding_store import db  # noqa: F401


def test_one_operator_can_run_both_modes_and_account_releases_only_after_both_close(db):
    row = funding.initialize("u", "kite", "account", 100000)
    period = row["period_id"]
    owners.claim("u", "kite", "account", period)
    assert owners.claim("u", "kite", "account", period)["owner_user_id"] == "u"
    funding.start_participant("u", "kite", "account", period, "swing", "portfolio", 0.8)
    funding.start_participant("u", "kite", "account", period, "intraday", "day", 0.2)
    with pytest.raises(Exception):
        owners.claim("other", "kite", "account", "other-period")
    funding.close_participant("u", "kite", "account", period, "intraday", "day")
    with pytest.raises(Exception):
        owners.release("u", "kite", "account", period)
    funding.close_participant("u", "kite", "account", period, "swing", "portfolio")
    funding.finish_period("u", "kite", "account", period)
    owners.release("u", "kite", "account", period)
    owners.claim("other", "kite", "account", "other-period")
    assert owners.read("kite", "account")["owner_user_id"] == "other"


def test_broker_and_account_ownership_are_distinct(db):
    owners.claim("u", "kite", "account", "one")
    owners.claim("other", "kotak", "account", "two")
    owners.claim("third", "kite", "another-account", "three")
    assert owners.read("kite", "account")["owner_user_id"] == "u"


def test_archived_period_recovers_owner_release_interrupted_by_restart(db):
    row = funding.initialize("u", "kite", "account", 100000)
    owners.claim("u", "kite", "account", row["period_id"])
    funding.finish_period("u", "kite", "account", row["period_id"])
    # Process stopped before releasing the account pointer. The immutable archive
    # proves the old participants closed before the next operator may claim it.
    owners.claim("other", "kite", "account", "next-period")
    assert owners.read("kite", "account")["owner_user_id"] == "other"
