"""
Tests for Pattern Logger (Phase XII Sprint 2).

Covers:
- pattern_logger_service CRUD (mocked DynamoDB)
- /api/pattern/* REST endpoints via TestClient
- OHLC equity/options endpoints
"""
import json
import pytest
import pandas as pd
import numpy as np
from unittest.mock import patch, MagicMock
from httpx import AsyncClient, ASGITransport
from boto3.dynamodb.conditions import Key

from app.main import app
from app.services import pattern_logger_service as svc


USER = "00000000-0000-0000-0000-000000000001"


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def no_auth():
    with patch("app.dependencies.get_request_user_id", return_value=USER):
        yield


@pytest.fixture(autouse=True)
def no_seed_user():
    with patch("app.services.user_service.seed_user", return_value=None):
        yield


@pytest.fixture(autouse=True)
def no_share_setup():
    with patch("app.services.pattern_logger_service._ensure_share_table", return_value=None):
        yield


@pytest.fixture(autouse=True)
def empty_share_table():
    with patch("app.services.pattern_logger_service._share_table", return_value=_mock_table()):
        yield


class _FakeNamesTable:
    """In-memory PatternNames table keyed by (user_id, name_key)."""

    def __init__(self):
        self.items: dict[tuple[str, str], dict] = {}

    def put_item(self, Item):
        self.items[(Item["user_id"], Item["name_key"])] = Item

    def get_item(self, Key):
        item = self.items.get((Key["user_id"], Key["name_key"]))
        return {"Item": item} if item else {}

    def query(self, KeyConditionExpression, ExclusiveStartKey=None):
        owner_cond, prefix_cond = KeyConditionExpression._values
        owner = owner_cond._values[1]
        prefix = prefix_cond._values[1]
        return {"Items": [i for (uid, key), i in self.items.items() if uid == owner and key.startswith(prefix)]}

    def batch_writer(self):
        table = self

        class _Batch:
            def __enter__(self_inner):
                return table

            def __exit__(self_inner, *exc):
                return False

        return _Batch()


@pytest.fixture(autouse=True)
def names_table():
    table = _FakeNamesTable()
    svc._backfilled_owners.clear()
    with patch("app.services.pattern_logger_service._names_table", return_value=table), \
         patch("app.services.pattern_logger_service._ensure_names_table", return_value=None):
        yield table
    svc._backfilled_owners.clear()


def _mock_table(items: list[dict] | None = None):
    """Return a MagicMock that mimics a DynamoDB Table object."""
    table = MagicMock()
    _store: dict[str, dict] = {}

    def _key_for(item_or_key: dict) -> str:
        if "chart_id" in item_or_key:
            return item_or_key["chart_id"]
        if "owner_user_id" in item_or_key and "shared_user_id" in item_or_key:
            return f'{item_or_key["owner_user_id"]}|{item_or_key["shared_user_id"]}'
        if "user_id" in item_or_key and "date" in item_or_key and "symbol" in item_or_key:
            return f'{item_or_key["user_id"]}|{item_or_key["symbol"]}|{item_or_key["date"]}'
        return str(sorted(item_or_key.items()))

    if items:
        for item in items:
            _store[_key_for(item)] = item

    def put_item(Item):
        _store[_key_for(Item)] = Item

    def get_item(Key):
        item = _store.get(_key_for(Key))
        return {"Item": item} if item else {}

    def delete_item(Key):
        _store.pop(_key_for(Key), None)

    def scan(FilterExpression=None):
        return {"Items": list(_store.values())}

    def query(IndexName=None, KeyConditionExpression=None):
        field = None
        value = None
        try:
            if KeyConditionExpression is not None and hasattr(KeyConditionExpression, "_values"):
                field_obj, value = KeyConditionExpression._values
                field = getattr(field_obj, "name", None)
        except Exception:
            field = None
            value = None
        if field:
            return {"Items": [item for item in _store.values() if item.get(field) == value]}
        return {"Items": list(_store.values())}

    def update_item(Key, UpdateExpression, ExpressionAttributeValues, ReturnValues):
        item = _store.get(Key["chart_id"], {})
        item.update({
            "annotations": ExpressionAttributeValues[":a"],
            "notes": ExpressionAttributeValues[":n"],
            "updated_at": ExpressionAttributeValues[":u"],
        })
        if ":tp" in ExpressionAttributeValues:
            item["top_patterns"] = ExpressionAttributeValues[":tp"]
        _store[Key["chart_id"]] = item
        return {"Attributes": dict(item)}  # DynamoDB returns a copy; callers mutate it

    table.put_item = put_item
    table.get_item = get_item
    table.delete_item = delete_item
    table.scan = scan
    table.query = query
    table.update_item = update_item
    return table


@pytest.fixture
def mock_dynamo():
    table = _mock_table()
    with patch("app.services.pattern_logger_service._table", return_value=table):
        yield table


def _sample_annotation(strategy: str = "Double Top", typ: str = "entry", instrument: str = "CE", category: str = "") -> dict:
    return {
        "id": "ann-1",
        "time": 1746518100,
        "price": 24205.0,
        "type": typ,
        "instrument": instrument,
        "strategy_name": strategy,
        "category": category,
        "text": f"{typ.capitalize()} {instrument} — {strategy}",
    }



# ── Service unit tests ────────────────────────────────────────────────────────

class TestPatternLoggerService:
    def test_create_chart_returns_chart_id(self, mock_dynamo):
        chart = svc.create_chart(USER, "NIFTY", "2026-05-06", "options", [], right="CE")
        assert "chart_id" in chart
        assert chart["symbol"] == "NIFTY"
        assert chart["right"] == "CE"

    def test_create_chart_stores_annotations(self, mock_dynamo):
        ann = _sample_annotation()
        chart = svc.create_chart(USER, "NIFTY", "2026-05-06", "options", [ann])
        assert len(chart["annotations"]) == 1
        assert chart["annotations"][0]["strategy_name"] == "Double Top"

    def test_get_chart_returns_item(self, mock_dynamo):
        chart = svc.create_chart(USER, "NIFTY", "2026-05-06", "equity", [])
        fetched = svc.get_chart(chart["chart_id"])
        assert fetched is not None
        assert fetched["chart_id"] == chart["chart_id"]

    def test_get_chart_missing_returns_none(self, mock_dynamo):
        assert svc.get_chart("no-such-id") is None

    def test_update_chart_changes_annotations(self, mock_dynamo):
        chart = svc.create_chart(USER, "NIFTY", "2026-05-06", "equity", [])
        ann = _sample_annotation("EMA Reversal", "exit")
        updated = svc.update_chart(chart["chart_id"], [ann], "test note")
        assert updated is not None
        assert len(updated["annotations"]) == 1
        assert updated["annotations"][0]["strategy_name"] == "EMA Reversal"

    def test_delete_chart_removes_item(self, mock_dynamo):
        chart = svc.create_chart(USER, "NIFTY", "2026-05-06", "equity", [])
        svc.delete_chart(chart["chart_id"])
        assert svc.get_chart(chart["chart_id"]) is None

    def test_list_strategy_names_returns_unique_names(self, mock_dynamo):
        anns = [
            _sample_annotation("Strategy A"),
            _sample_annotation("Strategy B"),
        ]
        svc.create_chart(USER, "NIFTY", "2026-05-06", "options", anns)
        names = svc.list_strategy_names(USER)
        assert "Strategy A" in names
        assert "Strategy B" in names

    def test_list_category_names_returns_unique_names(self, mock_dynamo):
        anns = [
            _sample_annotation("Strategy A", category="Category A"),
            _sample_annotation("Strategy B", category="Category B"),
        ]
        svc.create_chart(USER, "NIFTY", "2026-05-06", "options", anns)
        names = svc.list_category_names(USER)
        assert "Category A" in names
        assert "Category B" in names

    def test_list_charts_filters_by_strategy(self, mock_dynamo):
        svc.create_chart(USER, "NIFTY", "2026-05-06", "equity", [_sample_annotation("Alpha")])
        svc.create_chart(USER, "NIFTY", "2026-05-07", "equity", [_sample_annotation("Beta")])
        charts = svc.list_charts_for_user(USER, strategy="Alpha")
        assert len(charts) == 1
        assert charts[0]["date"] == "2026-05-06"

    def test_list_charts_filters_by_category(self, mock_dynamo):
        svc.create_chart(USER, "NIFTY", "2026-05-06", "equity", [_sample_annotation("Alpha", category="CatX")])
        svc.create_chart(USER, "NIFTY", "2026-05-07", "equity", [_sample_annotation("Beta", category="CatY")])
        charts = svc.list_charts_for_user(USER, category="CatX")
        assert len(charts) == 1
        assert charts[0]["date"] == "2026-05-06"


    def test_find_chart_by_date(self, mock_dynamo):
        svc.create_chart(USER, "NIFTY", "2026-05-06", "equity", [])
        found = svc.find_chart_by_date(USER, "NIFTY", "2026-05-06", "equity")
        assert found is not None

    def test_find_chart_by_date_missing(self, mock_dynamo):
        found = svc.find_chart_by_date(USER, "NIFTY", "1999-01-01", "equity")
        assert found is None

    def test_list_charts_entry_exit_counts(self, mock_dynamo):
        anns = [
            _sample_annotation("S1", "entry"),
            _sample_annotation("S1", "exit"),
            _sample_annotation("S1", "entry"),
        ]
        svc.create_chart(USER, "NIFTY", "2026-05-06", "equity", anns)
        charts = svc.list_charts_for_user(USER, strategy="S1")
        assert charts[0]["entry_count"] == 2
        assert charts[0]["exit_count"] == 1

    def test_list_charts_includes_shared_owner(self, mock_dynamo):
        owner = "00000000-0000-0000-0000-000000000002"
        shared = _mock_table([
            {"owner_user_id": owner, "shared_user_id": USER, "owner_email": "owner@example.com", "shared_email": "user@example.com", "created_at": "2026-01-01", "updated_at": "2026-01-01"},
        ])
        with patch("app.services.pattern_logger_service._share_table", return_value=shared):
            svc.create_chart(owner, "NIFTY", "2026-05-06", "equity", [_sample_annotation("SharedStrat")])
            charts = svc.list_charts_for_user(USER)
        assert len(charts) == 1
        assert charts[0]["user_id"] == owner
        assert charts[0]["can_delete"] is False

    def test_sync_pattern_shares_replaces_existing(self, mock_dynamo):
        share_table = _mock_table([
            {"owner_user_id": USER, "shared_user_id": "old-user", "owner_email": "user@example.com", "shared_email": "old@example.com", "created_at": "2026-01-01", "updated_at": "2026-01-01"},
        ])
        with patch("app.services.pattern_logger_service._share_table", return_value=share_table), \
             patch("app.services.user_service.get_user_info", return_value={"user_id": USER, "email": "user@example.com"}), \
             patch("app.services.user_service.get_user_by_email", side_effect=lambda email: {"user_id": f"{email}-id", "email": email}):
            targets = svc.sync_pattern_shares(USER, "A@example.com, b@example.com")
        assert [t["email"] for t in targets] == ["a@example.com", "b@example.com"]
        items = share_table.query(KeyConditionExpression=Key("owner_user_id").eq(USER))["Items"]
        assert {item["shared_email"] for item in items} == {"a@example.com", "b@example.com"}


# ── API endpoint tests ────────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestPatternLoggerAPI:
    async def test_list_strategies_empty(self):
        table = _mock_table()
        with patch("app.services.pattern_logger_service._table", return_value=table):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/api/pattern/strategies")
        assert resp.status_code == 200
        assert resp.json()["strategies"] == []

    async def test_create_and_get_chart(self):
        table = _mock_table()
        with patch("app.services.pattern_logger_service._table", return_value=table):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                create_resp = await client.post("/api/pattern/chart", json={
                    "symbol": "NIFTY",
                    "date": "2026-05-06",
                    "instrument_type": "equity",
                    "annotations": [],
                    "notes": "test",
                })
                assert create_resp.status_code == 200
                chart_id = create_resp.json()["chart_id"]

                get_resp = await client.get(f"/api/pattern/chart/{chart_id}")
                assert get_resp.status_code == 200
                assert get_resp.json()["chart_id"] == chart_id

    async def test_update_chart(self):
        table = _mock_table()
        with patch("app.services.pattern_logger_service._table", return_value=table):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                create_resp = await client.post("/api/pattern/chart", json={
                    "symbol": "NIFTY",
                    "date": "2026-05-06",
                    "instrument_type": "equity",
                    "annotations": [],
                })
                chart_id = create_resp.json()["chart_id"]

                ann = _sample_annotation("RevStrat", "entry", "underlying")
                put_resp = await client.put(f"/api/pattern/chart/{chart_id}", json={
                    "annotations": [ann],
                    "notes": "updated",
                })
                assert put_resp.status_code == 200

    async def test_delete_chart(self):
        table = _mock_table()
        with patch("app.services.pattern_logger_service._table", return_value=table):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                create_resp = await client.post("/api/pattern/chart", json={
                    "symbol": "NIFTY",
                    "date": "2026-05-06",
                    "instrument_type": "equity",
                    "annotations": [],
                })
                chart_id = create_resp.json()["chart_id"]

                del_resp = await client.delete(f"/api/pattern/chart/{chart_id}")
                assert del_resp.status_code == 200

                get_resp = await client.get(f"/api/pattern/chart/{chart_id}")
                assert get_resp.status_code == 404

    async def test_get_chart_not_found(self):
        table = _mock_table()
        with patch("app.services.pattern_logger_service._table", return_value=table):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/api/pattern/chart/no-such-id")
        assert resp.status_code == 404

    async def test_list_charts_by_strategy(self):
        table = _mock_table()
        with patch("app.services.pattern_logger_service._table", return_value=table):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                # Create chart with one strategy
                await client.post("/api/pattern/chart", json={
                    "symbol": "NIFTY",
                    "date": "2026-05-06",
                    "instrument_type": "equity",
                    "annotations": [_sample_annotation("TestStrat")],
                })
                resp = await client.get("/api/pattern/charts", params={"strategy": "TestStrat"})
        assert resp.status_code == 200
        assert len(resp.json()["charts"]) == 1

    async def test_list_categories_empty(self):
        table = _mock_table()
        with patch("app.services.pattern_logger_service._table", return_value=table):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/api/pattern/categories")
        assert resp.status_code == 200
        assert resp.json()["categories"] == []

    async def test_list_charts_by_category(self):
        table = _mock_table()
        with patch("app.services.pattern_logger_service._table", return_value=table):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                # Create chart with one category
                await client.post("/api/pattern/chart", json={
                    "symbol": "NIFTY",
                    "date": "2026-05-06",
                    "instrument_type": "equity",
                    "annotations": [_sample_annotation("TestStrat", category="TestCat")],
                })
                resp = await client.get("/api/pattern/charts", params={"category": "TestCat"})
        assert resp.status_code == 200
        assert len(resp.json()["charts"]) == 1


    async def test_by_date_not_found(self):
        table = _mock_table()
        with patch("app.services.pattern_logger_service._table", return_value=table):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/api/pattern/chart/by-date", params={
                    "symbol": "NIFTY",
                    "date": "1999-01-01",
                    "instrument_type": "equity",
                })
        assert resp.status_code == 404


# ── Name registry ─────────────────────────────────────────────────────────────

OTHER = "00000000-0000-0000-0000-000000000002"


class TestPatternNameRegistry:
    def test_add_name_trims_and_is_listed(self, mock_dynamo):
        assert svc.add_name(USER, "category", "  Breakout  ") == "Breakout"
        assert svc.list_category_names(USER) == ["Breakout"]
        assert svc.list_strategy_names(USER) == []

    def test_add_name_is_idempotent(self, mock_dynamo):
        svc.add_name(USER, "strategy", "ORB")
        svc.add_name(USER, "strategy", "ORB")
        assert svc.list_strategy_names(USER) == ["ORB"]

    @pytest.mark.parametrize("bad", ["", "   ", "x" * (svc.MAX_NAME_LENGTH + 1), "a::b"])
    def test_add_name_rejects_invalid(self, mock_dynamo, bad):
        with pytest.raises(ValueError):
            svc.add_name(USER, "category", bad)

    def test_add_name_rejects_unknown_kind(self, mock_dynamo):
        with pytest.raises(ValueError):
            svc.add_name(USER, "colour", "Red")

    def test_register_annotation_names_registers_both_kinds(self, mock_dynamo):
        svc.register_annotation_names(USER, [_sample_annotation("Alpha", category="Trend")])
        assert svc.list_strategy_names(USER) == ["Alpha"]
        assert svc.list_category_names(USER) == ["Trend"]

    def test_name_survives_chart_deletion(self, mock_dynamo):
        anns = [_sample_annotation("Alpha", category="Trend")]
        svc.register_annotation_names(USER, anns)
        chart = svc.create_chart(USER, "NIFTY", "2026-05-06", "equity", anns)
        svc.delete_chart(chart["chart_id"])
        assert svc.list_strategy_names(USER) == ["Alpha"]

    def test_legacy_chart_names_backfilled_once(self, mock_dynamo, names_table):
        svc.create_chart(USER, "NIFTY", "2026-05-06", "equity", [_sample_annotation("Legacy", category="Old")])
        assert svc.list_strategy_names(USER) == ["Legacy"]
        assert svc.list_category_names(USER) == ["Old"]
        assert (USER, svc._BACKFILL_KEY) in names_table.items

        # A chart saved behind the registry's back is not picked up again: the import runs once.
        svc.create_chart(USER, "NIFTY", "2026-05-07", "equity", [_sample_annotation("Later")])
        svc._backfilled_owners.clear()
        assert svc.list_strategy_names(USER) == ["Legacy"]

    def test_shared_user_sees_owner_names(self, mock_dynamo):
        svc.add_name(OTHER, "category", "Owner Cat")
        svc.add_name(USER, "category", "My Cat")
        with patch("app.services.pattern_logger_service._load_shared_owner_ids", return_value=[USER, OTHER]):
            assert svc.list_category_names(USER) == ["My Cat", "Owner Cat"]
        assert svc.list_category_names(OTHER) == ["Owner Cat"]


@pytest.mark.asyncio
class TestPatternNameAPI:
    async def test_post_category_returns_updated_list(self, mock_dynamo):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/api/pattern/categories", json={"name": " Reversal "})
            assert resp.status_code == 200
            assert resp.json() == {"categories": ["Reversal"]}
            listed = await client.get("/api/pattern/categories")
            assert listed.json() == {"categories": ["Reversal"]}

    async def test_post_strategy_returns_updated_list(self, mock_dynamo):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/api/pattern/strategies", json={"name": "Gap Fill"})
            assert resp.status_code == 200
            assert resp.json() == {"strategies": ["Gap Fill"]}

    @pytest.mark.parametrize("bad", ["", "  ", "a::b"])
    async def test_post_invalid_name_is_400(self, mock_dynamo, bad):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/api/pattern/categories", json={"name": bad})
            assert resp.status_code == 400

    async def test_updating_chart_registers_new_names(self, mock_dynamo):
        base = {"symbol": "NIFTY", "date": "2026-05-06", "instrument_type": "equity", "annotations": []}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            chart_id = (await client.post("/api/pattern/chart", json=base)).json()["chart_id"]
            update = {"annotations": [_sample_annotation("Added Later", category="Added Cat")], "notes": ""}
            assert (await client.put(f"/api/pattern/chart/{chart_id}", json=update)).status_code == 200
            assert (await client.get("/api/pattern/strategies")).json() == {"strategies": ["Added Later"]}
            assert (await client.get("/api/pattern/categories")).json() == {"categories": ["Added Cat"]}

    async def test_saving_chart_registers_names(self, mock_dynamo):
        body = {"symbol": "NIFTY", "date": "2026-05-06", "instrument_type": "equity",
                "annotations": [_sample_annotation("Fresh Strat", category="Fresh Cat")]}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await client.post("/api/pattern/chart", json=body)).status_code == 200
            assert (await client.get("/api/pattern/strategies")).json() == {"strategies": ["Fresh Strat"]}
            assert (await client.get("/api/pattern/categories")).json() == {"categories": ["Fresh Cat"]}


@pytest.mark.asyncio
class TestPatternLoggerOHLC:
    async def test_ohlc_equity_success(self, tmp_path):
        n = 60
        start = pd.Timestamp("2026-05-06 09:15:00")
        idx = pd.date_range(start, periods=n, freq="s")
        df = pd.DataFrame({
            "open": [24200.0] * n, "high": [24210.0] * n,
            "low": [24190.0] * n, "close": [24205.0] * n,
        }, index=idx)
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pkl)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), \
             patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"), \
             patch("app.services.broker_service.fetch_historical", return_value=None):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/api/pattern/ohlc/equity", params={
                    "symbol": "NIFTY",
                    "date": "2026-05-06",
                    "interval_minutes": 1,
                })
        assert resp.status_code == 200
        data = resp.json()
        assert "candles" in data
        assert len(data["candles"]) > 0
        assert "time" in data["candles"][0]

    async def test_ohlc_equity_missing_data(self):
        # The route checks downloads before local reads; keep this test offline.
        with patch("app.services.broker_service.fetch_historical", return_value=None), \
             patch("app.services.data_loader.load_dataframe", side_effect=FileNotFoundError):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/api/pattern/ohlc/equity", params={
                    "symbol": "NIFTY",
                    "date": "1999-01-01",
                })
        assert resp.status_code == 404

    async def test_ohlc_options_invalid_right(self):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/pattern/ohlc/options", params={
                "symbol": "NIFTY",
                "date": "2026-05-06",
                "strike": 24200,
                "expiry": "2026-05-29",
                "right": "XX",
            })
        assert resp.status_code == 400
