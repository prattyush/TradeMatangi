#!/usr/bin/env python3
"""
Classify daily chart structures for supported symbols and store in DynamoDB.

For each trading day, computes:
  - Opening type (relative to yesterday and day-before-yesterday)
  - Midday type (based on first 15-min candle vs 12:00 PM close)
  - Closing type (open-to-12:00 range vs day close)

Writes predefined classifications (user_id="__SYSTEM__", is_predefined=True)
into the ChartStructures table. Idempotent — skips dates already classified.

Usage:
  python scripts/classify_chart_structures.py --symbol NIFTY --start 2025-01-01 --end 2026-07-10
  python scripts/classify_chart_structures.py --symbol ALL --start 2025-01-01 --end 2026-07-10
"""
import argparse
import configparser
import logging
import os
import sys
import uuid
from datetime import date as _date, datetime, timedelta, timezone

import boto3
import pandas as pd

PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(PROJECT_ROOT, "backend"))
os.environ["DATA_DIR"] = os.path.join(PROJECT_ROOT, "data")
os.environ["USE_DYNAMODB_LOCAL"] = "true"

from app.services.data_loader import load_dataframe
from app.config import MARKET_OPEN, MARKET_CLOSE, SUPPORTED_SYMBOLS, OHLCDATA_DIR
from app.utils import is_trading_day, prior_trading_days

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

ALL_SYMBOLS = ["NIFTY", "BSESEN", "TATPOW", "TATMOT", "RELIND"]

_EPSILON = 1e-8


def _get_db_table():
    cfg = configparser.ConfigParser()
    cfg.read(os.path.join(PROJECT_ROOT, "data", "accesskeys.ini"))
    aws = cfg["aws"]
    resource = boto3.resource(
        "dynamodb",
        endpoint_url=aws.get("url"),
        region_name=aws.get("region", "us-east-1"),
        aws_access_key_id=aws.get("access_key"),
        aws_secret_access_key=aws.get("secret_access_key"),
    )
    return resource.Table("ChartStructures")


def _already_classified(table, symbol: str, date_str: str) -> bool:
    resp = table.query(
        IndexName="SymbolDateIndex",
        KeyConditionExpression="symbol = :s AND #d = :d",
        ExpressionAttributeNames={"#d": "date"},
        ExpressionAttributeValues={":s": symbol, ":d": date_str},
        Limit=10,
    )
    for item in resp.get("Items", []):
        if item.get("is_predefined", False) or item.get("user_id") == "__SYSTEM__":
            return True
    return False


def _delete_existing_predefined(table, symbol: str, date_str: str) -> int:
    """Delete all predefined/system records for symbol+date (not user records)."""
    deleted = 0
    resp = table.query(
        IndexName="SymbolDateIndex",
        KeyConditionExpression="symbol = :s AND #d = :d",
        ExpressionAttributeNames={"#d": "date"},
        ExpressionAttributeValues={":s": symbol, ":d": date_str},
    )
    for item in resp.get("Items", []):
        if item.get("is_predefined", True) or item.get("user_id") == "__SYSTEM__":
            table.delete_item(Key={"chart_structure_id": item["chart_structure_id"]})
            deleted += 1
    return deleted


def _load_or_fetch(symbol: str, date_str: str):
    """
    Load OHLC data for a symbol+date. Tries parquet cache first,
    then fetches from Breeze API if cache is missing or incomplete.
    Raises FileNotFoundError / RuntimeError on failure.
    """
    from app.services.broker_service import fetch_historical
    fetch_historical(symbol, date_str)
    return load_dataframe(symbol, date_str)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _classify_opening(
    today_open: float,
    y_open: float, y_close: float,
    dby_open: float, dby_close: float,
) -> str:
    y_range = abs(y_open - y_close)
    y_low = min(y_open, y_close)
    y_high = max(y_open, y_close)

    dby_range = abs(dby_open - dby_close)
    dby_low = min(dby_open, dby_close)
    dby_high = max(dby_open, dby_close)

    if y_low <= today_open <= y_high:
        return "within_yesterdays_range"
    if dby_low <= today_open <= dby_high:
        return "within_day_before_yesterdays_range"

    gap_band_low = y_low - 2 * y_range
    gap_band_high = y_high + 2 * y_range
    if gap_band_low <= today_open <= gap_band_high:
        if today_open > y_high:
            return "gap_up"
        return "gap_down"

    if today_open > y_high:
        return "big_gap_up"
    return "big_gap_down"


def _classify_midday(df: pd.DataFrame, date_str: str) -> str:
    market_open = pd.Timestamp(f"{date_str} {MARKET_OPEN}").tz_localize("UTC")
    fifteen_min = market_open + pd.Timedelta(minutes=15)
    noon = pd.Timestamp(f"{date_str} 12:00:00").tz_localize("UTC")

    first_15 = df[(df.index >= market_open) & (df.index < fifteen_min)]
    if first_15.empty:
        logger.warning("No data in first 15 min for %s", date_str)
        return "undefined"

    high_15 = float(first_15["high"].max())
    low_15 = float(first_15["low"].min())
    range_15 = high_15 - low_15

    if range_15 < _EPSILON:
        return "undefined"

    before_noon = df[df.index <= noon]
    if before_noon.empty:
        logger.warning("No data before 12:00 for %s", date_str)
        return "undefined"

    close_12 = float(before_noon.iloc[-1]["close"])

    if low_15 <= close_12 <= high_15:
        return "trading_range"

    breakout_threshold = 2 * range_15
    if close_12 > high_15 + breakout_threshold or close_12 < low_15 - breakout_threshold:
        return "breakout"

    return "trend"


def _classify_closing(df: pd.DataFrame, date_str: str) -> str:
    market_open_ts = pd.Timestamp(f"{date_str} {MARKET_OPEN}").tz_localize("UTC")
    noon = pd.Timestamp(f"{date_str} 12:00:00").tz_localize("UTC")

    open_row = df[df.index >= market_open_ts]
    if open_row.empty:
        return "undefined"
    day_open = float(open_row.iloc[0]["open"])

    before_noon = df[df.index <= noon]
    if before_noon.empty:
        return "undefined"
    close_12 = float(before_noon.iloc[-1]["close"])

    day_close = float(df.iloc[-1]["close"])

    mid_range = abs(day_open - close_12)
    if mid_range < _EPSILON:
        return "undefined"

    mid_low = min(day_open, close_12)
    mid_high = max(day_open, close_12)
    midday_up = close_12 > day_open

    if mid_low <= day_close <= mid_high:
        return "trading_range"

    if midday_up and day_close > mid_high + 2 * mid_range:
        return "breakout"
    if not midday_up and day_close < mid_low - 2 * mid_range:
        return "breakout"

    if midday_up and day_close < mid_low - 2 * mid_range:
        return "reversal_breakout"
    if not midday_up and day_close > mid_high + 2 * mid_range:
        return "reversal_breakout"

    if midday_up and day_close > mid_high:
        return "trend"
    if not midday_up and day_close < mid_low:
        return "trend"

    if midday_up and day_close < mid_low:
        return "trend_reversal"
    if not midday_up and day_close > mid_high:
        return "trend_reversal"

    return "undefined"


def classify_symbol(table, symbol: str, start_date: str, end_date: str):
    start = _date.fromisoformat(start_date)
    end = _date.fromisoformat(end_date)

    current = start
    count = 0
    deleted = 0

    while current <= end:
        date_str = current.isoformat()
        current += timedelta(days=1)

        if not is_trading_day(current - timedelta(days=1)):
            continue

        deleted += _delete_existing_predefined(table, symbol, date_str)

        try:
            y_date, dby_date = prior_trading_days(date_str, n=2)
        except Exception:
            logger.warning("Could not resolve prior trading days for %s", date_str)
            continue

        try:
            today_df = _load_or_fetch(symbol, date_str)
            y_df = _load_or_fetch(symbol, y_date)
            dby_df = _load_or_fetch(symbol, dby_date)
        except Exception as exc:
            logger.warning("Missing data for %s on %s or prior days: %s", symbol, date_str, exc)
            continue

        try:
            today_open = float(today_df.iloc[0]["open"])
            y_open = float(y_df.iloc[0]["open"])
            y_close = float(y_df.iloc[-1]["close"])
            dby_open = float(dby_df.iloc[0]["open"])
            dby_close = float(dby_df.iloc[-1]["close"])
        except (IndexError, KeyError):
            logger.warning("Incomplete data for %s on %s", symbol, date_str)
            continue

        opening_type = _classify_opening(today_open, y_open, y_close, dby_open, dby_close)
        midday_type = _classify_midday(today_df, date_str)
        closing_type = _classify_closing(today_df, date_str)

        item = {
            "chart_structure_id": str(uuid.uuid4()),
            "symbol": symbol,
            "date": date_str,
            "opening_type": opening_type,
            "midday_type": midday_type,
            "closing_type": closing_type,
            "is_predefined": True,
            "user_id": "__SYSTEM__",
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
        table.put_item(Item=item)
        count += 1

        if count % 50 == 0:
            logger.info("  %s: classified %d days so far (deleted %d old records)", symbol, count, deleted)

    logger.info("%s: done — %d classified, %d old records deleted", symbol, count, deleted)


def main():
    parser = argparse.ArgumentParser(description="Classify chart structures for NSE symbols")
    parser.add_argument("--symbol", default="ALL", help="Symbol or ALL")
    parser.add_argument("--start", required=True, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="End date YYYY-MM-DD")
    args = parser.parse_args()

    table = _get_db_table()

    symbols = ALL_SYMBOLS if args.symbol.upper() == "ALL" else [args.symbol.upper()]
    for sym in symbols:
        if sym not in ALL_SYMBOLS:
            logger.warning("Unknown symbol: %s — skipping", sym)
            continue
        logger.info("Classifying %s from %s to %s", sym, args.start, args.end)
        classify_symbol(table, sym, args.start, args.end)

    logger.info("All done.")


if __name__ == "__main__":
    main()
