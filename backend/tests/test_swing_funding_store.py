import boto3
import pytest
from moto import mock_aws
from fastapi import HTTPException
from app.services import swing_funding_store as store, swing_accounting as rules


@pytest.fixture
def db(monkeypatch):
    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="ap-south-1")
        client = boto3.client("dynamodb", region_name="ap-south-1")
        resource.create_table(
            TableName="WalletLedgers",
            KeySchema=[
                {"AttributeName": "user_id", "KeyType": "HASH"},
                {"AttributeName": "ledger_id", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "user_id", "AttributeType": "S"},
                {"AttributeName": "ledger_id", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: resource)
        monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
        yield resource


def test_retry_cannot_debit_twice_and_reused_id_rejects_changed_data(db):
    row = store.initialize("u", "kite", "account", 100000)

    def allocate(record):
        record["funding"] = rules.allocate(record["funding"], "swing", 0.8)

    store.apply(
        "u",
        "kite",
        "account",
        row["period_id"],
        "start",
        "allocate",
        {"fraction": 0.8},
        allocate,
    )

    def spend(record):
        record["funding"] = rules.movement(record["funding"], "swing", -20000)

    first = store.apply(
        "u",
        "kite",
        "account",
        row["period_id"],
        "fill-one",
        "cash",
        {"delta": -20000},
        spend,
    )
    second = store.apply(
        "u",
        "kite",
        "account",
        row["period_id"],
        "fill-one",
        "cash",
        {"delta": -20000},
        spend,
    )
    assert first["version"] == second["version"] == 2
    assert second["funding"]["modes"]["swing"]["expected_balance"] == 60000
    with pytest.raises(HTTPException):
        store.apply(
            "u",
            "kite",
            "account",
            row["period_id"],
            "fill-one",
            "cash",
            {"delta": -30000},
            spend,
        )


def test_account_broker_user_and_period_identities_are_fenced(db):
    row = store.initialize("u", "kite", "account", 100000)
    assert store.read("other", "kite", "account")["period_id"] == row["period_id"]
    assert store.read("u", "kotak", "account") is None
    assert store.read("u", "kite", "other-account") is None
    with pytest.raises(HTTPException):
        store.apply("u", "kite", "account", "stale", "op", "cash", {}, lambda r: None)
    assert (
        store.initialize("u", "kite", "account", 1)["funding"]["starting_capital"]
        == 100000
    )


def test_selected_correction_survives_read_without_resetting_sibling(db):
    row = store.initialize("u", "kite", "account", 1000000)

    def allocate(record):
        record["funding"] = rules.allocate(
            rules.allocate(record["funding"], "swing", 0.8), "intraday", 0.2
        )

    store.apply(
        "u", "kite", "account", row["period_id"], "start", "allocate", {}, allocate
    )

    def correct(record):
        record["funding"] = rules.correct(
            record["funding"], "swing", 750000, -50000, "Withdrawal", 800000
        )

    store.apply(
        "u", "kite", "account", row["period_id"], "correction", "correct", {}, correct
    )
    fresh = store.read("u", "kite", "account")
    assert fresh["funding"]["modes"]["intraday"]["capital"] == 200000
    assert fresh["funding"]["modes"]["swing"]["capital"] == 750000
    assert rules.status(fresh["funding"], 950000)["entries_allowed"]


def test_closed_intraday_effects_survive_until_swing_closes_then_next_period_captures_fresh(
    db,
):
    from app.services import swing_funding_store as store, swing_accounting as rules

    row = store.initialize("u", "kite", "account", 1000000)
    period = row["period_id"]
    store.start_participant("u", "kite", "account", period, "swing", "portfolio", 0.8)
    store.start_participant(
        "u", "kite", "account", period, "intraday", "first-day", 0.2
    )
    store.apply(
        "u",
        "kite",
        "account",
        period,
        "loss",
        "cash",
        {},
        lambda r: r.update(
            funding=rules.movement(r["funding"], "intraday", -3000, -3000)
        ),
    )
    store.close_participant("u", "kite", "account", period, "intraday", "first-day")
    with pytest.raises(Exception):
        store.finish_period("u", "kite", "account", period)
    changed = store.start_participant(
        "u", "kite", "account", period, "intraday", "second-day", 0.2
    )
    assert changed["funding"]["modes"]["intraday"]["capital"] == 200000
    assert changed["funding"]["modes"]["intraday"]["expected_balance"] == 197000
    store.close_participant("u", "kite", "account", period, "intraday", "second-day")
    store.close_participant("u", "kite", "account", period, "swing", "portfolio")
    store.finish_period("u", "kite", "account", period)
    next_period = store.initialize("u", "kite", "account", 997000)
    assert next_period["period_id"] != period
    assert next_period["funding"]["starting_capital"] == 997000
    archived = store._table().get_item(
        Key={"user_id": store.partition("kite", "account"), "ledger_id": f"funding-period:{period}"}
    )["Item"]
    assert int(archived["funding"]["starting_capital"]) == 1000000


def test_analytics_receipts_separate_reference_edits_from_capital_transfers(db,monkeypatch):
    from app.services.swing_analytics import funding_flows
    current=store.initialize('u','kite','account',10000)
    def start(row):
        row['funding']=rules.allocate(row['funding'],'swing',1)
        row['participants']['swing']={'identity':'portfolio','owner_user_id':'u','active':True}
    store.apply('u','kite','account',current['period_id'],'start','participant_start',{},start)
    def reference(row):row['funding']['modes']['swing']['capital']=5000
    store.apply('u','kite','account',current['period_id'],'reference','capital_reset',{},reference)
    def transfer(row):row['funding']['modes']['swing']['funding_allocation']+=1000
    first=store.apply('u','kite','account',current['period_id'],'transfer','allocation',{},transfer)
    repeated=store.apply('u','kite','account',current['period_id'],'transfer','allocation',{},transfer)
    assert first['version']==repeated['version']
    flows,complete=funding_flows({'session_id':'portfolio','mode':'real','execution_broker':'kite','broker_account_id':'account','real_funding_period':current['period_id']})
    assert complete and len(flows)==1 and flows[0]['cash_flow']==1000
    assert flows[0]['classification']=='capital_transfer'
