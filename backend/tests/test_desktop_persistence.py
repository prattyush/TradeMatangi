from unittest.mock import patch

from app.services import desktop_persistence_service as persistence


class FakeTable:
    def __init__(self):
        self.items = {}

    def query(self, **_kwargs):
        return {"Items": list(self.items.values())}

    def put_item(self, Item, **_kwargs):
        self.items[(Item["user_id"], Item["record_id"])] = Item

    def get_item(self, Key):
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
    assert visible == []
    assert len(deleted_records) == 1
