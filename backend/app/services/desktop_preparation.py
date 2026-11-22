"""Side-effect-free session preparation (historical cache downloads only).

Do not use the legacy find-strike helper: its ATM fallback and future-row lookup
are unsuitable for a premium cap at a historical session clock.
"""
from app.services.instrument_identity import strike_number
from datetime import date as calendar_date
from math import isfinite
from dataclasses import replace

import numpy as np
import pandas as pd

from app.config import SUPPORTED_SYMBOLS
from app.services.historical_data_service import historical_operation, load_history
from app.services.options_service import STRIKE_INTERVALS, get_atm_strike, get_expiry_date, trading_expiry
from app.utils import is_trading_day


def observed_frame(result, date):
    frame = result.frame.copy()
    frame.index = frame.index.tz_localize("UTC") if frame.index.tzinfo is None else frame.index.tz_convert("UTC")
    frame = frame[frame.index.strftime("%Y-%m-%d") == date].sort_index()
    if "observed" in frame:
        frame = frame[frame.observed.fillna(False).astype(bool)]
    return frame


def infer_observed(frame):
    """Observation mask for cache files saved before provenance was recorded.

    Gap filling forward-fills after the first provider row and back-fills the
    leading gap with that row's (future) price, so the leading run of identical
    OHLC rows is the only look-ahead.  Trust the run's last row onward.  This is
    conservative: a genuinely flat opening only delays when a price is accepted.
    """
    values = frame[["open", "high", "low", "close"]].to_numpy()
    if len(values) < 2:
        return np.ones(len(values), dtype=bool)
    changed = (values[1:] != values[:-1]).any(axis=1)
    first_real = int(changed.argmax()) if changed.any() else len(values) - 1
    mask = np.ones(len(values), dtype=bool)
    mask[:first_real] = False
    return mask


def price_before(result, date, reference, *, require_observed=False):
    frame = observed_frame(result, date)
    if require_observed and "observed" not in result.frame:
        if not {"open", "high", "low", "close"} <= set(frame.columns):
            raise ValueError("Observation provenance unavailable; choose a manual strike")
        frame = frame[infer_observed(frame)]
    # Native minute OHLC is only known after the minute finishes. Source seconds
    # are observed tick samples at their timestamp (project's IST-as-UTC encoding).
    delay = result.interval_seconds if result.interval_seconds > 1 else 0
    rows = frame[frame.index + pd.Timedelta(seconds=delay) <= reference]
    if rows.empty:
        return None
    value = float(rows.iloc[-1]["close"])
    return value if isfinite(value) and value > 0 else None


def _missing(exc):
    # A timeout/rate limit/auth failure is never proof of an invalid chart.
    return isinstance(exc, FileNotFoundError)


def first_observed_timestamp(symbol, date, strike, expiry, right):
    """Known leading backfill must never become a desktop quote or fill."""
    from app.services.options_service import options_parquet_path
    path = options_parquet_path(symbol, date, strike, expiry, right)
    if not path.exists():
        return None
    raw = pd.read_parquet(path)
    if "observed" not in raw:
        return None  # Legacy manual histories preserve their existing semantics.
    rows = raw[raw.observed.fillna(False).astype(bool)]
    return int(rows.index.min().timestamp()) if not rows.empty else float("inf")


def desktop_option_ticks(symbol, date, strike, expiry, right, start_time):
    from app.services.options_service import options_iter_ticks
    first = first_observed_timestamp(symbol, date, strike, expiry, right)
    return (tick for tick in options_iter_ticks(symbol, date, strike, expiry, right, start_time)
            if first is None or tick["time"] >= first)


def trim_leading_option_frame(frame, symbol, date, strike, expiry, right):
    first = first_observed_timestamp(symbol, date, strike, expiry, right)
    return frame if first is None else frame[[int(timestamp.timestamp()) >= first for timestamp in frame.index]]


def _load(*args):
    try:
        result = load_history(*args)
        if result.stale:
            raise RuntimeError("Historical provider returned stale data; retry preparation")
        # Legacy OHLC loaders deliberately omit extra columns. Recover the
        # observation mask from the exact provider file without changing engines.
        if "observed" not in result.frame and result.path.exists():
            raw = pd.read_parquet(result.path)
            if "observed" in raw:
                raw.index = raw.index.tz_localize("UTC") if raw.index.tzinfo is None else raw.index.tz_convert("UTC")
                frame = result.frame.copy()
                frame["observed"] = raw["observed"].reindex(frame.index).fillna(False).astype(bool)
                result = replace(result, frame=frame)
        return result
    except FileNotFoundError:
        raise
    except Exception as exc:
        if isinstance(exc, RuntimeError) and str(exc).startswith(("Breeze returned no options data for ", "Breeze returned no data for ")):
            raise FileNotFoundError(str(exc)) from exc
        raise RuntimeError("Historical provider failed") from exc


def _load_minute(symbol, date, strike=None, expiry=None, right=None):
    """Browse reads minute candles: no replay is started from it, so second-level data is not needed."""
    from app.services import minute_history
    try:
        return minute_history.load(symbol, date, strike, expiry, right)
    except FileNotFoundError:
        raise
    except Exception as exc:
        raise RuntimeError("Historical provider failed") from exc


def price_at(result, date, reference):
    """Price at an instant, without look-ahead, for minute rows.

    A minute bar labelled 09:15:00 opens at 09:15:00, so the open of the bar that starts exactly at ``reference`` is the
    price at that instant. Otherwise the last finished bar's close, as ``price_before``.
    """
    if result.interval_seconds > 1:
        frame = observed_frame(result, date)
        exact = frame[frame.index == reference]
        if not exact.empty:
            value = float(exact.iloc[0]["open"])
            if isfinite(value) and value > 0:
                return value
    return price_before(result, date, reference)


MAX_PRICE_SCAN_STRIKES = 50  # strikes searched outward from ATM (was 30; Phase 26)


def find_max_price_strike(symbol, date, expiry, right, cap, reference, load):
    """The first strike from ATM outwards (CE up, PE down, ``MAX_PRICE_SCAN_STRIKES`` steps) whose observed premium is at or below ``cap``.

    ``load(symbol, date[, strike, expiry, right])`` supplies the candles (minute for Browse and the read-only screens,
    seconds for replay), and the prices are the last observed ones before ``reference`` (no look-ahead). There is no ATM
    fallback: ``ValueError`` says what was missing. Returns ``(strike, premium, history)``.
    """
    underlying = load(symbol, date)
    price = price_before(underlying, date, reference, require_observed=True)
    if price is None:
        raise ValueError("No underlying price is available at this reference time")
    atm = get_atm_strike(symbol, price)
    for step in range(MAX_PRICE_SCAN_STRIKES):
        strike = atm + step * STRIKE_INTERVALS[symbol] * (1 if right == "CE" else -1)
        if strike <= 0:
            break
        try:
            candidate = load(symbol, date, strike, expiry, right)
        except FileNotFoundError:
            continue
        premium = price_before(candidate, date, reference, require_observed=True)
        if premium is not None and premium <= cap:
            return strike, premium, candidate
    raise ValueError(f"No observed premium at or below the cap within {MAX_PRICE_SCAN_STRIKES} strikes")


def find_max_price_strike_minute(symbol, date, expiry, right, cap, reference_time):
    """``find_max_price_strike`` on minute data, for the read-only Patterns and Structures screens."""
    reference = pd.Timestamp(f"{date} {reference_time}", tz="UTC")
    strike, premium, _ = find_max_price_strike(symbol, date, expiry, right, cap, reference, _load_minute)
    return {"strike": strike, "price": premium}


def prepare(mode, date, reference_time, panes, next_on_expiry_day=False, existing_session=False):
    """Resolve the panes of a session (or a Browse view). A trading session must use ``trading_expiry`` (the next expiry on an expiry day when the
    user's setting is on); Browse and an already started session also accept the plain expiry."""
    requested = calendar_date.fromisoformat(date)
    if not is_trading_day(requested):
        raise ValueError("The selected date is not a trading day")
    load = _load_minute if mode == "browse" else _load
    reference = pd.Timestamp(f"{date} {reference_time}", tz="UTC")
    results = []
    with historical_operation(mode="live" if mode in ("paper", "real") else "replay"):
        for pane in panes:
            item = dict(pane)
            status, reason, premium = "available", None, None
            symbol = item["symbol"]
            try:
                history = None
                if symbol not in SUPPORTED_SYMBOLS:
                    raise ValueError("Unsupported symbol")
                if item["kind"] == "option":
                    calendar_date.fromisoformat(item["expiry"])
                    if item["expiry"] < date:
                        raise ValueError("The option contract has expired")
                    plain = get_expiry_date(symbol, date)
                    allowed = {plain}
                    if mode != "browse":
                        wanted = trading_expiry(symbol, date, next_on_expiry_day)
                        allowed = {wanted, plain} if existing_session else {wanted}
                    if item["expiry"] not in allowed:
                        if mode != "browse" and item["expiry"] == plain:
                            raise ValueError(f"Expiry day: the next expiry ({wanted}) is used for new sessions (Settings > Trading)")
                        raise ValueError("Expiry is outside the supported date-aware option range")
                    if item.get("selection_mode") == "max_price":
                        found, premium, history = find_max_price_strike(
                            symbol, date, item["expiry"], item["right"], item["max_price"], reference, load)
                        item["strike"] = str(found)
                    strike = strike_number(item["strike"])
                    if strike <= 0 or strike % STRIKE_INTERVALS[symbol]:
                        raise ValueError("Strike does not match the instrument interval")
                    history = history or load(symbol, date, strike, item["expiry"], item["right"])
                else:
                    history = load(symbol, date)
                frame = observed_frame(history, date)
                if frame.empty:
                    status, reason = "unavailable", "No observations are available on the selected date"
                elif price_before(history, date, reference) is None:
                    status, reason = "waiting", "Waiting for first price"
            except ValueError as exc:
                # Only our validation ValueErrors are confirmed invalid. Provider
                # exceptions are classified at the load boundary below instead.
                reason = str(exc)
                status = "error" if reason.startswith(("No observed premium", "No underlying price", "Observation provenance")) else "unavailable"
            except Exception as exc:
                status = "unavailable" if _missing(exc) else "error"
                reason = "No data is available for this contract/date" if _missing(exc) else "Historical provider failed; retry preparation"
            item["tradingDate"] = date
            results.append({"pane": item, "availability": status, "reason": reason, "premium": premium if status in ("available", "waiting") else None})
    return {"version": 1, "date": date, "reference_time": reference_time, "panes": results}
