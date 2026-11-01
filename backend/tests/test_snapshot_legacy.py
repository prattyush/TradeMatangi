import copy
from app.services import snapshot_legacy as legacy


def _pos(side="FLAT", qty=0, avg=0.0):
    return {"side": side, "quantity": qty, "avg_entry_price": avg, "pnl": 0, "pnl_pct": 0}


def _trade(tid, side, price, qty, right="CE", strike=24600, commission=None):
    t = {"trade_id": tid, "side": side, "price": price, "quantity": qty, "right": right, "strike": strike, "timestamp": 1}
    if commission is not None:
        t["commission"] = commission
    return t


def _snap(desc, etype, trades, *, ce=None, price_ce=50.0, sess=0.0, open_orders=None, details=None, ts=100, ets=1, event_id=None, extra=None):
    snapshot = {
        "current_price": 24000.0, "current_price_ce": price_ce, "current_price_pe": 40.0,
        "position": _pos(), "position_ce": ce or _pos(), "position_pe": _pos(),
        "combined_pnl": 0, "combined_pnl_pct": 0, "session_pnl": sess, "session_pnl_pct": 0,
        "wallet_balance": 100000, "session_capital": 100000, "wallet_used_pct": 0, "active_positions": 0,
        "open_orders": open_orders or [], "filled_trades": trades, "event_timestamp": ets,
        "strike_ce": 24600, "strike_pe": 24250,
    }
    snapshot.update(extra or {})
    return {"event_id": event_id or desc, "session_id": "s", "instrument_type": "options", "timestamp": ts,
            "event": {"type": etype, "description": desc, "details": details or {}}, "snapshot": snapshot}


def _fill(side, price, qty, right="CE"):
    return {"side": side, "filled_price": price, "quantity": qty, "right": right}


COMMISSIONS = {"b1": 2.0, "s1": 3.0, "b2": 1.0, "s2": 1.0}


def correct(items):
    return legacy.correct("s", items, commissions=lambda _sid: COMMISSIONS)


def test_buy_fill_shows_its_own_position_funds_and_pnl():
    b1 = _trade("b1", "BUY", 40.0, 100)
    items = [
        _snap("buy filled", legacy.FILL_EVENT, [], price_ce=42.0, details=_fill("BUY", 40.0, 100), open_orders=[{"order_id": "b1", "status": "PENDING"}]),
        _snap("next", "order_placed", [b1], ce=_pos("LONG", 100, 40.0), ts=101),
    ]
    fixed = correct(items)[0]["snapshot"]
    assert fixed["position_ce"]["side"] == "LONG" and fixed["position_ce"]["quantity"] == 100
    assert fixed["position_ce"]["pnl"] == 200            # (42 - 40) * 100, gross
    assert fixed["combined_pnl"] == 200 and fixed["wallet_balance"] == 100200
    assert fixed["wallet_used_pct"] == 4.0               # 4000 / 100000
    assert fixed["session_pnl"] == 198.0                 # 200 minus 2.0 commission
    assert fixed["open_orders"] == [] and len(fixed["filled_trades"]) == 1
    assert fixed["active_positions"] == 1 and fixed["legacy_corrected"] is True
    assert items[0]["snapshot"]["position_ce"]["side"] == "FLAT"  # input not mutated


def test_closing_fill_realises_pnl_and_goes_flat():
    b1, s1 = _trade("b1", "BUY", 40.0, 100), _trade("s1", "SELL", 45.0, 100)
    items = [
        _snap("sell filled", legacy.FILL_EVENT, [b1], ce=_pos("LONG", 100, 40.0), price_ce=44.0, sess=398.0,
              details=_fill("SELL", 45.0, 100)),
        _snap("next", "order_placed", [b1, s1], ts=101),
    ]
    fixed = correct(items)[0]["snapshot"]
    assert fixed["position_ce"]["side"] == "FLAT" and fixed["combined_pnl"] == 0
    assert fixed["session_pnl"] == 495.0                 # 500 realised - 2.0 - 3.0
    assert fixed["wallet_balance"] == 100000 and fixed["wallet_used_pct"] == 0


def test_partial_close_keeps_remaining_lot_at_original_average():
    b1, s1 = _trade("b1", "BUY", 40.0, 100), _trade("s1", "SELL", 50.0, 40)
    items = [
        _snap("partial", legacy.FILL_EVENT, [b1], ce=_pos("LONG", 100, 40.0), price_ce=50.0, sess=998.0, details=_fill("SELL", 50.0, 40)),
        _snap("next", "order_placed", [b1, s1], ts=101),
    ]
    fixed = correct(items)[0]["snapshot"]
    assert (fixed["position_ce"]["quantity"], fixed["position_ce"]["avg_entry_price"]) == (60, 40.0)
    assert fixed["position_ce"]["pnl"] == 600


def test_last_event_falls_back_to_event_details():
    items = [_snap("buy filled", legacy.FILL_EVENT, [], price_ce=40.0, details=_fill("BUY", 40.0, 100))]
    fixed = correct(items)[0]["snapshot"]
    assert fixed["position_ce"]["quantity"] == 100 and len(fixed["filled_trades"]) == 1


def test_already_applied_fill_is_not_double_counted():
    b1 = _trade("b1", "BUY", 40.0, 100)
    items = [_snap("buy filled", legacy.FILL_EVENT, [b1], ce=_pos("LONG", 100, 40.0), details=_fill("BUY", 40.0, 100))]
    assert correct(items) == items


def test_new_captures_and_desktop_snapshots_are_untouched():
    for extra in ({"capture_v": 2}, {"positions_by_contract": {}}):
        items = [_snap("buy filled", legacy.FILL_EVENT, [], details=_fill("BUY", 40.0, 100), extra=extra)]
        assert correct(items) == items


def test_failure_returns_stored_snapshots():
    items = [_snap("buy filled", legacy.FILL_EVENT, [], details=_fill("BUY", 40.0, 100))]
    def boom(_sid):
        raise RuntimeError("down")
    assert legacy.correct("s", items, commissions=boom) == items


def test_sort_puts_placement_before_its_fill_at_the_same_tick():
    fill = _snap("fill", legacy.FILL_EVENT, [], ts=100, ets=5, event_id="a")
    placed = _snap("placed", "order_placed", [], ts=100, ets=5, event_id="z")
    later = _snap("later", "order_placed", [], ts=100, ets=6, event_id="0")
    ordered = sorted([fill, later, placed], key=legacy.sort_key)
    assert [i["event"]["description"] for i in ordered] == ["placed", "fill", "later"]
    seq_a, seq_b = copy.deepcopy(placed), copy.deepcopy(placed)
    seq_a["snapshot"]["seq"], seq_b["snapshot"]["seq"] = 2, 1
    assert sorted([seq_a, seq_b], key=legacy.sort_key)[0] is seq_b


def test_summarize_positions_matches_website_definitions():
    legs = [{"side": "LONG", "quantity": 100, "avg_entry_price": 40.0, "pnl": 200.0}, {"side": "FLAT", "quantity": 0, "avg_entry_price": 0, "pnl": 0}]
    out = legacy.summarize_positions(100000, legs)
    assert out == {"combined_pnl": 200.0, "combined_pnl_pct": 5.0, "wallet_balance": 100200.0, "wallet_used_pct": 4.0, "active_positions": 1}
    flat = legacy.summarize_positions(100000, [])
    assert flat["combined_pnl"] == 0 and flat["wallet_balance"] == 100000 and flat["wallet_used_pct"] == 0


def test_desktop_snapshot_is_pinned_to_the_fill_and_its_stream_cursor():
    from app.routers import desktop_trading as dt
    event = {"type": "order_filled", "details": {"filled_at": 900, "event_id": 42}}
    assert dt._snapshot_moment(event, 1000) == (900, 42)
    assert dt._snapshot_moment({"details": {"filled_at": 2000, "event_id": 7}}, 1000) == (1000, 7)  # never later than the clock
    assert dt._snapshot_moment({"details": {"event_id": "x"}}, 1000) == (1000, 0)
    assert dt._snapshot_moment({}, 1000) == (1000, 0)


def test_desktop_summary_reports_used_pnl_and_trades(monkeypatch):
    from types import SimpleNamespace
    from app.routers import desktop_trading as dt
    session = SimpleNamespace(session_id="s", session_capital=100000)
    position = SimpleNamespace(side="LONG", quantity=100, avg_entry_price=40.0)
    trade = SimpleNamespace(model_dump=lambda mode="json": {"trade_id": "b1", "side": "BUY", "price": 40.0, "quantity": 100, "commission": 2.0, "extra": 1})
    monkeypatch.setattr(dt, "_position_targets", lambda s: [{"right": "CE", "strike": 24600, "expiry": "e"}])
    monkeypatch.setattr(dt, "_position_for", lambda s, r, k=None, e=None: position)
    monkeypatch.setattr(dt, "_last_price_for_right", lambda s, r, k=None, e=None: 42.0)
    monkeypatch.setattr(dt.trading_service, "get_trades", lambda sid: [trade])
    out = dt._snapshot_summary(session, SimpleNamespace(wallet_balance=95000.0))
    assert out["combined_pnl"] == 200.0 and out["wallet_used_pct"] == 4.0 and out["wallet_balance"] == 100200.0
    assert out["cash_balance"] == 95000.0 and out["active_positions"] == 1
    assert out["filled_trades"] == [{"trade_id": "b1", "side": "BUY", "price": 40.0, "quantity": 100, "commission": 2.0}]
