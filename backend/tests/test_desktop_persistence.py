from unittest.mock import patch
from decimal import Decimal
from botocore.exceptions import ClientError
from fastapi import HTTPException
import asyncio
import pytest

from app.services import desktop_persistence_service as persistence
from app.routers import desktop_persistence as persistence_router


class FakeTable:
    def __init__(self):
        self.items = {}

    def query(self, **_kwargs):
        return {"Items": list(self.items.values())}

    def put_item(self, Item, **_kwargs):
        self.items[(Item["user_id"], Item["record_id"])] = Item

    def get_item(self, Key, **_kwargs):
        return {"Item": self.items.get((Key["user_id"], Key["record_id"]))}


def equity(symbol="NIFTY"):
    return {"kind": "index", "exchange": "NSE", "symbol": symbol}


def option(right="CE", strike=24000, expiry="2026-05-07"):
    return {
        "kind": "option",
        "exchange": "NSE",
        "underlying": "NIFTY",
        "expiry": expiry,
        "strike": strike,
        "right": right,
    }


def line():
    return {
        "tool": "Horizontal",
        "points": [{"timestamp": 1778058900, "price": 24000.0}],
        "style": {"color": "#facc15", "width": 2},
        "visible": True,
        "locked": False,
    }


def test_drawings_are_filtered_by_canonical_instrument():
    table = FakeTable()
    with patch.object(persistence, "_table", return_value=table):
        persistence.create_drawing("user-1", equity(), line(), "mutation-1")
        persistence.create_drawing("user-1", equity("BANKNIFTY"), line(), "mutation-2")
        persistence.create_drawing("user-1", option("PE"), line(), "mutation-3")

        drawings = persistence.list_drawings("user-1", equity())

    assert len(drawings) == 1
    assert drawings[0]["drawing"]["tool"] == "Horizontal"
    assert drawings[0]["drawing"]["points"][0]["price"] == Decimal("24000.0")
    assert drawings[0]["instrument"] == equity()


def test_deleted_drawing_is_excluded_from_reload():
    table = FakeTable()
    with patch.object(persistence, "_table", return_value=table):
        created = persistence.create_drawing("user-1", equity(), line(), "mutation-1")
        deleted = persistence.update_drawing(
            "user-1",
            created["drawing_id"],
            created["drawing"],
            created["revision"],
            "mutation-2",
            deleted=True,
        )
        visible = persistence.list_drawings("user-1", equity())
        deleted_records = persistence.list_drawings("user-1", equity(), include_deleted=True)

    assert deleted["deleted"] is True
    assert deleted["drawing"]["points"][0]["price"] == Decimal("24000.0")
    assert visible == []
    assert len(deleted_records) == 1


def test_screen_conditional_write_conflict_is_normalized():
    class ConflictTable(FakeTable):
        def put_item(self, Item, **_kwargs):
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException", "Message": "stale"}},
                "PutItem",
            )

    table = ConflictTable()
    table.items[("user-1", "screen-1")] = {
        "user_id": "user-1",
        "record_id": "screen-1",
        "screen_id": "screen-1",
        "revision": 1,
    }
    with patch.object(persistence, "_table", return_value=table):
        with pytest.raises(ValueError, match="revision_conflict"):
            persistence.update_screen("user-1", "screen-1", "Paper", {}, 1, "mutation-1")


def test_get_screen_uses_consistent_read_and_user_scope():
    class ReadTable(FakeTable):
        def get_item(self, Key, **kwargs):
            assert kwargs == {"ConsistentRead": True}
            return super().get_item(Key)

    table = ReadTable()
    table.items[("user-1", "screen-1")] = {"screen_id": "screen-1", "revision": 2}
    with patch.object(persistence, "_table", return_value=table):
        assert persistence.get_screen("user-1", "screen-1")["revision"] == 2
        assert persistence.get_screen("user-2", "screen-1") is None


def test_get_screen_route_returns_record_and_404():
    with patch.object(persistence, "get_screen", side_effect=lambda user, screen: {"screen_id": screen, "revision": 3} if user == "user-1" else None):
        assert asyncio.run(persistence_router.get_screen("screen-1", "user-1"))["revision"] == 3
        with pytest.raises(HTTPException) as error:
            asyncio.run(persistence_router.get_screen("screen-1", "user-2"))
    assert error.value.status_code == 404
