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
