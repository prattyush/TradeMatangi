"""Lazy cached-price enrichment. Never downloads history or polls trading APIs."""

from copy import deepcopy
from threading import BoundedSemaphore
import pandas as pd
from app.services.performance_service import number, execution_order_key

_workers = BoundedSemaphore(2)


def match_excursion(match, frame, direction, provider, interval_seconds):
    start, end = match["entry_time"], match["exit_time"]
    times = frame.index.astype("int64") // 1_000_000_000
    window = frame[(times > start) & (times + interval_seconds <= end)]
    if "observed" not in window.columns:
        return dict(
            status="unavailable",
            reason="Cached history predates observation provenance",
            provider=provider,
        )
    window = window[window["observed"].fillna(False).astype(bool)]
    if window.empty:
        return dict(
            status="unavailable",
            reason="No unambiguous observations inside the holding window",
            provider=provider,
        )
    sign = 1 if direction == "LONG" else -1
    values = (
        sign
        * (window[["high", "low"]].to_numpy() - match["entry_price"])
        * match["quantity"]
    )
    mfe = max(0.0, float(values.max()), number(match["gross_pnl"]))
    mae = max(0.0, float(-values.min()))
    gross = match["gross_pnl"]
    return dict(
        status="sampled",
        provider=provider,
        interval_seconds=interval_seconds,
        observations=len(window),
        coverage=min(1.0, len(window) * interval_seconds / max(1, end - start)),
        mfe=mfe,
        mae=mae,
        giveback=max(0.0, mfe - gross),
        capture_pct=100 * gross / mfe if mfe > 0 else None,
    )


def enrich_cycle(cycle):
    with _workers:
        item = deepcopy(cycle)
        from app.services.historical_data_service import _path, get_policy, is_today

        policy = get_policy()
        providers = (
            ["breeze"]
            if cycle["mode"] in ("sim", "stepwise")
            else (
                [policy.source]
                if is_today(cycle["date"])
                else ["breeze", policy.source]
            )
        )
        if cycle["mode"] in ("paper", "real") and policy.allow_fallback:
            providers += ["kite", "breeze"]
        frame = None
        provider = None
        resolution = 1
        for source in dict.fromkeys(providers):
            path = _path(
                source,
                cycle["symbol"],
                cycle["date"],
                cycle["strike"],
                cycle["expiry"],
                cycle["right"],
            )
            if not path.exists():
                continue
            candidate = pd.read_parquet(path)
            if candidate.empty:
                continue
            if candidate.index.tzinfo is None:
                candidate.index = candidate.index.tz_localize("UTC")
            else:
                candidate.index = candidate.index.tz_convert("UTC")
            if "observed" not in candidate:
                if source == "breeze":
                    continue
                candidate["observed"] = True
            candidate["observed"] = (
                candidate["observed"].fillna(False).astype(bool)
                & (candidate["low"] > 0)
                & (candidate["high"] >= candidate["low"])
            )
            frame = candidate.sort_index()
            provider = source
            from app.services.data_loader import has_native_second_cadence

            resolution = (
                1 if source == "breeze" and has_native_second_cadence(candidate) else 60
            )
            break
        if frame is None:
            for m in item["matches"]:
                m["excursion"] = dict(
                    status="unavailable",
                    reason="No cached exact-contract history with observation provenance",
                )
            item["excursion"] = dict(
                status="unavailable", reason="No reliable cached observations"
            )
            return item
        for m in item["matches"]:
            m["excursion"] = match_excursion(
                m, frame, item["direction"], provider, resolution
            )
        # Cycle trajectory reflects changing size. Only complete, observed bars
        # strictly between executions can contribute extrema.
        events = sorted(item["executions"], key=execution_order_key)
        event_index = 0
        inventory = 0
        cash = 0.0
        peaks = [0.0]
        observations = 0
        end = item["exit_time"]
        if end:
            frame_times = frame.index.astype("int64") // 1_000_000_000
            observed_window = frame[
                (frame_times > item["entry_time"]) & (frame_times + resolution <= end)
            ]
            for ts, row in observed_window.iterrows():
                t = int(ts.timestamp())
                if (
                    t <= item["entry_time"]
                    or t + resolution > end
                    or not bool(row.get("observed", False))
                ):
                    continue
                if any(t <= e["timestamp"] < t + resolution for e in events):
                    continue
                while (
                    event_index < len(events) and events[event_index]["timestamp"] < t
                ):
                    event = events[event_index]
                    sign = 1 if event["side"] == "BUY" else -1
                    inventory += sign * int(event["quantity"])
                    cash -= sign * int(event["quantity"]) * number(event["price"])
                    event_index += 1
                observations += 1
                peaks.extend(
                    [
                        cash + inventory * number(row["high"]),
                        cash + inventory * number(row["low"]),
                    ]
                )
            if not observations:
                item["excursion"] = dict(
                    status="unavailable",
                    reason="No unambiguous observations inside the cycle",
                )
                return item
            mfe = max(0.0, max(peaks), item["gross_pnl"])
            mae = max(0.0, -min(peaks))
            item["excursion"] = dict(
                status="sampled",
                provider=provider,
                interval_seconds=resolution,
                observations=observations,
                coverage=min(
                    1.0, observations * resolution / max(1, end - item["entry_time"])
                ),
                mfe=mfe,
                mae=mae,
                giveback=max(0.0, mfe - item["gross_pnl"]),
                capture_pct=100 * item["gross_pnl"] / mfe if mfe > 0 else None,
            )
        else:
            item["excursion"] = dict(status="unavailable", reason="Cycle remains open")
        return item
