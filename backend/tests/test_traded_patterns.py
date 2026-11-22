"""Phase 26, S10 — traded patterns: the user's labelled trades listed, drawn and copied into pattern charts."""
import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app.dependencies import get_request_user_id
from app.main import app
from app.services import pattern_logger_service as patterns
from app.services import trade_label_service as labels
from app.services import traded_patterns_service as svc

USER, OTHER = "alice", "bob"
BAR = 180


@pytest.fixture
def database(monkeypatch):
    with mock_aws():
        db = boto3.resource("dynamodb", region_name="us-east-1", aws_access_key_id="fake", aws_secret_access_key="fake")
        client = boto3.client("dynamodb", region_name="us-east-1", aws_access_key_id="fake", aws_secret_access_key="fake")
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: db)
        monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
        monkeypatch.setattr(labels, "_ENSURED", False)
        db.create_table(TableName="Sessions", BillingMode="PAY_PER_REQUEST",
                        KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
                        AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}])
        yield db


def add_session(db, sid, user=USER, symbol="NIFTY", date="2026-10-06", session_type="paper"):
    db.Table("Sessions").put_item(Item=dict(session_id=sid, user_id=user, symbol=symbol, date=date, session_type=session_type,
                                            instrument_type="options"))


def add_label(db, sid, index, user=USER, date="2026-10-06", symbol="NIFTY", expected=("Breakout", "ORB"), actual=("", ""), session_type="paper"):
    labels._table().put_item(Item=dict(
        session_id=sid, round_trip_index=index, user_id=user, symbol=symbol, date=date, instrument_type="options", session_type=session_type,
        expected_category=expected[0], expected_strategy=expected[1], actual_category=actual[0], actual_strategy=actual[1],
        entry_tag="AS_PER_PATTERN", exit_tag="AS_PER_PATTERN", round_trip_pnl=12, round_trip_pnl_pct=1, created_at="", updated_at=""))


def fill(side, quantity, price, timestamp, right=None, strike=None):
    return dict(trade_id=f"t{timestamp}", side=side, quantity=quantity, price=price, timestamp=timestamp, right=right, strike=strike)


def trip(index, entries, exits, right=None, strike=None, pnl=50.0, state="closed"):
    return dict(index=index, right=right, strike=strike, expiry="2026-10-13" if right else None, entry_trades=entries, exit_trades=exits,
                pnl=pnl, pnl_pct=0.5, state=state)


@pytest.fixture
def trips(monkeypatch):
    """Round trips per session, counting how often each session is rebuilt."""
    data, calls = {}, []

    def compute(session_id):
        calls.append(session_id)
        if data.get(session_id) is RuntimeError:
            raise RuntimeError("Round-trip history could not be read; retry later")
        return data.get(session_id, [])

    monkeypatch.setattr(labels, "compute_round_trips_for_session", compute)
    return type("Trips", (), {"data": data, "calls": calls})


# ── Direction ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("right,action,side", [
    (None, "BUY", "buy"), (None, "SELL", "sell"), ("CE", "BUY", "buy"), ("CE", "SELL", "sell"),
    ("PE", "BUY", "sell"), ("PE", "SELL", "buy"), ("pe", "sell", "buy"), ("CE", "", None), (None, "HOLD", None),
])
def test_a_position_belongs_to_the_side_it_profits_from(right, action, side):
    assert svc.setup_side(right, action) == side


# ── Summary: labels only ─────────────────────────────────────────────────────

def test_summary_lists_every_labelled_strategy_with_counts(database, trips):
    for sid, day in (("s1", "2026-10-06"), ("s2", "2026-10-07")):
        add_session(database, sid, date=day)
    add_label(database, "s1", 0, date="2026-10-06", expected=("Breakout", "ORB"))
    add_label(database, "s1", 1, date="2026-10-06", expected=("Breakout", "ORB"), actual=("Reversal", "Double top"))
    add_label(database, "s2", 0, date="2026-10-07", expected=("Breakout", "ORB"), actual=("Breakout", "ORB"))  # both: one trade
    add_label(database, "s2", 1, date="2026-10-07", expected=("", ""), actual=("", ""))  # unlabelled: ignored
    add_label(database, "s2", 2, user=OTHER, date="2026-10-07", expected=("Other", "Not mine"))
    rows = {(r["category"], r["strategy"]): r for r in svc.summary(USER)}
    assert set(rows) == {("Breakout", "ORB"), ("Reversal", "Double top")}
    orb = rows[("Breakout", "ORB")]
    assert (orb["trades"], orb["expected"], orb["actual"], orb["last_date"], orb["sessions"]) == (3, 3, 1, "2026-10-07", 2)
    assert rows[("Reversal", "Double top")]["actual"] == 1
    assert [r["strategy"] for r in svc.summary(USER)][0] == "ORB"  # most recent first
    assert trips.calls == [], "the summary reads labels only and never rebuilds a round trip"


def test_summary_can_be_limited_to_a_date_range(database):
    add_label(database, "s1", 0, date="2026-09-01", expected=("A", "Old"))
    add_label(database, "s2", 0, date="2026-10-06", expected=("A", "New"))
    assert [r["strategy"] for r in svc.summary(USER, "2026-10-01", "2026-10-31")] == ["New"]
    assert [r["strategy"] for r in svc.summary(USER, end_date="2026-09-30")] == ["Old"]
    assert [r["strategy"] for r in svc.summary(USER, start_date="2026-10-01")] == ["New"]


# ── Trades of one strategy ───────────────────────────────────────────────────

def test_list_traded_finds_expected_and_actual_matches_with_entry_and_exit(database, trips):
    add_session(database, "s1")
    add_label(database, "s1", 0, expected=("Breakout", "ORB"))
    add_label(database, "s1", 1, expected=("Trend", "Pullback"), actual=("Breakout", "ORB"))
    add_label(database, "s1", 2, expected=("Breakout", "ORB"), actual=("Breakout", "ORB"))
    add_label(database, "s1", 3, expected=("Trend", "Pullback"))
    trips.data["s1"] = [
        trip(0, [fill("BUY", 10, 100, 1000), fill("BUY", 10, 110, 1060)], [fill("SELL", 20, 120, 1500)], right="CE", strike=24500),
        trip(1, [fill("SELL", 65, 200, 2000, "PE", 24400)], [fill("BUY", 65, 190, 2400, "PE", 24400)], right="PE", strike=24400),
        trip(2, [fill("BUY", 50, 24500, 3000)], [], pnl=0.0, state="open"),
        trip(3, [fill("BUY", 1, 1, 4000)], [fill("SELL", 1, 2, 4100)]),
    ]
    result = svc.list_traded(USER, "Breakout", "ORB")
    by_index = {t["round_trip_index"]: t for t in result["trades"]}
    assert set(by_index) == {0, 1, 2}
    assert (result["total"], result["truncated"], result["unavailable"]) == (3, False, 0)
    ce = by_index[0]
    assert (ce["matched_as"], ce["right"], ce["strike"], ce["action"], ce["side"]) == ("expected", "CE", 24500, "BUY", "buy")
    assert ce["entry"] == {"time": 1000, "price": 105.0, "quantity": 20}  # volume weighted
    assert ce["exit"] == {"time": 1500, "price": 120.0, "quantity": 20}
    sold_pe = by_index[1]
    assert (sold_pe["matched_as"], sold_pe["side"], sold_pe["action"]) == ("actual", "buy", "SELL")  # a short PE is bullish
    assert sold_pe["expected"]["strategy"] == "Pullback" and sold_pe["actual"]["strategy"] == "ORB"
    assert (by_index[2]["matched_as"], by_index[2]["exit"], by_index[2]["state"]) == ("both", None, "open")


def test_list_traded_is_newest_first_limited_and_rebuilds_each_session_once(database, trips):
    for n in range(3):
        add_session(database, f"s{n}", date=f"2026-10-0{n + 1}")
        add_label(database, f"s{n}", 0, date=f"2026-10-0{n + 1}")
        add_label(database, f"s{n}", 1, date=f"2026-10-0{n + 1}")
        trips.data[f"s{n}"] = [trip(i, [fill("BUY", 1, 10, 100 + i)], [fill("SELL", 1, 11, 200 + i)]) for i in (0, 1)]
    result = svc.list_traded(USER, "Breakout", "ORB", limit=3)
    assert [(t["date"], t["round_trip_index"]) for t in result["trades"]] == [("2026-10-03", 1), ("2026-10-03", 0), ("2026-10-02", 1)]
    assert (result["total"], result["truncated"]) == (6, True)
    assert sorted(trips.calls) == ["s1", "s2"], "only the sessions of the newest labels, each rebuilt once"
    assert [t["date"] for t in svc.list_traded(USER, "Breakout", "ORB", "2026-10-02", "2026-10-02")["trades"]] == ["2026-10-02"] * 2


def test_a_session_whose_trades_cannot_be_read_is_counted_not_fatal(database, trips):
    add_session(database, "good"); add_session(database, "bad")
    add_label(database, "good", 0, date="2026-10-07"); add_label(database, "bad", 0, date="2026-10-06")
    trips.data["good"] = [trip(0, [fill("BUY", 1, 10, 100)], [fill("SELL", 1, 11, 200)])]
    trips.data["bad"] = RuntimeError
    result = svc.list_traded(USER, "Breakout", "ORB")
    assert [t["session_id"] for t in result["trades"]] == ["good"] and result["unavailable"] == 1


# ── Save as pattern marks ────────────────────────────────────────────────────

@pytest.fixture
def library(monkeypatch):
    charts = []
    monkeypatch.setattr(patterns, "register_annotation_names", lambda user_id, marks: None)

    def create_chart(**kwargs):
        chart = {**kwargs, "chart_id": f"c{len(charts)}", "can_delete": True}
        charts.append(chart)
        return chart

    def find(user_id, symbol, date, instrument_type, right=None):
        return next((c for c in charts if (c["symbol"], c["date"], c["instrument_type"]) == (symbol, date, instrument_type)), None)

    def update(chart_id, annotations, notes, **kwargs):
        next(c for c in charts if c["chart_id"] == chart_id)["annotations"] = annotations

    monkeypatch.setattr(patterns, "create_chart", create_chart)
    monkeypatch.setattr(patterns, "find_chart_by_date", find)
    monkeypatch.setattr(patterns, "update_chart", update)
    return charts


def test_save_puts_entry_and_exit_on_the_traded_instrument_on_three_minute_bars(database, trips, library):
    add_session(database, "s1")
    add_label(database, "s1", 0, expected=("Breakout", "ORB"))
    trips.data["s1"] = [trip(0, [fill("BUY", 65, 100, 1000 + 5, "CE", 24500)], [fill("SELL", 65, 130, 1500 + 7, "CE", 24500)], right="CE", strike=24500)]
    saved = svc.save_traded(USER, "s1", 0, "Breakout", "ORB")
    assert saved == {"chart_id": "c0", "merged": False, "added": 2}
    chart = library[0]
    assert (chart["symbol"], chart["date"], chart["instrument_type"], chart["right"], chart["strike"], chart["strike_pe"]) == ("NIFTY", "2026-10-06", "options", "CE", 24500, None)
    entry, exit_ = sorted(chart["annotations"], key=lambda m: m["type"])
    assert (entry["type"], entry["instrument"], entry["time"], entry["price"]) == ("entry", "CE", 1005 - 1005 % BAR, 100.0)
    assert (exit_["type"], exit_["time"], exit_["price"]) == ("exit", 1507 - 1507 % BAR, 130.0)
    assert {m["strategy_name"] for m in chart["annotations"]} == {"ORB"} and {m["category"] for m in chart["annotations"]} == {"Breakout"}


def test_a_put_is_saved_on_the_pe_leg_and_an_index_trade_on_the_underlying(database, trips, library):
    add_session(database, "s1", date="2026-10-06"); add_session(database, "s2", date="2026-10-07")
    add_label(database, "s1", 0, expected=("Breakout", "ORB")); add_label(database, "s2", 0, date="2026-10-07", actual=("Breakout", "ORB"))
    trips.data["s1"] = [trip(0, [fill("BUY", 1, 90, 1000, "PE", 24400)], [fill("SELL", 1, 95, 1100, "PE", 24400)], right="PE", strike=24400)]
    trips.data["s2"] = [trip(0, [fill("SELL", 50, 24500, 2000)], [fill("BUY", 50, 24480, 2100)])]
    svc.save_traded(USER, "s1", 0, "Breakout", "ORB")
    svc.save_traded(USER, "s2", 0, "Breakout", "ORB")
    put, index = library
    assert {m["instrument"] for m in put["annotations"]} == {"PE"} and (put["strike"], put["strike_pe"]) == (24400, 24400)
    assert index["instrument_type"] == "equity" and {m["instrument"] for m in index["annotations"]} == {"underlying"}


def test_saving_the_same_trade_twice_adds_marks_to_the_existing_chart(database, trips, library):
    add_session(database, "s1")
    add_label(database, "s1", 0); add_label(database, "s1", 1)
    trips.data["s1"] = [trip(i, [fill("BUY", 1, 10, 1000 + i * 600, "CE", 24500)], [fill("SELL", 1, 11, 1300 + i * 600, "CE", 24500)], right="CE", strike=24500) for i in (0, 1)]
    first = svc.save_traded(USER, "s1", 0, "Breakout", "ORB")
    second = svc.save_traded(USER, "s1", 1, "Breakout", "ORB")
    assert (first["merged"], second["merged"], second["added"]) == (False, True, 2)
    assert len(library) == 1 and len(library[0]["annotations"]) == 4


def test_save_refuses_a_chart_on_other_strikes_and_trades_that_are_not_the_users_or_not_labelled(database, trips, library):
    add_session(database, "s1"); add_session(database, "other", user=OTHER)
    add_label(database, "s1", 0); add_label(database, "s1", 1, expected=("Trend", "Pullback")); add_label(database, "other", 0, user=OTHER)
    trips.data["s1"] = [trip(0, [fill("BUY", 1, 10, 1000, "CE", 24500)], [fill("SELL", 1, 11, 1100, "CE", 24500)], right="CE", strike=24500),
                        trip(1, [fill("BUY", 1, 10, 2000, "CE", 24800)], [fill("SELL", 1, 11, 2100, "CE", 24800)], right="CE", strike=24800)]
    svc.save_traded(USER, "s1", 0, "Breakout", "ORB")
    with pytest.raises(ValueError, match="not labelled with that strategy"):
        svc.save_traded(USER, "s1", 1, "Breakout", "ORB")
    add_label(database, "s1", 1)  # now labelled, but the day's chart sits on 24500
    with pytest.raises(ValueError, match="different CE strike"):
        svc.save_traded(USER, "s1", 1, "Breakout", "ORB")
    with pytest.raises(LookupError):
        svc.save_traded(USER, "other", 0, "Breakout", "ORB")
    with pytest.raises(LookupError):
        svc.save_traded(USER, "missing", 0, "Breakout", "ORB")


# ── HTTP ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(database):
    app.dependency_overrides[get_request_user_id] = lambda: USER
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_request_user_id, None)


def test_the_three_routes_work_and_map_errors(client, database, trips, library):
    add_session(database, "s1")
    add_label(database, "s1", 0)
    trips.data["s1"] = [trip(0, [fill("BUY", 1, 10, 1000, "CE", 24500)], [fill("SELL", 1, 11, 1100, "CE", 24500)], right="CE", strike=24500)]
    summary = client.get("/api/pattern/traded/summary")
    assert summary.status_code == 200 and summary.json()["strategies"][0]["strategy"] == "ORB"
    listed = client.get("/api/pattern/traded", params={"category": "Breakout", "strategy": "ORB"})
    assert listed.status_code == 200 and listed.json()["trades"][0]["side"] == "buy"
    assert client.get("/api/pattern/traded", params={"category": "Breakout"}).status_code == 422
    assert client.get("/api/pattern/traded", params={"category": "Breakout", "strategy": "ORB", "limit": 500}).status_code == 422
    body = {"session_id": "s1", "round_trip_index": 0, "category": "Breakout", "strategy": "ORB"}
    saved = client.post("/api/pattern/traded/save", json=body)
    assert saved.status_code == 200 and saved.json()["added"] == 2
    assert client.post("/api/pattern/traded/save", json={**body, "strategy": "Nope"}).status_code == 400
    assert client.post("/api/pattern/traded/save", json={**body, "session_id": "missing"}).status_code == 404
