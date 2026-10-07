"""Real API/database boundaries with isolated DynamoDB; no provider requests."""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch
import asyncio
import boto3
import pandas as pd
import pytest
from moto import mock_aws
from fastapi.testclient import TestClient
from app.main import app
from app.services import performance_service as perf


@pytest.fixture
def database(monkeypatch):
    with mock_aws():
        db = boto3.resource(
            "dynamodb",
            region_name="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        )
        for table, sort in [
            ("Sessions", None),
            ("Trades", "trade_id"),
            ("Orders", "order_id"),
            ("TradeLabels", "round_trip_index"),
        ]:
            keys = [{"AttributeName": "session_id", "KeyType": "HASH"}]
            attrs = [{"AttributeName": "session_id", "AttributeType": "S"}]
            if sort:
                keys.append({"AttributeName": sort, "KeyType": "RANGE"})
                attrs.append(
                    {
                        "AttributeName": sort,
                        "AttributeType": "N" if sort == "round_trip_index" else "S",
                    }
                )
            extra = {}
            if table == "Sessions":
                attrs.append({"AttributeName": "user_id", "AttributeType": "S"})
                extra["GlobalSecondaryIndexes"] = [
                    dict(
                        IndexName="UserIdIndex",
                        KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"}],
                        Projection={"ProjectionType": "ALL"},
                    )
                ]
            db.create_table(
                TableName=table,
                KeySchema=keys,
                AttributeDefinitions=attrs,
                BillingMode="PAY_PER_REQUEST",
                **extra,
            )
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: db)
        monkeypatch.setattr("app.services.trade_label_service._ENSURED", True)
        yield db


def seed(db, user="alice", sid="session", mode="paper"):
    session = dict(
        session_id=sid,
        user_id=user,
        symbol="NIFTY",
        date="2026-10-06",
        session_capital=Decimal("10000"),
        session_type=mode,
        instrument_type="equity",
    )
    db.Table("Sessions").put_item(Item=session)
    for i, side, price in [("1", "BUY", 100), ("2", "SELL", 110)]:
        db.Table("Trades").put_item(
            Item=dict(
                session_id=sid,
                trade_id=i,
                user_id=user,
                symbol="NIFTY",
                side=side,
                quantity=40,
                price=Decimal(price),
                timestamp=int(i),
                commission=Decimal(1),
            )
        )
    return session


def test_reports_include_unlabeled_trades_and_enforce_user_scope(database):
    seed(database)
    seed(database, "bob", "other")
    with TestClient(app) as client:
        response = client.get(
            "/api/analysis/performance", headers={"X-User-Id": "alice"}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["summary"]["count"] == 1 and body["summary"]["net_pnl"] == 398
        assert body["coverage"]["labeled_cycles"] == 0
        page = client.get(
            "/api/analysis/performance/cycles", headers={"X-User-Id": "alice"}
        ).json()
        assert len(page["items"]) == 1 and page["items"][0]["user_id"] == "alice"
        cycle = page["items"][0]
        assert (
            client.get(
                f"/api/analysis/performance/cycles/{cycle['cycle_id']}?session_id=session",
                headers={"X-User-Id": "bob"},
            ).status_code
            == 404
        )
        assert (
            client.get(
                "/api/analysis/labels?session_id=session", headers={"X-User-Id": "bob"}
            ).status_code
            == 404
        )
        assert (
            client.get(
                "/api/analysis/round-trips?session_id=session",
                headers={"X-User-Id": "bob"},
            ).status_code
            == 404
        )


def test_cycle_pagination_and_detail(database):
    seed(database)
    seed(database, sid="second")
    with TestClient(app) as client:
        first = client.get(
            "/api/analysis/performance/cycles?limit=1", headers={"X-User-Id": "alice"}
        ).json()
        assert first["total"] == 2 and first["next_offset"] == 1
        second = client.get(
            "/api/analysis/performance/cycles?limit=1&offset=1",
            headers={"X-User-Id": "alice"},
        ).json()
        assert (
            second["next_offset"] is None
            and first["items"][0]["cycle_id"] != second["items"][0]["cycle_id"]
        )
        c = first["items"][0]
        detail = client.get(
            f"/api/analysis/performance/cycles/{c['cycle_id']}?session_id={c['session_id']}",
            headers={"X-User-Id": "alice"},
        )
        assert (
            detail.status_code == 200 and detail.json()["matches"][0]["quantity"] == 40
        )


def test_invalid_filters_and_unavailable_database_are_not_empty_success(
    database, monkeypatch
):
    with TestClient(app) as client:
        assert (
            client.get(
                "/api/analysis/performance?start_date=2026-10-06&end_date=2026-09-01"
            ).status_code
            == 422
        )
        assert (
            client.get("/api/analysis/performance?session_type=unknown").status_code
            == 422
        )

        def broken(*args, **kw):
            raise RuntimeError("offline")

        monkeypatch.setattr(perf, "load_cycles", broken)
        assert client.get("/api/analysis/performance").status_code == 503


def test_database_queries_consume_every_page():
    from unittest.mock import Mock

    table = Mock()
    table.query.side_effect = [
        dict(Items=[1], LastEvaluatedKey={"cursor": "next"}),
        dict(Items=[2]),
    ]
    assert perf.query_all(table, IndexName="test") == [1, 2]
    assert table.query.call_args.kwargs["ExclusiveStartKey"] == {"cursor": "next"}


def test_stable_labels_survive_reversal(database):
    session = seed(database)
    database.Table("Trades").delete_item(Key={"session_id": "session", "trade_id": "2"})
    database.Table("Trades").put_item(
        Item=dict(
            session_id="session",
            trade_id="2",
            user_id="alice",
            symbol="NIFTY",
            side="SELL",
            quantity=60,
            price=Decimal(110),
            timestamp=2,
            commission=Decimal(1),
        )
    )
    cycles = perf.load_session_cycles(session, include_labels=False)
    assert len(cycles) == 2 and cycles[0]["state"] == "closed"
    database.Table("TradeLabels").put_item(
        Item=dict(
            session_id="session",
            round_trip_index=0,
            user_id="alice",
            analytics_cycle_id=cycles[0]["cycle_id"],
            entry_tag="Breakout",
        )
    )
    result = perf.load_session_cycles(session)
    assert result[0]["label"]["entry_tag"] == "Breakout" and result[1]["label"] is None


@pytest.mark.parametrize("mode", ["live", "replay"])
def test_history_pages_scan_calendar_dates_and_preserve_worker_mode(monkeypatch, mode):
    from app.routers import desktop, data
    from app.services.historical_data_service import history_mode, HistoricalPolicy

    monkeypatch.setattr(
        "app.services.historical_data_service.get_policy", lambda: HistoricalPolicy()
    )
    monkeypatch.setattr(data, "_ensure_data", lambda *args: None)
    observed = []

    def frame(symbol, day):
        observed.append((day, history_mode()))
        return pd.DataFrame(
            {"open": [100.0], "high": [110.0], "low": [90.0], "close": [105.0]},
            index=pd.DatetimeIndex([f"{day} 09:15:00"], tz="UTC"),
        )

    monkeypatch.setattr(desktop, "load_dataframe", frame)
    page = asyncio.run(
        desktop.underlying_history_page(
            symbol="NIFTY",
            trading_date="2026-10-06",
            before_date="2026-10-06",
            interval_minutes=1,
            history_mode=mode,
            _="alice",
        )
    )
    assert page["scanned_dates"] == ["2026-10-05", "2026-10-04"]
    assert page["loaded_dates"] == ["2026-10-05"] and observed == [("2026-10-05", mode)]
    end = asyncio.run(
        desktop.underlying_history_page(
            symbol="NIFTY",
            trading_date="2026-10-06",
            before_date="2026-09-24",
            interval_minutes=1,
            history_mode=mode,
            _="alice",
        )
    )
    assert end["scanned_dates"] == ["2026-09-23"] and end["next_before_date"] is None


def test_history_failure_is_explicit_and_retryable(monkeypatch):
    from app.routers import desktop, data
    from fastapi import HTTPException

    monkeypatch.setattr(
        "app.services.historical_data_service.get_policy",
        lambda: SimpleNamespace(source="breeze", allow_fallback=False),
    )

    def unavailable(*args):
        raise HTTPException(503, "provider unavailable")

    monkeypatch.setattr(data, "_ensure_data", unavailable)
    page = asyncio.run(
        desktop.underlying_history_page(
            symbol="NIFTY",
            trading_date="2026-10-06",
            before_date="2026-10-06",
            interval_minutes=1,
            history_mode="replay",
            _="alice",
        )
    )
    assert page["unavailable_dates"] == ["2026-10-05"] and not page["candles"]


@pytest.mark.parametrize("metadata_encoding", ["decimal", "legacy-json-strings"])
def test_real_execution_reader_preserves_decimal_sizing_and_controller(
    database, monkeypatch, metadata_encoding
):
    from app.services.execution_analytics import snapshot
    from app.services.real_broker_state import encode

    monkeypatch.setattr("app.services.real_broker_state._links", {})
    session = seed(database, mode="real")
    meta = snapshot(
        SimpleNamespace(
            session_capital=10000, session_type="real", strategy_interval_secs=180
        ),
        quantity=40,
        price=100,
        side="BUY",
        risk_fraction=0.02,
        stop=95,
        entry_method="MARKET",
    )
    for i, side, price in [("1", "BUY", 100), ("2", "SELL", 110)]:
        database.Table("Trades").update_item(
            Key={"session_id": "session", "trade_id": i},
            UpdateExpression="SET kotak_order_id=:oid, broker_exchange=:exchange",
            ExpressionAttributeValues={":oid": i, ":exchange": "nse_cm"},
        )
        database.Table("Orders").put_item(
            Item=encode(
                dict(
                    session_id="session",
                    order_id=i,
                    kotak_order_id=i,
                    broker_exchange="nse_cm",
                    order_type="LIMIT",
                    analytics=(
                        meta
                        if side == "BUY"
                        else {"exit_method": "STOPLOSS", "exit_action_id": "one-stop"}
                    ),
                )
            )
        )
        database.Table("Orders").put_item(
            Item=encode(
                dict(
                    session_id="session",
                    order_id="execution:" + i,
                    broker_execution=dict(
                        exchange="nse_cm",
                        product="MIS",
                        kotak_order_id=i,
                        execution_id=i,
                        side=side,
                        quantity=40,
                        price=price,
                        timestamp=int(i),
                    ),
                )
            )
        )
    if metadata_encoding == "legacy-json-strings":
        # Bypass the repaired writer to reproduce already-stored reconciled rows.
        legacy = {key: str(value) if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool) else value
                  for key, value in meta.items()}
        database.Table("Orders").update_item(
            Key={"session_id": "session", "order_id": "1"},
            UpdateExpression="SET analytics=:meta",
            ExpressionAttributeValues={":meta": legacy},
        )
        database.Table("Orders").update_item(
            Key={"session_id": "session", "order_id": "2"},
            UpdateExpression="SET analytics=:meta",
            ExpressionAttributeValues={":meta": {"exit_method": "LIMIT", "controller_history": [
                {"timestamp": "2.0", "exit_method": "STOPLOSS", "exit_action_id": "one-stop", "selected_quantity": "40"}
            ]}},
        )
    cycles = perf.load_session_cycles(session)
    from app.services.trade_label_service import compute_round_trips_for_session
    trips = compute_round_trips_for_session("session")
    assert len(trips) == 1 and trips[0]["pnl"] == 398
    assert cycles[0]["entries"][0]["requested_pct"] == 2 and cycles[0]["entries"][0][
        "r_multiple"
    ] == pytest.approx(1.99)
    assert (
        cycles[0]["matches"][0]["exit_method"] == "STOPLOSS"
        and cycles[0]["net_pnl"] == 398
    )
    database.Table("Orders").update_item(
        Key={"session_id": "session", "order_id": "execution:2"},
        UpdateExpression="SET broker_execution.quantity=:q",
        ExpressionAttributeValues={":q": 20},
    )
    with pytest.raises(RuntimeError, match="totals changed"):
        perf.load_session_cycles(session)


def test_real_aliases_are_counted_once(database, monkeypatch):
    monkeypatch.setattr("app.services.real_broker_state._links", {})
    session = seed(database, mode="real")
    for sid in ["session", "alias"]:
        database.Table("Sessions").put_item(
            Item={
                **session,
                "session_id": sid,
                "broker_projection_id": "projection",
                "broker_projection_owner": "session",
            }
        )
    database.Table("Sessions").put_item(
        Item=dict(
            session_id="projection",
            active_partition="partition",
            revision="v1",
            owner_session_id="session",
        )
    )
    for row in database.Table("Trades").query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("session_id").eq("session")
    )["Items"]:
        database.Table("Trades").put_item(Item={**row, "session_id": "partition"})
    rows = perf.load_cycles("alice")
    assert len(rows) == 1 and rows[0]["session_id"] == "session"
