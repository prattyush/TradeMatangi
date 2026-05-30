import pytest
from app.services import trading as svc
from app.models.schemas import TradeSide


SESSION = "test-session-001"


@pytest.fixture(autouse=True)
def clean_session():
    svc.clear_session(SESSION)
    yield
    svc.clear_session(SESSION)


class TestRecordTrade:
    def test_buy_creates_trade(self):
        trade = svc.record_trade(SESSION, TradeSide.BUY, price=24200.0, timestamp=1000)
        assert trade.side == TradeSide.BUY
        assert trade.price == 24200.0
        assert trade.quantity == 1
        assert trade.session_id == SESSION

    def test_sell_creates_trade(self):
        trade = svc.record_trade(SESSION, TradeSide.SELL, price=24250.0, timestamp=2000)
        assert trade.side == TradeSide.SELL

    def test_trade_id_is_unique(self):
        t1 = svc.record_trade(SESSION, TradeSide.BUY, price=100.0, timestamp=1)
        t2 = svc.record_trade(SESSION, TradeSide.BUY, price=100.0, timestamp=2)
        assert t1.trade_id != t2.trade_id

    def test_trades_accumulate(self):
        svc.record_trade(SESSION, TradeSide.BUY, price=100.0, timestamp=1)
        svc.record_trade(SESSION, TradeSide.BUY, price=100.0, timestamp=2)
        assert len(svc.get_trades(SESSION)) == 2


class TestGetPosition:
    def test_flat_when_no_trades(self):
        pos = svc.get_position(SESSION)
        assert pos.side == "FLAT"
        assert pos.quantity == 0

    def test_long_after_buy(self):
        svc.record_trade(SESSION, TradeSide.BUY, price=24200.0, timestamp=1)
        pos = svc.get_position(SESSION)
        assert pos.side == "LONG"
        assert pos.quantity == 1
        assert pos.avg_entry_price == pytest.approx(24200.0)

    def test_flat_after_buy_and_sell(self):
        svc.record_trade(SESSION, TradeSide.BUY, price=24200.0, timestamp=1)
        svc.record_trade(SESSION, TradeSide.SELL, price=24300.0, timestamp=2)
        pos = svc.get_position(SESSION)
        assert pos.side == "FLAT"
        assert pos.quantity == 0

    def test_short_after_sell(self):
        svc.record_trade(SESSION, TradeSide.SELL, price=24200.0, timestamp=1)
        pos = svc.get_position(SESSION)
        assert pos.side == "SHORT"
        assert pos.quantity == 1

    def test_avg_entry_price_multiple_buys(self):
        svc.record_trade(SESSION, TradeSide.BUY, price=100.0, timestamp=1)
        svc.record_trade(SESSION, TradeSide.BUY, price=200.0, timestamp=2)
        pos = svc.get_position(SESSION)
        assert pos.avg_entry_price == pytest.approx(150.0)

    def test_avg_entry_reflects_only_open_lots_after_close_and_reopen(self):
        # Close a trade then re-enter — avg must be the new entry only, not diluted by old lots
        svc.record_trade(SESSION, TradeSide.BUY, price=100.0, timestamp=1)
        svc.record_trade(SESSION, TradeSide.SELL, price=90.0, timestamp=2)   # closed at loss
        svc.record_trade(SESSION, TradeSide.BUY, price=85.0, timestamp=3)   # new entry
        pos = svc.get_position(SESSION)
        assert pos.side == "LONG"
        assert pos.quantity == 1
        assert pos.avg_entry_price == pytest.approx(85.0)  # NOT (100+85)/2 = 92.5

    def test_avg_entry_pyramid_add_to_position(self):
        # Adding to a winning position — avg must be weighted across open lots only
        svc.record_trade(SESSION, TradeSide.BUY, price=100.0, timestamp=1, quantity=2)
        svc.record_trade(SESSION, TradeSide.BUY, price=80.0, timestamp=2, quantity=2)
        pos = svc.get_position(SESSION)
        assert pos.quantity == 4
        assert pos.avg_entry_price == pytest.approx(90.0)  # (100*2 + 80*2) / 4

    def test_avg_entry_partial_close_then_add(self):
        # Buy 2, sell 1 (partial close), buy 1 more — open lots are remaining 1@100 + 1@95
        svc.record_trade(SESSION, TradeSide.BUY, price=100.0, timestamp=1, quantity=2)
        svc.record_trade(SESSION, TradeSide.SELL, price=110.0, timestamp=2, quantity=1)
        svc.record_trade(SESSION, TradeSide.BUY, price=95.0, timestamp=3, quantity=1)
        pos = svc.get_position(SESSION)
        assert pos.quantity == 2
        assert pos.avg_entry_price == pytest.approx(97.5)  # (100 + 95) / 2


class TestClearSession:
    def test_clear_removes_trades(self):
        svc.record_trade(SESSION, TradeSide.BUY, price=100.0, timestamp=1)
        svc.clear_session(SESSION)
        assert svc.get_trades(SESSION) == []
