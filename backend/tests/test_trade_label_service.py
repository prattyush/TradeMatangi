from app.services.trade_label_service import compute_round_trip_state


def _trade(trade_id: str, timestamp: int, side: str, strike: int, price: float):
    return {
        "trade_id": trade_id,
        "timestamp": timestamp,
        "side": side,
        "quantity": 65,
        "price": price,
        "commission": 1,
        "right": "CE",
        "strike": strike,
        "expiry": "2026-05-07",
    }


def test_round_trip_label_identity_keeps_same_right_strikes_separate():
    completed, open_trips = compute_round_trip_state([
        _trade("entry-24000", 1, "BUY", 24000, 100),
        _trade("entry-24100", 2, "BUY", 24100, 150),
        _trade("exit-24100", 3, "SELL", 24100, 160),
    ])

    assert len(completed) == 1
    assert completed[0]["index"] == 1
    assert completed[0]["strike"] == 24100
    assert completed[0]["pnl"] == 648
    assert len(open_trips) == 1
    assert open_trips[0]["index"] == 0
    assert open_trips[0]["strike"] == 24000


def test_round_trip_reports_pnl_pct_and_peak_capital_pct():
    """3 entries, 1 exit, 1 more entry, then exit all: the peak is the most capital in use at once (30 lots), not the 40 bought."""
    from app.services.trade_label_service import compute_round_trip_state

    session = dict(session_id="s", symbol="TEST", session_capital=100000, session_type="sim")

    def fill(i, side, qty, price):
        return dict(trade_id=str(i), side=side, quantity=qty, price=price, timestamp=i, commission=0)

    trades = [
        fill(1, "BUY", 10, 100), fill(2, "BUY", 10, 100), fill(3, "BUY", 10, 100),
        fill(4, "SELL", 10, 110),
        fill(5, "BUY", 10, 100),
        fill(6, "SELL", 30, 120),
    ]
    closed, opened = compute_round_trip_state(trades, session)
    assert opened == [] and len(closed) == 1
    trip = closed[0]
    # 10*(110-100) + 30*(120-100) = 700; peak 30 lots at 100 = 3000 of 100000 capital
    assert trip["pnl"] == 700.0
    assert trip["pnl_pct"] == 0.7
    assert trip["max_capital_pct"] == 3.0


def test_round_trip_peak_capital_pct_is_none_without_capital():
    from app.services.trade_label_service import compute_round_trip_state

    session = dict(session_id="s", symbol="TEST", session_capital=0, session_type="sim")
    rows = [dict(trade_id="1", side="BUY", quantity=1, price=10, timestamp=1, commission=0),
            dict(trade_id="2", side="SELL", quantity=1, price=11, timestamp=2, commission=0)]
    trip = compute_round_trip_state(rows, session)[0][0]
    assert trip["pnl_pct"] is None and trip["max_capital_pct"] is None
