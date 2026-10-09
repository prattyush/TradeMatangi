"""Side-effect-free session preparation (historical cache downloads only).

Do not use the legacy find-strike helper: its ATM fallback and future-row lookup
are unsuitable for a premium cap at a historical session clock.
"""
from datetime import date as calendar_date
from math import isfinite
from dataclasses import replace

import pandas as pd

from app.config import SUPPORTED_SYMBOLS
from app.services.historical_data_service import historical_operation, load_history
from app.services.options_service import STRIKE_INTERVALS, get_atm_strike, get_expiry_date
from app.utils import is_trading_day


def observed_frame(result, date):
    frame = result.frame.copy()
    frame.index = frame.index.tz_localize("UTC") if frame.index.tzinfo is None else frame.index.tz_convert("UTC")
    frame = frame[frame.index.strftime("%Y-%m-%d") == date].sort_index()
    if "observed" in frame:
        frame = frame[frame.observed.fillna(False).astype(bool)]
    return frame


def price_before(result, date, reference, *, require_observed=False):
    if require_observed and "observed" not in result.frame:
        raise ValueError("Observation provenance unavailable; choose a manual strike")
    frame = observed_frame(result, date)
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


def prepare(mode, date, reference_time, panes):
    requested = calendar_date.fromisoformat(date)
    if not is_trading_day(requested):
        raise ValueError("The selected date is not a trading day")
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
                    if item["expiry"] != get_expiry_date(symbol, date):
                        raise ValueError("Expiry is outside the supported date-aware option range")
                    if item.get("selection_mode") == "max_price":
                        underlying = _load(symbol, date)
                        price = price_before(underlying, date, reference, require_observed=True)
                        if price is None:
                            raise ValueError("No underlying price is available at this reference time")
                        atm = get_atm_strike(symbol, price)
                        cap = item["max_price"]
                        found = None
                        for step in range(30):
                            strike = atm + step * STRIKE_INTERVALS[symbol] * (1 if item["right"] == "CE" else -1)
                            if strike <= 0:
                                break
                            try:
                                candidate = _load(symbol, date, strike, item["expiry"], item["right"])
                            except FileNotFoundError:
                                continue
                            premium = price_before(candidate, date, reference, require_observed=True)
                            if premium is not None and premium <= cap:
                                found = strike
                                history = candidate
                                break
                        if found is None:
                            raise ValueError("No observed premium at or below the cap within 30 strikes")
                        item["strike"] = str(found)
                    strike = int(item["strike"])
                    if strike <= 0 or strike % STRIKE_INTERVALS[symbol]:
                        raise ValueError("Strike does not match the instrument interval")
                    history = history or _load(symbol, date, strike, item["expiry"], item["right"])
                else:
                    history = _load(symbol, date)
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
