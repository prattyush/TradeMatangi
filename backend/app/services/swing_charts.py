"""Read-only Swing chart history and viewer quotes, separate from execution books."""

import asyncio
import hashlib
import json
import math
import os
import threading
import time
from pathlib import Path

import pandas as pd
from fastapi import HTTPException

from app.config import OHLCDATA_DIR, SUPPORTED_SYMBOLS
from app.services import swing_market

INTERVALS = {"1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "1D": 1440}
_locks = {}
_guard = threading.Lock()


def instrument(symbol, kind="equity", right=None, strike=None, expiry=None):
    from app.services.instrument_identity import strike_number

    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(422, "Unsupported chart symbol")
    definition = SUPPORTED_SYMBOLS[symbol]
    if kind == "options":
        if (
            right not in ("CE", "PE")
            or not strike
            or not expiry
            or "options_exchange_code" not in definition
        ):
            raise HTTPException(422, "An exact listed option contract is required")
        pd.Timestamp(expiry)
        return {
            "kind": "option",
            "underlying": symbol,
            "exchange": definition["options_exchange_code"],
            "right": right,
            "strike": strike_number(strike),
            "expiry": expiry,
        }
    return {
        "kind": "index" if definition["options_only"] else "equity",
        "symbol": symbol,
        "exchange": definition["exchange_code"],
    }


def bucket(timestamp, interval):
    day = int(timestamp) // 86400 * 86400
    if interval == "1D":
        return day
    seconds = INTERVALS[interval] * 60
    opening = day + 33300
    return opening + (int(timestamp) - opening) // seconds * seconds


def _fetch(provider, item, start, end, daily):
    symbol = item.get("underlying") or item["symbol"]
    option = item["kind"] == "option"
    if provider == "kite":
        from app.services import kite_service as sdk

        token = (
            sdk.fetch_options_instrument_token(
                symbol, item["expiry"], item["strike"], item["right"]
            )
            if option
            else sdk.fetch_equity_instrument_token(symbol)[1]
        )
        rows = sdk._kite_request(
            sdk._get_kite(),
            "historical",
            "historical_data",
            instrument_token=token,
            from_date=start.to_pydatetime(),
            to_date=end.to_pydatetime(),
            interval="day" if daily else "minute",
            continuous=False,
            oi=False,
        )
        return pd.DataFrame(rows).rename(columns={"date": "datetime"})
    if provider == "kotak":
        from app.services import kotak_history as sdk
        from app.services.kotak_service import (
            fetch_kotak_equity_instrument_token,
            fetch_kotak_options_instrument_token,
        )

        client = sdk._get_client()
        token, exchange = (
            fetch_kotak_options_instrument_token(
                symbol, item["expiry"], item["strike"], item["right"], client=client
            )
            if option
            else fetch_kotak_equity_instrument_token(symbol, client=client)
        )
        response = sdk._request(
            client,
            neosymbol=f"{exchange}|{token}",
            interval="D" if daily else "1min",
            from_date=start.date().isoformat(),
            to_date=end.date().isoformat(),
        )
        rows = (
            response.get("data", {}).get("candles", [])
            if isinstance(response.get("data"), dict)
            else response.get("data", [])
        )
        return pd.DataFrame(
            rows,
            columns=["datetime", "open", "high", "low", "close", "volume"]
            + (["oi"] if rows and len(rows[0]) == 7 else []),
        )
    from app.services.breeze_history import request_history
    from app.services.broker_service import _get_breeze

    definition = SUPPORTED_SYMBOLS[symbol]
    kwargs = {
        "interval": "1day" if daily else "1minute",
        "from_date": start.strftime("%Y-%m-%d %H:%M:%S"),
        "to_date": end.strftime("%Y-%m-%d %H:%M:%S"),
        "stock_code": definition["breeze_stock_code"],
        "exchange_code": definition["options_exchange_code"]
        if option
        else definition["exchange_code"],
        "product_type": "options" if option else definition["product_type"],
    }
    if option:
        kwargs.update(
            expiry_date=item["expiry"] + "T00:00:00.000Z",
            strike_price=str(item["strike"]),
            right="call" if item["right"] == "CE" else "put",
        )
    response = request_history(_get_breeze(), **kwargs)
    if (
        not isinstance(response, dict)
        or response.get("Error")
        or response.get("Status") not in (None, 200)
    ):
        raise ValueError("Breeze chart history is unavailable")
    return pd.DataFrame(response.get("Success") or [])


def normalize(frame, daily):
    if frame.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    if "datetime" not in frame:
        raise ValueError("History has no timestamps")
    stamps = []
    for value in frame["datetime"]:
        if isinstance(value, (int, float)):
            stamp = (
                pd.Timestamp(value, unit="ms" if value > 1e11 else "s", tz="UTC")
                .tz_convert("Asia/Kolkata")
                .tz_localize(None)
            )
        else:
            stamp = pd.Timestamp(value)
            if stamp.tzinfo:
                stamp = stamp.tz_convert("Asia/Kolkata").tz_localize(None)
        stamps.append(stamp.normalize() if daily else stamp)
    frame = frame.copy()
    frame.index = pd.DatetimeIndex(stamps)
    for key in ["open", "high", "low", "close", "volume"]:
        frame[key] = pd.to_numeric(frame.get(key, 0), errors="coerce")
    valid = (
        frame[["open", "high", "low", "close"]]
        .apply(lambda col: col.map(math.isfinite))
        .all(axis=1)
    )
    valid &= (frame[["open", "high", "low", "close"]] > 0).all(axis=1)
    valid &= (frame.high >= frame[["open", "close", "low"]].max(axis=1)) & (
        frame.low <= frame[["open", "close", "high"]].min(axis=1)
    )
    frame = frame[valid][["open", "high", "low", "close", "volume"]]
    frame["volume"] = frame.volume.map(
        lambda value: max(0, value) if math.isfinite(value) else 0
    )
    if not daily:
        frame = frame.between_time("09:15", "15:30", inclusive="left")
    frame = frame[
        frame.index.map(
            lambda stamp: __import__(
                "app.utils", fromlist=["is_trading_day"]
            ).is_trading_day(stamp.date())
        )
    ]
    return frame[~frame.index.duplicated(keep="last")].sort_index()


def _cached(provider, item, start, end, daily):
    identity = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()[
        :24
    ]
    resolution = "day" if daily else "1m"
    folder = Path(OHLCDATA_DIR) / "swing" / provider / identity / resolution
    results = []
    # Daily windows are bounded below API candle limits; minute chunks are one day.
    cursor = start.normalize()
    while cursor <= end:
        finish = min(
            end,
            cursor + pd.Timedelta(days=89, hours=15, minutes=30)
            if daily
            else cursor + pd.Timedelta(hours=15, minutes=30),
        )
        path = folder / f"{cursor.date()}-{finish.strftime('%Y-%m-%d-%H%M%S')}.parquet"
        with _guard:
            lock = _locks.setdefault(str(path), threading.Lock())
        with lock:
            fresh = path.exists() and (
                finish.date() < pd.Timestamp(swing_market.today()).date()
                or time.time() - path.stat().st_mtime < 60
            )
            if fresh:
                frame = pd.read_parquet(path)
            else:
                request_start = (
                    cursor if daily else cursor + pd.Timedelta(hours=9, minutes=15)
                )
                if request_start > finish:
                    cursor = finish.normalize() + pd.Timedelta(days=1)
                    continue
                if not daily and not __import__(
                    "app.utils", fromlist=["is_trading_day"]
                ).is_trading_day(cursor.date()):
                    cursor = finish.normalize() + pd.Timedelta(days=1)
                    continue
                frame = normalize(
                    _fetch(provider, item, request_start, finish, daily), daily
                )
                folder.mkdir(parents=True, exist_ok=True)
                temporary = path.with_suffix(
                    f".{os.getpid()}.{threading.get_ident()}.tmp"
                )
                frame.to_parquet(temporary)
                os.replace(temporary, path)
            results.append(frame)
        cursor = finish.normalize() + pd.Timedelta(days=1)
    return pd.concat(results).sort_index() if results else pd.DataFrame()


def history(item, interval, date, before=None, limit=None):
    from app.services.historical_data_service import get_policy

    if interval not in INTERVALS:
        raise HTTPException(422, "Unsupported Swing interval")
    if date > swing_market.today():
        raise HTTPException(422, "Swing charts cannot use a future date")
    daily = interval == "1D"
    limit = limit or (250 if daily else 300)
    end = pd.Timestamp(date + "T15:30:00")
    if before is not None:
        end = min(end, pd.Timestamp(int(before), unit="s") - pd.Timedelta(seconds=1))
    if item["kind"] == "option":
        end = min(end, pd.Timestamp(item["expiry"] + "T15:30:00"))
    days = min(
        550, math.ceil(limit * (1.6 if daily else INTERVALS[interval] / 375 * 1.6)) + 7
    )
    start = end.normalize() - pd.Timedelta(days=days)
    policy = get_policy()
    providers = [policy.source]
    if policy.allow_fallback:
        providers += [
            name for name in ("kite", "breeze", "kotak") if name != policy.source
        ]
    failure = None
    for provider in providers:
        try:
            frame = _cached(provider, item, start, end, daily)
            if not frame.empty:
                frame = frame[(frame.index >= start) & (frame.index <= end)]
                if before is not None:
                    frame = frame[frame.index < pd.Timestamp(int(before), unit="s")]
                if not daily:
                    # Session-anchored buckets retain full 09:15–15:30 coverage.
                    stamps = [
                        bucket(int(stamp.tz_localize("UTC").timestamp()), interval)
                        for stamp in frame.index
                    ]
                    frame = frame.groupby(stamps).agg(
                        {
                            "open": "first",
                            "high": "max",
                            "low": "min",
                            "close": "last",
                            "volume": "sum",
                        }
                    )
                else:
                    frame.index = [
                        int(stamp.tz_localize("UTC").timestamp())
                        for stamp in frame.index
                    ]
                all_count = len(frame)
                frame = frame.tail(limit)
                candles = [
                    {
                        "time": int(stamp),
                        "timestamp": int(stamp),
                        **{
                            key: float(row[key])
                            for key in ("open", "high", "low", "close", "volume")
                        },
                    }
                    for stamp, row in frame.iterrows()
                ]
            else:
                candles = []
                all_count = 0
            return {
                "candles": candles,
                "provider": provider,
                "selected_provider": policy.source,
                "interval": interval,
                "date": date,
                "more": all_count > limit,
                "before": candles[0]["time"] if candles else None,
                "partial": date == swing_market.today()
                and bool(swing_market.window(swing_market.now())),
                "stale": False,
            }
        except Exception as exc:  # noqa: BLE001 — try the configured provider fallback
            failure = exc
    raise HTTPException(
        503, "Swing history unavailable; retry after provider recovery"
    ) from failure


class Viewer:
    def __init__(self, user, portfolio, items, real, identifier=None):
        self.user, self.portfolio, self.items, self.real = user, portfolio, items, real
        self.identifier = identifier
        self.handles = []
        self.queues = []
        self.quotes = {}
        self.bars = {}
        self.signature = None
        self.last_seen = time.monotonic()
        self.error = None
        self.actual = None
        self.next_owner_check = 0
        self.task = asyncio.create_task(self.run())

    async def run(self):
        from app.services.market_data import FeedGroup, get_hub, selected_provider
        from app.services.swing_portfolio_store import owned

        try:
            while time.monotonic() - self.last_seen <= 45:
                try:
                    if time.monotonic() >= self.next_owner_check:
                        if (await asyncio.to_thread(owned, self.user, self.portfolio))[
                            "state"
                        ] == "ended":
                            return
                        self.next_owner_check = time.monotonic() + 15
                    selected = (
                        selected_provider()
                        if swing_market.window(swing_market.now())
                        else None
                    )
                    if selected != self.signature:
                        for handle in self.handles:
                            handle.close()
                        self.handles, self.queues = [], []
                        self.signature = None
                        if selected:
                            group = FeedGroup(selected, self.real)
                            for key, item in enumerate(self.items):
                                queue = asyncio.Queue(maxsize=1024)
                                self.handles.append(
                                    await get_hub().subscribe(
                                        item,
                                        f"swing-view:{id(self)}:{key}",
                                        group,
                                        queue,
                                    )
                                )
                                self.queues.append(queue)
                            self.signature = selected
                            self.actual = group.actual or selected
                    for item, queue in zip(self.items, self.queues):
                        while not queue.empty():
                            event = queue.get_nowait()
                            if (
                                event.get("type") == "tick"
                                and 0
                                <= swing_market.now() - int(event.get("time", 0))
                                < 120
                            ):
                                self.record(item, event)
                                self.error = None
                    await asyncio.sleep(0.25 if selected else 5)
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 — transient feed failures retry without stopping the portfolio
                    self.error = "Live data is reconnecting"
                    for handle in self.handles:
                        handle.close()
                    self.handles, self.queues, self.signature = [], [], None
                    await asyncio.sleep(10)
        finally:
            for handle in self.handles:
                handle.close()
            if self.identifier and _viewers.get(self.identifier) is self:
                _viewers.pop(self.identifier, None)

    def record(self, item, event):
        """Retain intra-poll extremes; all intervals share the same owned feed."""
        key = json.dumps(item, sort_keys=True)
        previous = self.quotes.get(key)
        if previous and event["time"] < previous["time"]:
            return
        ranges = self.bars.setdefault(key, {})
        for interval in INTERVALS:
            stamp = bucket(event["time"], interval)
            old = ranges.get(interval)
            if old and old["time"] == stamp:
                ranges[interval] = {
                    **old,
                    "high": max(old["high"], event["high"]),
                    "low": min(old["low"], event["low"]),
                    "close": event["close"],
                }
            else:
                ranges[interval] = {
                    field: event[field] for field in ("open", "high", "low", "close")
                }
                ranges[interval]["time"] = stamp
        self.quotes[key] = {
            **event,
            "instrument": item,
            "candles": dict(ranges),
            "received_at": swing_market.now(),
        }

    def stop(self):
        self.task.cancel()


_viewers = {}


def stop_viewer(identifier, user):
    viewer = _viewers.get(identifier)
    if viewer and viewer.user == user:
        viewer.stop()
        _viewers.pop(identifier, None)


async def shutdown():
    tasks = [viewer.task for viewer in list(_viewers.values())]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _viewers.clear()
