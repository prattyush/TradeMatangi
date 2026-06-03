"""
Live market pattern detection — purely programmatic, no I/O.

All detect_* functions accept a list of bar dicts (oldest → newest) with keys:
  time (ISO str), open (float), high (float), low (float), close (float)

Returns PatternResult with detected=True when the pattern is confirmed.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Sequence


@dataclass
class PatternResult:
    detected: bool
    pattern: str           # snake_case key used as cooldown key
    title: str             # human-readable title
    category: str          # "trend" | "reversal" | "range" | "ema" | "level" | "behavioral"
    severity: str          # "info" | "warning" | "critical"
    description: str       # one-sentence explanation
    trade_suggestion: str | None = None

    def __bool__(self) -> bool:
        return self.detected


# ── Helpers ───────────────────────────────────────────────────────────────────

def _c(bar: dict) -> float:
    return float(bar["close"])

def _o(bar: dict) -> float:
    return float(bar["open"])

def _h(bar: dict) -> float:
    return float(bar["high"])

def _l(bar: dict) -> float:
    return float(bar["low"])

def _is_bull(bar: dict) -> bool:
    return float(bar["close"]) >= float(bar["open"])

def _is_bear(bar: dict) -> bool:
    return float(bar["close"]) < float(bar["open"])

def _bar_time_of_day_secs(bar: dict) -> int:
    """Seconds from midnight UTC (= IST wall-clock via the IST-as-UTC encoding)."""
    try:
        dt = datetime.fromisoformat(str(bar["time"]))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.hour * 3600 + dt.minute * 60 + dt.second
    except Exception:
        return 0

def _ema(closes: list[float], period: int) -> list[float]:
    """Exponential Moving Average; returns empty list if insufficient data."""
    if len(closes) < period:
        return []
    k = 2.0 / (period + 1)
    result = [sum(closes[:period]) / period]
    for c in closes[period:]:
        result.append(c * k + result[-1] * (1 - k))
    return result

def _no(pattern: str, title: str, category: str) -> PatternResult:
    return PatternResult(False, pattern, title, category, "info", "")


# ── Market pattern detectors ──────────────────────────────────────────────────

def detect_strong_bull_trend(bars: Sequence[dict]) -> PatternResult:
    """6 consecutive bars with higher closes and higher lows."""
    n = 6
    if len(bars) < n:
        return _no("strong_bull_trend", "Strong Bull Trend", "trend")
    tail = list(bars[-n:])
    higher_closes = sum(1 for i in range(1, n) if _c(tail[i]) > _c(tail[i - 1]))
    higher_lows = sum(1 for i in range(1, n) if _l(tail[i]) >= _l(tail[i - 1]))
    bull_bars = sum(1 for b in tail if _is_bull(b))
    if higher_closes >= 4 and higher_lows >= 4 and bull_bars >= 4:
        return PatternResult(
            True, "strong_bull_trend", "Strong Bull Trend", "trend", "info",
            f"{higher_closes} of {n - 1} higher closes with rising lows",
            "Consider CE entries on any minor pullback; trail stops under each new low.",
        )
    return _no("strong_bull_trend", "Strong Bull Trend", "trend")


def detect_strong_bear_trend(bars: Sequence[dict]) -> PatternResult:
    """6 consecutive bars with lower closes and lower highs."""
    n = 6
    if len(bars) < n:
        return _no("strong_bear_trend", "Strong Bear Trend", "trend")
    tail = list(bars[-n:])
    lower_closes = sum(1 for i in range(1, n) if _c(tail[i]) < _c(tail[i - 1]))
    lower_highs = sum(1 for i in range(1, n) if _h(tail[i]) <= _h(tail[i - 1]))
    bear_bars = sum(1 for b in tail if _is_bear(b))
    if lower_closes >= 4 and lower_highs >= 4 and bear_bars >= 4:
        return PatternResult(
            True, "strong_bear_trend", "Strong Bear Trend", "trend", "info",
            f"{lower_closes} of {n - 1} lower closes with falling highs",
            "Consider PE entries on any minor bounce; trail stops above each new high.",
        )
    return _no("strong_bear_trend", "Strong Bear Trend", "trend")


def detect_trading_range(bars: Sequence[dict]) -> PatternResult:
    """10 bars oscillating within a narrow band (< 0.8% of median close)."""
    n = 10
    if len(bars) < n:
        return _no("trading_range", "Trading Range", "range")
    tail = list(bars[-n:])
    max_high = max(_h(b) for b in tail)
    min_low = min(_l(b) for b in tail)
    med_close = statistics.median(_c(b) for b in tail)
    if med_close <= 0:
        return _no("trading_range", "Trading Range", "range")
    range_pct = (max_high - min_low) / med_close * 100
    # Count direction changes in closes (oscillation check)
    closes = [_c(b) for b in tail]
    changes = [1 if closes[i] > closes[i - 1] else -1 for i in range(1, len(closes))]
    direction_flips = sum(1 for i in range(1, len(changes)) if changes[i] != changes[i - 1])
    if range_pct <= 1.0 and direction_flips >= 3:
        return PatternResult(
            True, "trading_range", "Trading Range", "range", "info",
            f"Price confined to {range_pct:.2f}% band ({min_low:.0f}–{max_high:.0f})",
            f"Range trades: buy near {min_low:.0f} support, sell near {max_high:.0f} resistance.",
        )
    return _no("trading_range", "Trading Range", "range")


def detect_bull_trend_reversal(bars: Sequence[dict]) -> PatternResult:
    """Prior 5-bar bull sequence followed by 2 consecutive bear closes."""
    if len(bars) < 7:
        return _no("bull_trend_reversal", "Bull Trend Reversal", "reversal")
    prior = list(bars[-7:-2])
    recent = list(bars[-2:])
    # Prior: at least 3 of 4 close-to-close moves up
    prior_up = sum(1 for i in range(1, len(prior)) if _c(prior[i]) > _c(prior[i - 1]))
    if prior_up < 3:
        return _no("bull_trend_reversal", "Bull Trend Reversal", "reversal")
    # Recent 2 bars: both bear bars with lower closes
    both_bear = _is_bear(recent[0]) and _is_bear(recent[1])
    lower_close = _c(recent[1]) < _c(recent[0])
    if both_bear and lower_close:
        return PatternResult(
            True, "bull_trend_reversal", "Bull Trend Reversal", "reversal", "warning",
            "Bull trend weakening — 2 consecutive bear bars after uptrend",
            "Watch for exit / short opportunity; CE holders consider tightening stops.",
        )
    return _no("bull_trend_reversal", "Bull Trend Reversal", "reversal")


def detect_bear_trend_reversal(bars: Sequence[dict]) -> PatternResult:
    """Prior 5-bar bear sequence followed by 2 consecutive bull closes."""
    if len(bars) < 7:
        return _no("bear_trend_reversal", "Bear Trend Reversal", "reversal")
    prior = list(bars[-7:-2])
    recent = list(bars[-2:])
    prior_down = sum(1 for i in range(1, len(prior)) if _c(prior[i]) < _c(prior[i - 1]))
    if prior_down < 3:
        return _no("bear_trend_reversal", "Bear Trend Reversal", "reversal")
    both_bull = _is_bull(recent[0]) and _is_bull(recent[1])
    higher_close = _c(recent[1]) > _c(recent[0])
    if both_bull and higher_close:
        return PatternResult(
            True, "bear_trend_reversal", "Bear Trend Reversal", "reversal", "warning",
            "Bear trend weakening — 2 consecutive bull bars after downtrend",
            "Watch for exit / long opportunity; PE holders consider tightening stops.",
        )
    return _no("bear_trend_reversal", "Bear Trend Reversal", "reversal")


def _is_in_range(bars: Sequence[dict]) -> tuple[bool, float, float]:
    """Check if bars form a trading range; return (in_range, range_low, range_high)."""
    if len(bars) < 6:
        return False, 0.0, 0.0
    max_high = max(_h(b) for b in bars)
    min_low = min(_l(b) for b in bars)
    med_close = statistics.median(_c(b) for b in bars)
    if med_close <= 0:
        return False, 0.0, 0.0
    range_pct = (max_high - min_low) / med_close * 100
    closes = [_c(b) for b in bars]
    changes = [1 if closes[i] > closes[i - 1] else -1 for i in range(1, len(closes))]
    flips = sum(1 for i in range(1, len(changes)) if changes[i] != changes[i - 1])
    return range_pct <= 1.1 and flips >= 2, min_low, max_high


def detect_range_breakout_bull(bars: Sequence[dict]) -> PatternResult:
    """Prior 10 bars in range, last bar closes decisively above range high."""
    if len(bars) < 11:
        return _no("range_breakout_bull", "Range Breakout (Bull)", "range")
    in_range, rng_low, rng_high = _is_in_range(bars[-11:-1])
    if not in_range:
        return _no("range_breakout_bull", "Range Breakout (Bull)", "range")
    last_close = _c(bars[-1])
    if rng_high > 0 and last_close > rng_high * 1.003:
        pct = (last_close - rng_high) / rng_high * 100
        return PatternResult(
            True, "range_breakout_bull", "Range Breakout (Bull)", "range", "warning",
            f"Price broke above {rng_high:.0f} range top by {pct:.2f}%",
            "Breakout buying opportunity — consider CE entries with stop below range high.",
        )
    return _no("range_breakout_bull", "Range Breakout (Bull)", "range")


def detect_range_breakout_bear(bars: Sequence[dict]) -> PatternResult:
    """Prior 10 bars in range, last bar closes decisively below range low."""
    if len(bars) < 11:
        return _no("range_breakout_bear", "Range Breakout (Bear)", "range")
    in_range, rng_low, rng_high = _is_in_range(bars[-11:-1])
    if not in_range:
        return _no("range_breakout_bear", "Range Breakout (Bear)", "range")
    last_close = _c(bars[-1])
    if rng_low > 0 and last_close < rng_low * 0.997:
        pct = (rng_low - last_close) / rng_low * 100
        return PatternResult(
            True, "range_breakout_bear", "Range Breakout (Bear)", "range", "warning",
            f"Price broke below {rng_low:.0f} range bottom by {pct:.2f}%",
            "Breakdown opportunity — consider PE entries with stop above range low.",
        )
    return _no("range_breakout_bear", "Range Breakout (Bear)", "range")


def detect_opening_reversal(bars: Sequence[dict]) -> PatternResult:
    """
    First 35 minutes (09:15–09:50 IST): price moves one way then reverses.
    Fires only during the opening window.
    """
    if len(bars) < 3:
        return _no("opening_reversal", "Opening Reversal", "reversal")
    last_bar = bars[-1]
    secs = _bar_time_of_day_secs(last_bar)
    # Only fire during 09:15:00–09:49:59 IST (0–35 min from open)
    _OPEN_START = 9 * 3600 + 15 * 60   # 33300
    _OPEN_END   = 9 * 3600 + 50 * 60   # 35400
    if not (_OPEN_START <= secs < _OPEN_END):
        return _no("opening_reversal", "Opening Reversal", "reversal")

    # Need at least 3 bars to determine initial vs current direction
    first_bar = bars[0]
    initial_open = _o(first_bar)
    bar3_close = _c(bars[2])
    initial_direction = 1 if bar3_close > initial_open else -1
    current_close = _c(last_bar)
    threshold = initial_open * 0.003  # 0.3% reversal needed

    if initial_direction == 1 and current_close < initial_open - threshold:
        return PatternResult(
            True, "opening_reversal", "Opening Reversal (Bear)", "reversal", "warning",
            "Market opened up then reversed below open — possible trend day short",
            "Opening reversal short: consider PE entries; stop above today's high.",
        )
    if initial_direction == -1 and current_close > initial_open + threshold:
        return PatternResult(
            True, "opening_reversal", "Opening Reversal (Bull)", "reversal", "warning",
            "Market opened down then reversed above open — possible trend day long",
            "Opening reversal long: consider CE entries; stop below today's low.",
        )
    return _no("opening_reversal", "Opening Reversal", "reversal")


def detect_ema_crossover(bars: Sequence[dict]) -> list[PatternResult]:
    """9-EMA / 21-EMA crossover detection. Returns up to 2 results (bull/bear)."""
    results: list[PatternResult] = []
    if len(bars) < 22:
        return results
    closes = [_c(b) for b in bars]
    ema9  = _ema(closes, 9)
    ema21 = _ema(closes, 21)
    # Align: both lists end at the same bar; ema21 is shorter
    # ema9 has len(closes) - 8 elements, ema21 has len(closes) - 20 elements
    # The last element of ema21 corresponds to closes[-1]; 2nd-to-last to closes[-2]
    if len(ema9) < 2 or len(ema21) < 2:
        return results
    prev9, cur9 = ema9[-2], ema9[-1]
    prev21, cur21 = ema21[-2], ema21[-1]

    if prev9 <= prev21 and cur9 > cur21:
        results.append(PatternResult(
            True, "ema_crossover_bull", "EMA 9/21 Bullish Cross", "ema", "info",
            f"9-EMA ({cur9:.1f}) crossed above 21-EMA ({cur21:.1f})",
            "Micro-trend turning bullish — watch CE setups on confirmation bar.",
        ))
    elif prev9 >= prev21 and cur9 < cur21:
        results.append(PatternResult(
            True, "ema_crossover_bear", "EMA 9/21 Bearish Cross", "ema", "info",
            f"9-EMA ({cur9:.1f}) crossed below 21-EMA ({cur21:.1f})",
            "Micro-trend turning bearish — watch PE setups on confirmation bar.",
        ))
    return results


def _find_zone_level(pivots: list[float], tolerance_pct: float = 0.4) -> list[tuple[float, int]]:
    """Cluster pivot levels within tolerance_pct; return (level, touch_count) pairs."""
    if not pivots:
        return []
    clusters: list[tuple[float, int]] = []
    for p in sorted(pivots):
        placed = False
        for i, (lvl, cnt) in enumerate(clusters):
            if abs(p - lvl) / lvl * 100 <= tolerance_pct:
                clusters[i] = ((lvl * cnt + p) / (cnt + 1), cnt + 1)
                placed = True
                break
        if not placed:
            clusters.append((p, 1))
    return [(lvl, cnt) for lvl, cnt in clusters if cnt >= 3]


def detect_support_zone(bars: Sequence[dict]) -> PatternResult:
    """Price approaching a support zone (3+ prior touches within 0.4%)."""
    n = 25
    if len(bars) < n:
        return _no("support_zone", "Support Zone", "level")
    tail = list(bars[-n:])
    # Local lows: bar whose low is lower than both neighbours
    local_lows = [
        _l(tail[i])
        for i in range(1, len(tail) - 1)
        if _l(tail[i]) <= _l(tail[i - 1]) and _l(tail[i]) <= _l(tail[i + 1])
    ]
    zones = _find_zone_level(local_lows)
    if not zones:
        return _no("support_zone", "Support Zone", "level")
    current_low = _l(tail[-1])
    for lvl, cnt in zones:
        if lvl > 0 and abs(current_low - lvl) / lvl * 100 <= 0.5:
            return PatternResult(
                True, "support_zone", "Support Zone", "level", "info",
                f"Price near {lvl:.0f} support ({cnt} touches)",
                f"Watch for bounce at {lvl:.0f}; CE buy opportunity if bull bar confirms.",
            )
    return _no("support_zone", "Support Zone", "level")


def detect_resistance_zone(bars: Sequence[dict]) -> PatternResult:
    """Price approaching a resistance zone (3+ prior touches within 0.4%)."""
    n = 25
    if len(bars) < n:
        return _no("resistance_zone", "Resistance Zone", "level")
    tail = list(bars[-n:])
    local_highs = [
        _h(tail[i])
        for i in range(1, len(tail) - 1)
        if _h(tail[i]) >= _h(tail[i - 1]) and _h(tail[i]) >= _h(tail[i + 1])
    ]
    zones = _find_zone_level(local_highs)
    if not zones:
        return _no("resistance_zone", "Resistance Zone", "level")
    current_high = _h(tail[-1])
    for lvl, cnt in zones:
        if lvl > 0 and abs(current_high - lvl) / lvl * 100 <= 0.5:
            return PatternResult(
                True, "resistance_zone", "Resistance Zone", "level", "info",
                f"Price near {lvl:.0f} resistance ({cnt} touches)",
                f"Watch for rejection at {lvl:.0f}; PE sell opportunity if bear bar confirms.",
            )
    return _no("resistance_zone", "Resistance Zone", "level")


# ── Behavioral patterns ────────────────────────────────────────────────────────

def detect_panic_behavior(
    stoploss_changes_recent: int,
    rapid_trade_count: int,
) -> PatternResult:
    """
    Behavioral signal: too many SL changes or rapid re-entries.
    stoploss_changes_recent: SL order modifications in last 5 bars
    rapid_trade_count: trades placed within the last 10 minutes
    """
    if stoploss_changes_recent >= 3:
        return PatternResult(
            True, "panic_behavior", "Panic Behavior Detected", "behavioral", "critical",
            f"{stoploss_changes_recent} stoploss changes in last 5 bars",
            "Step back — frequent SL moves erode edge. Let the trade breathe.",
        )
    if rapid_trade_count >= 4:
        return PatternResult(
            True, "panic_behavior", "Panic Behavior Detected", "behavioral", "critical",
            f"{rapid_trade_count} trades in last 10 minutes",
            "Overtrading detected — pause and review before next entry.",
        )
    return _no("panic_behavior", "Panic Behavior", "behavioral")


def detect_overtrading(round_trips_last_window: int) -> PatternResult:
    """More than 2 complete round-trips (entry+exit) in any 15-min window."""
    if round_trips_last_window > 2:
        return PatternResult(
            True, "overtrading", "Overtrading Warning", "behavioral", "warning",
            f"{round_trips_last_window} complete round-trips in 15 min",
            "High trade frequency signals impulsive entries — wait for clear setups.",
        )
    return _no("overtrading", "Overtrading", "behavioral")


# ── Aggregate detector ────────────────────────────────────────────────────────

def detect_all_market_patterns(bars: Sequence[dict]) -> list[PatternResult]:
    """
    Run all market pattern detectors on the provided bar history.
    Returns only detected patterns (detected=True).
    """
    results: list[PatternResult] = []
    checks = [
        detect_strong_bull_trend,
        detect_strong_bear_trend,
        detect_trading_range,
        detect_bull_trend_reversal,
        detect_bear_trend_reversal,
        detect_range_breakout_bull,
        detect_range_breakout_bear,
        detect_opening_reversal,
        detect_support_zone,
        detect_resistance_zone,
    ]
    for fn in checks:
        try:
            r = fn(bars)
            if r.detected:
                results.append(r)
        except Exception:
            pass  # never let a detector crash the caller
    try:
        results.extend(r for r in detect_ema_crossover(bars) if r.detected)
    except Exception:
        pass
    return results
