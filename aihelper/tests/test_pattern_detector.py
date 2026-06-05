"""
Tests for services/pattern_detector.py — programmatic trade pattern detection.
No external dependencies; pure unit tests.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.pattern_detector import (
    group_trades,
    compute_group_pnl,
    extract_labeled_bars,
    detect_entry_deviation,
    detect_early_exit,
    detect_scared_exit,
    detect_panic_buying,
    detect_buying_on_top,
    find_trade_direction,
    aggregate_findings,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_BUY_T1 = {"trade_id": "t1", "side": "BUY", "price": 100.0, "quantity": 10, "timestamp": 1000, "commission": 0.5, "right": None, "strike": None, "expiry": None}
_SELL_T2 = {"trade_id": "t2", "side": "SELL", "price": 110.0, "quantity": 10, "timestamp": 1200, "commission": 0.5, "right": None, "strike": None, "expiry": None}
_SELL_T3 = {"trade_id": "t3", "side": "SELL", "price": 95.0, "quantity": 10, "timestamp": 1000, "commission": 0.3, "right": None, "strike": None, "expiry": None}
_BUY_T4 = {"trade_id": "t4", "side": "BUY", "price": 90.0, "quantity": 10, "timestamp": 1200, "commission": 0.3, "right": None, "strike": None, "expiry": None}

_ENTRY_BAR = {"time": 900, "open": 99.0, "high": 102.0, "low": 98.0, "close": 101.0, "label": "entry"}
_EXIT_BAR  = {"time": 1080, "open": 108.0, "high": 112.0, "low": 107.0, "close": 109.0, "label": "exit"}
_POST_BAR1 = {"time": 1260, "open": 112.0, "high": 115.0, "low": 111.0, "close": 114.0, "label": "post"}
_POST_BAR2 = {"time": 1440, "open": 113.0, "high": 116.0, "low": 112.0, "close": 115.0, "label": "post"}
_TRADE_BAR = {"time": 1080, "open": 105.0, "high": 108.0, "low": 104.0, "close": 107.0, "label": "trade"}
_PRE_BAR   = {"time": 720,  "open": 97.0,  "high": 100.0, "low": 96.0,  "close": 98.0,  "label": "pre"}


# ---------------------------------------------------------------------------
# group_trades
# ---------------------------------------------------------------------------

class TestGroupTrades:
    def test_simple_long_group(self):
        groups = group_trades([_BUY_T1, _SELL_T2])
        assert len(groups) == 1
        g = groups[0]
        assert g["direction"] == "LONG"
        assert g["first_entry"] == _BUY_T1
        assert g["last_exit"] == _SELL_T2

    def test_simple_short_group(self):
        groups = group_trades([_SELL_T3, _BUY_T4])
        assert len(groups) == 1
        g = groups[0]
        assert g["direction"] == "SHORT"
        assert g["first_entry"] == _SELL_T3
        assert g["last_exit"] == _BUY_T4

    def test_empty_trades_returns_empty(self):
        assert group_trades([]) == []

    def test_unclosed_position_included(self):
        groups = group_trades([_BUY_T1])
        assert len(groups) == 1
        assert groups[0]["last_exit"] is None

    def test_multiple_groups(self):
        sell_t5 = {**_SELL_T2, "trade_id": "t5", "timestamp": 1300}
        buy_t6 = {**_BUY_T1, "trade_id": "t6", "timestamp": 1400}
        groups = group_trades([_BUY_T1, _SELL_T2, buy_t6, sell_t5])
        assert len(groups) == 2

    def test_partial_exit_creates_one_group(self):
        sell_half = {**_SELL_T2, "quantity": 5}
        sell_rest = {**_SELL_T2, "trade_id": "t5", "quantity": 5, "timestamp": 1300}
        groups = group_trades([_BUY_T1, sell_half, sell_rest])
        assert len(groups) == 1


# ---------------------------------------------------------------------------
# compute_group_pnl
# ---------------------------------------------------------------------------

class TestComputeGroupPnl:
    def test_profitable_long(self):
        g = group_trades([_BUY_T1, _SELL_T2])[0]
        pnl = compute_group_pnl(g)
        # 110*10 - 100*10 - 1.0 = 99
        assert abs(pnl - 99.0) < 0.01

    def test_losing_long(self):
        sell_low = {**_SELL_T2, "price": 95.0}
        g = group_trades([_BUY_T1, sell_low])[0]
        pnl = compute_group_pnl(g)
        # 95*10 - 100*10 - 1.0 = -51
        assert pnl < 0


# ---------------------------------------------------------------------------
# extract_labeled_bars
# ---------------------------------------------------------------------------

class TestExtractLabeledBars:
    def test_groups_correctly(self):
        bars = [_PRE_BAR, _ENTRY_BAR, _TRADE_BAR, _EXIT_BAR, _POST_BAR1]
        labeled = extract_labeled_bars(bars)
        assert labeled["pre"] == [_PRE_BAR]
        assert labeled["entry"] == [_ENTRY_BAR]
        assert labeled["trade"] == [_TRADE_BAR]
        assert labeled["exit"] == [_EXIT_BAR]
        assert labeled["post"] == [_POST_BAR1]

    def test_empty_bars(self):
        labeled = extract_labeled_bars([])
        assert labeled["pre"] == []
        assert labeled["entry"] == []


# ---------------------------------------------------------------------------
# detect_entry_deviation
# ---------------------------------------------------------------------------

class TestDetectEntryDeviation:
    def test_chasing_long(self):
        # BUY at 103 when bar open is 99 → +4% deviation
        trade = {**_BUY_T1, "price": 103.0}
        result = detect_entry_deviation(trade, _ENTRY_BAR)
        assert result["detected"] is True
        assert result["deviation_pct"] > 0

    def test_good_long_entry(self):
        # BUY at 99 = bar open → 0% deviation
        trade = {**_BUY_T1, "price": 99.0}
        result = detect_entry_deviation(trade, _ENTRY_BAR)
        assert result["detected"] is False
        assert result["deviation_pct"] == 0.0

    def test_no_bar_data(self):
        result = detect_entry_deviation(_BUY_T1, None)
        assert result["detected"] is False

    def test_zero_open_no_crash(self):
        zero_bar = {**_ENTRY_BAR, "open": 0}
        result = detect_entry_deviation(_BUY_T1, zero_bar)
        assert result["detected"] is False

    def test_chasing_short(self):
        # SELL at 93 when bar open is 99 → below open = chasing for SHORT
        trade = {**_SELL_T3, "price": 93.0}
        bar = {**_ENTRY_BAR, "open": 99.0}
        result = detect_entry_deviation(trade, bar)
        assert result["detected"] is True


# ---------------------------------------------------------------------------
# detect_early_exit
# ---------------------------------------------------------------------------

class TestDetectEarlyExit:
    def test_early_exit_long(self):
        # Exit bar close=109, post bars go up → early exit
        result = detect_early_exit(_EXIT_BAR, [_POST_BAR1], "LONG")
        assert result["detected"] is True
        assert result["move_pct"] > 0

    def test_no_early_exit_long(self):
        # Post bar close < exit bar close
        down_bar = {**_POST_BAR1, "close": 105.0}
        result = detect_early_exit(_EXIT_BAR, [down_bar], "LONG")
        assert result["detected"] is False

    def test_early_exit_short(self):
        # Short exit close=109, post bars go DOWN → early exit
        down_bar1 = {**_POST_BAR1, "close": 100.0}
        result = detect_early_exit(_EXIT_BAR, [down_bar1], "SHORT")
        assert result["detected"] is True

    def test_no_post_bars(self):
        result = detect_early_exit(_EXIT_BAR, [], "LONG")
        assert result["detected"] is False

    def test_no_exit_bar(self):
        result = detect_early_exit(None, [_POST_BAR1], "LONG")
        assert result["detected"] is False


# ---------------------------------------------------------------------------
# detect_scared_exit
# ---------------------------------------------------------------------------

class TestDetectScaredExit:
    def test_profitable_not_scared(self):
        result = detect_scared_exit(50.0, _EXIT_BAR, [_POST_BAR1], "LONG")
        assert result["detected"] is False

    def test_scared_long_exit(self):
        # Lost money on LONG (pnl=-20), next bar goes UP → scared
        result = detect_scared_exit(-20.0, _EXIT_BAR, [_POST_BAR1], "LONG")
        # _POST_BAR1 close=114 > _EXIT_BAR close=109 → reversal
        assert result["detected"] is True

    def test_valid_stop_loss(self):
        # Lost money, but price continues DOWN → valid stop
        down_bar = {**_POST_BAR1, "close": 105.0}
        result = detect_scared_exit(-20.0, _EXIT_BAR, [down_bar], "LONG")
        assert result["detected"] is False

    def test_no_post_bars(self):
        result = detect_scared_exit(-20.0, _EXIT_BAR, [], "LONG")
        assert result["detected"] is False


# ---------------------------------------------------------------------------
# detect_panic_buying
# ---------------------------------------------------------------------------

class TestDetectPanicBuying:
    def test_quick_re_entry(self):
        t1 = {**_BUY_T1, "timestamp": 1000}
        t2 = {**_BUY_T1, "trade_id": "t2b", "timestamp": 1020}  # 20s apart
        result = detect_panic_buying([t1, t2, _SELL_T2], "LONG")
        assert result["detected"] is True
        assert result["quick_entries"] >= 1

    def test_normal_spacing(self):
        t1 = {**_BUY_T1, "timestamp": 1000}
        t2 = {**_BUY_T1, "trade_id": "t2b", "timestamp": 1500}  # 500s apart
        result = detect_panic_buying([t1, t2, _SELL_T2], "LONG")
        assert result["quick_entries"] == 0

    def test_same_bar_reversal(self):
        # BUY, SELL, BUY all in same 3-min window (same bar_time)
        bt = (1000 // 180) * 180
        t_buy1  = {**_BUY_T1, "timestamp": bt + 10}
        t_sell  = {**_SELL_T2, "timestamp": bt + 50}
        t_buy2  = {**_BUY_T1, "trade_id": "t5", "timestamp": bt + 100}
        result = detect_panic_buying([t_buy1, t_sell, t_buy2], "LONG")
        assert result["same_bar_reversals"] >= 1


# ---------------------------------------------------------------------------
# detect_buying_on_top
# ---------------------------------------------------------------------------

class TestDetectBuyingOnTop:
    def test_long_reversal_detected(self):
        # Entry bar close=101, next bar closes at 98 → reversal
        next_bar = {**_TRADE_BAR, "close": 98.0}
        result = detect_buying_on_top(_ENTRY_BAR, [next_bar], "LONG")
        assert result["detected"] is True

    def test_long_no_reversal(self):
        # Entry bar close=101, next bar closes at 105 → no reversal
        next_bar = {**_TRADE_BAR, "close": 105.0}
        result = detect_buying_on_top(_ENTRY_BAR, [next_bar], "LONG")
        assert result["detected"] is False

    def test_short_reversal_detected(self):
        # Entry bar close=101, next bar close=108 → price went up = reversal for short
        next_bar = {**_TRADE_BAR, "close": 108.0}
        result = detect_buying_on_top(_ENTRY_BAR, [next_bar], "SHORT")
        assert result["detected"] is True

    def test_no_bars_after_entry(self):
        result = detect_buying_on_top(_ENTRY_BAR, [], "LONG")
        assert result["detected"] is False

    def test_no_entry_bar(self):
        result = detect_buying_on_top(None, [_TRADE_BAR], "LONG")
        assert result["detected"] is False


# ---------------------------------------------------------------------------
# find_trade_direction
# ---------------------------------------------------------------------------

class TestFindTradeDirection:
    def test_buy_first_is_long(self):
        assert find_trade_direction([_BUY_T1, _SELL_T2]) == "LONG"

    def test_sell_first_is_short(self):
        assert find_trade_direction([_SELL_T3, _BUY_T4]) == "SHORT"

    def test_empty_defaults_to_long(self):
        assert find_trade_direction([]) == "LONG"

    def test_picks_earliest_by_timestamp(self):
        # BUY at ts=2000, SELL at ts=500 — SELL is first
        late_buy = {**_BUY_T1, "timestamp": 2000}
        early_sell = {**_SELL_T3, "timestamp": 500}
        assert find_trade_direction([late_buy, early_sell]) == "SHORT"


# ---------------------------------------------------------------------------
# aggregate_findings
# ---------------------------------------------------------------------------

class TestAggregateFindings:
    def _make_group(
        self,
        detected_map: dict,
        pnl: float = 10.0,
        has_ohlc: bool = True,
        group_id: str = "g1",
        entry_time: int = 1700100000,
        exit_time: int = 1700101800,
        symbol: str = "NIFTY",
    ) -> dict:
        patterns: dict = {
            "panic_buying": {"detected": detected_map.get("panic_buying", False), "quick_entries": detected_map.get("quick_entries", 0), "same_bar_reversals": 0},
        }
        if has_ohlc:
            patterns.update({
                "entry_deviation": {"detected": detected_map.get("entry_deviation", False), "deviation_pct": 1.5},
                "early_exit": {"detected": detected_map.get("early_exit", False), "move_pct": 0.5},
                "scared_exit": {"detected": detected_map.get("scared_exit", False), "pnl": pnl},
                "buying_on_top": {"detected": detected_map.get("buying_on_top", False), "move_pct": 0.8},
            })
        return {
            "group_id": group_id,
            "direction": "LONG",
            "pnl": pnl,
            "has_ohlc": has_ohlc,
            "has_exit": True,
            "entry_time": entry_time,
            "exit_time": exit_time,
            "symbol": symbol,
            "patterns": patterns,
        }

    def test_counts_detections(self):
        g1 = self._make_group({"entry_deviation": True, "buying_on_top": True})
        g2 = self._make_group({"entry_deviation": False})
        result = aggregate_findings([g1, g2])
        assert result["entry_deviation"]["chasing_count"] == 1
        assert result["buying_on_top"]["count"] == 1

    def test_total_and_ohlc_counts(self):
        g1 = self._make_group({}, has_ohlc=True)
        g2 = self._make_group({}, has_ohlc=False)
        result = aggregate_findings([g1, g2])
        assert result["total_trade_groups"] == 2
        assert result["groups_with_ohlc_data"] == 1

    def test_win_loss_counts(self):
        g_win = self._make_group({}, pnl=50.0)
        g_loss = self._make_group({}, pnl=-30.0)
        result = aggregate_findings([g_win, g_loss])
        assert result["win_count"] == 1
        assert result["loss_count"] == 1

    def test_empty_findings(self):
        result = aggregate_findings([])
        assert result["total_trade_groups"] == 0
        assert result["win_count"] == 0

    def test_scared_exits_instances(self):
        g1 = self._make_group({"scared_exit": True}, pnl=-100.0, group_id="s1")
        g2 = self._make_group({"scared_exit": True}, pnl=-50.0, group_id="s2")
        g3 = self._make_group({"scared_exit": False}, pnl=-20.0, group_id="s3")
        result = aggregate_findings([g1, g2, g3])
        instances = result["scared_exits"]["instances"]
        assert len(instances) == 2
        assert all(i["detected"] is True for i in instances)
        assert all("entry_time" in i and "exit_time" in i and "symbol" in i for i in instances)
        assert all("detail" in i for i in instances)
        assert {i["group_id"] for i in instances} == {"s1", "s2"}

    def test_early_exits_instances(self):
        g1 = self._make_group({"early_exit": True}, pnl=30.0, group_id="e1")
        g2 = self._make_group({"early_exit": False}, pnl=20.0, group_id="e2")
        result = aggregate_findings([g1, g2])
        instances = result["early_exits"]["instances"]
        assert len(instances) == 1
        assert instances[0]["group_id"] == "e1"
        assert "missed after exit" in instances[0]["detail"]

    def test_buying_on_top_instances(self):
        g1 = self._make_group({"buying_on_top": True}, group_id="b1")
        result = aggregate_findings([g1])
        instances = result["buying_on_top"]["instances"]
        assert len(instances) == 1
        assert "adverse next bar" in instances[0]["detail"]

    def test_panic_entries_instances(self):
        g1 = self._make_group({"panic_buying": True, "quick_entries": 2}, group_id="p1")
        result = aggregate_findings([g1])
        instances = result["panic_entries"]["instances"]
        assert len(instances) == 1
        assert "quick re-entr" in instances[0]["detail"]

    def test_instances_cap_at_10(self):
        groups = [
            self._make_group({"scared_exit": True}, pnl=-10.0, group_id=f"g{i}")
            for i in range(15)
        ]
        result = aggregate_findings(groups)
        assert len(result["scared_exits"]["instances"]) == 10

    def test_entry_deviation_instances_include_new_fields(self):
        g = self._make_group({"entry_deviation": True}, group_id="d1", symbol="BANKNIFTY")
        result = aggregate_findings([g])
        inst = result["entry_deviation"]["instances"][0]
        assert inst["symbol"] == "BANKNIFTY"
        assert "entry_time" in inst
        assert "exit_time" in inst
        assert "detail" in inst
        assert "pct" in inst
