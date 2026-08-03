#!/usr/bin/env python3
"""
End-to-end test that replicates exactly what the paper trading session does
with Breeze streaming.  Mirrors Phase 1 (historical fetch via REST) then
Phase 2 (live WebSocket subscription).

This is a diagnostic tool to isolate why the paper session's Phase 3
never receives ticks while the standalone test_broker_streaming.py does.
"""
import asyncio
import configparser
import json
import logging
import os
import signal
import sys
import time as _time
from datetime import date, datetime, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

DATA_DIR = Path(os.getenv("DATA_DIR", str(PROJECT_ROOT / "data")))
INI_PATH = DATA_DIR / "accesskeys.ini"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
_cfg = configparser.ConfigParser()
_cfg.read(str(INI_PATH))
LOG_DIR = Path(_cfg["paths"].get("logs", str(DATA_DIR / "logs")))
LOG_DIR.mkdir(parents=True, exist_ok=True)

logger = logging.getLogger("test_breeze_paper_flow")
logger.setLevel(logging.DEBUG)

fh = logging.FileHandler(str(LOG_DIR / "test_breeze_paper_flow.log"), encoding="utf-8")
fh.setLevel(logging.DEBUG)
fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))

ch = logging.StreamHandler(sys.stdout)
ch.setLevel(logging.INFO)
ch.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))

logger.addHandler(fh)
logger.addHandler(ch)

logger.info("=" * 60)
logger.info("BREEZE PAPER FLOW TEST — replicates paper session Phase 1+2")
logger.info("=" * 60)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
MARKET_OPEN = "09:15:00"
MARKET_CLOSE = "15:30:00"


def _get_breeze():
    """Same _get_breeze as broker_service, with caching."""
    from breeze_connect import BreezeConnect

    global _cached_breeze, _cached_creds_key
    creds = _read_breeze_credentials()
    creds_key = (creds["api_key"], creds["api_secret"], creds["session_token"])

    if _cached_breeze is not None and _cached_creds_key == creds_key:
        logger.info("_get_breeze: CACHE HIT — reusing existing BreezeConnect instance")
        return _cached_breeze

    logger.info("_get_breeze: creating new BreezeConnect instance...")
    breeze = BreezeConnect(api_key=creds["api_key"])
    logger.info("_get_breeze: calling generate_session()...")
    result = breeze.generate_session(
        api_secret=creds["api_secret"],
        session_token=creds["session_token"],
    )
    logger.info("_get_breeze: generate_session result=%s", result)
    _cached_breeze = breeze
    _cached_creds_key = creds_key
    return breeze


def _read_breeze_credentials():
    config = configparser.ConfigParser()
    config.read(INI_PATH)
    session_token = config["icicidirect"]["session_token"].strip()
    try:
        from app.services.token_service import get_token as _ddb_token
        ddb = _ddb_token("icici_session")
        if ddb:
            session_token = ddb
            logger.info("_read_breeze_credentials: using DDB token (icici_session)")
        else:
            logger.info("_read_breeze_credentials: DDB token not found, using accesskeys.ini value")
    except Exception as exc:
        logger.warning("_read_breeze_credentials: DDB read failed: %s — using accesskeys.ini", exc)
    return {
        "api_key": config["icicidirect"]["api_key"].strip(),
        "api_secret": config["icicidirect"]["api_secret"].strip(),
        "session_token": session_token,
    }


_cached_breeze = None
_cached_creds_key = None

# ---------------------------------------------------------------------------
# Phase 1: replicate what fetch_historical does
# ---------------------------------------------------------------------------

def phase1_fetch_historical():
    """Replicate Phase 1 — fetch today's equity data via REST."""
    import pandas as pd

    logger.info("=" * 40)
    logger.info("PHASE 1: Historical data fetch (REST API)")
    logger.info("=" * 40)

    breeze = _get_breeze()

    # Just do one chunk to test the REST API is working
    from_ts = pd.Timestamp(f"{date.today().isoformat()} {MARKET_OPEN}")
    to_ts = from_ts + pd.Timedelta(minutes=15)

    logger.info(
        "PHASE 1: fetching 15-min chunk: %s → %s",
        from_ts.strftime("%Y-%m-%d %H:%M:%S"),
        to_ts.strftime("%Y-%m-%d %H:%M:%S"),
    )
    try:
        response = breeze.get_historical_data_v2(
            interval="1second",
            from_date=from_ts.strftime("%Y-%m-%d %H:%M:%S"),
            to_date=to_ts.strftime("%Y-%m-%d %H:%M:%S"),
            stock_code="NIFTY",
            exchange_code="NSE",
            product_type="cash",
        )
        status = response.get("Status") if response else None
        error = response.get("Error") if response else "None response"
        n_records = len(response.get("Success", [])) if response and "Success" in response else 0
        logger.info("PHASE 1: response Status=%s Error=%s record_count=%d", status, error, n_records)
    except Exception as exc:
        logger.warning("PHASE 1: fetch_historical failed (non-fatal): %s", exc)

    logger.info("PHASE 1: complete — BreezeConnect cached for Phase 2")


# ---------------------------------------------------------------------------
# Phase 2: replicate BreezeStreamManager WebSocket
# ---------------------------------------------------------------------------

async def phase2_websocket_streaming():
    """Replicate Phase 2 — set up WebSocket with the same BreezeConnect."""
    logger.info("=" * 40)
    logger.info("PHASE 2: WebSocket streaming setup")
    logger.info("=" * 40)

    breeze = _get_breeze()
    logger.info("PHASE 2: got BreezeConnect (cached from Phase 1? %s)",
                "yes" if _cached_breeze is breeze else "NO - this is a NEW instance")

    # Log the session state
    logger.info("PHASE 2: breeze.user_id=%s", getattr(breeze, "user_id", "NOT SET"))
    logger.info("PHASE 2: breeze.session_key=%s", getattr(breeze, "session_key", "NOT SET")[:16] + "..." if getattr(breeze, "session_key", None) else "NOT SET")
    logger.info("PHASE 2: breeze.sio_rate_refresh_handler=%s", getattr(breeze, "sio_rate_refresh_handler", "NONE"))

    # Set up a tick callback
    tick_count = [0]

    def on_tick(tick_data):
        tick_count[0] += 1
        if isinstance(tick_data, str):
            try:
                tick_data = json.loads(tick_data)
            except Exception:
                pass
        if isinstance(tick_data, dict):
            name = tick_data.get("stock_name", "?")
            ltp = tick_data.get("last", tick_data.get("ltp", 0))
            right = tick_data.get("right", "")
            exchange = tick_data.get("exchange", "")
            logger.info(
                "PHASE 2 TICK #%d: name=%s exchange=%s ltp=%s right=%s",
                tick_count[0], name, exchange, ltp, right,
            )
        elif isinstance(tick_data, list):
            logger.info(
                "PHASE 2 TICK #%d: list with %d items", tick_count[0], len(tick_data),
            )
        else:
            raw = str(tick_data)[:200]
            logger.info("PHASE 2 TICK #%d: type=%s raw=%s", tick_count[0], type(tick_data).__name__, raw)

    breeze.on_ticks = on_tick
    logger.info("PHASE 2: on_ticks set to on_tick callback (id=%s)", id(on_tick))

    # Call ws_connect
    logger.info("PHASE 2: calling ws_connect()...")
    breeze.ws_connect()
    logger.info("PHASE 2: ws_connect() returned")

    # Log handler state
    handler = getattr(breeze, "sio_rate_refresh_handler", None)
    logger.info("PHASE 2: sio_rate_refresh_handler=%s", handler)
    if handler:
        logger.info("PHASE 2: handler.sio.connected=%s", getattr(handler, "sio", None) and handler.sio.connected if handler else "N/A")

    # Subscribe to NIFTY index
    logger.info("PHASE 2: subscribing NIFTY index (NSE, cash)...")
    result = breeze.subscribe_feeds(
        exchange_code="NSE",
        stock_code="NIFTY",
        product_type="cash",
        expiry_date="",
        strike_price="",
        right="",
        get_exchange_quotes=True,
        get_market_depth=False,
    )
    logger.info("PHASE 2: subscribe result=%s", result)

    # Wait for ticks
    logger.info("PHASE 2: waiting for ticks (15 seconds)...")
    for i in range(30):
        await asyncio.sleep(0.5)
        if tick_count[0] > 0:
            logger.info("PHASE 2: got %d ticks — STREAMING IS WORKING", tick_count[0])
            break
        if i % 10 == 9:
            logger.info("PHASE 2: still waiting... (%d ticks so far)", tick_count[0])
    else:
        if tick_count[0] == 0:
            logger.error("PHASE 2: NO TICKS RECEIVED in 15 seconds")
            logger.error("PHASE 2: handler.sio.connected=%s",
                         handler.sio.connected if handler and handler.sio else "UNKNOWN")

    # Clean up
    logger.info("PHASE 2: cleaning up...")
    try:
        breeze.ws_disconnect()
    except Exception as exc:
        logger.warning("PHASE 2: ws_disconnect error: %s", exc)

    logger.info("PHASE 2: complete — total ticks=%d", tick_count[0])
    return tick_count[0] > 0


# ---------------------------------------------------------------------------
# Test 2: Phase 2 ALONE (no Phase 1, like the test script)
# ---------------------------------------------------------------------------

async def phase2_alone():
    """Run Phase 2 WebSocket WITHOUT Phase 1 preceding it."""
    global _cached_breeze, _cached_creds_key
    _cached_breeze = None
    _cached_creds_key = None

    logger.info("=" * 40)
    logger.info("TEST: Phase 2 ALONE (no Phase 1)")
    logger.info("=" * 40)

    breeze = _get_breeze()
    logger.info("TEST: got BreezeConnect (CACHED=%s)", "no, first call" if _cached_breeze is not None else "n/a")

    tick_count = [0]

    def on_tick(tick_data):
        tick_count[0] += 1
        if isinstance(tick_data, dict):
            ltp = tick_data.get("last", tick_data.get("ltp", 0))
            name = tick_data.get("stock_name", "?")
            logger.info("TEST TICK #%d: name=%s ltp=%s", tick_count[0], name, ltp)
        else:
            logger.info("TEST TICK #%d: type=%s raw=%s", tick_count[0], type(tick_data).__name__, str(tick_data)[:200])

    breeze.on_ticks = on_tick
    breeze.ws_connect()

    result = breeze.subscribe_feeds(
        exchange_code="NSE",
        stock_code="NIFTY",
        product_type="cash",
        expiry_date="",
        strike_price="",
        right="",
        get_exchange_quotes=True,
        get_market_depth=False,
    )
    logger.info("TEST: subscribe result=%s", result)

    logger.info("TEST: waiting for ticks (10 seconds)...")
    for i in range(20):
        await asyncio.sleep(0.5)
        if tick_count[0] > 0:
            logger.info("TEST: got %d ticks — STREAMING IS WORKING (alone)", tick_count[0])
            break
        if i % 8 == 7:
            logger.info("TEST: still waiting... (%d ticks so far)", tick_count[0])
    else:
        if tick_count[0] == 0:
            logger.error("TEST: NO TICKS RECEIVED in 10 seconds (even WITHOUT Phase 1)")

    try:
        breeze.ws_disconnect()
    except Exception:
        pass

    logger.info("TEST: complete — total ticks=%d", tick_count[0])
    return tick_count[0] > 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    print("\n" + "=" * 60)
    print("BREEZE PAPER FLOW DIAGNOSTIC")
    print("=" * 60)
    print("Test 1: Phase 1 (REST fetch) → Phase 2 (WebSocket)")
    print("Test 2: Phase 2 alone (no Phase 1)")
    print()

    # Test 1: Phase 1 → Phase 2
    phase1_fetch_historical()
    _time.sleep(1)
    ok1 = await phase2_websocket_streaming()

    # Reset cache
    global _cached_breeze, _cached_creds_key
    _cached_breeze = None
    _cached_creds_key = None

    _time.sleep(2)

    # Test 2: Phase 2 alone
    ok2 = await phase2_alone()

    print()
    print("=" * 60)
    print(f"RESULTS:")
    print(f"  Phase1→Phase2  streaming: {'✅ WORKS' if ok1 else '❌ FAILS'}")
    print(f"  Phase2-alone   streaming: {'✅ WORKS' if ok2 else '❌ FAILS'}")
    print("=" * 60)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Interrupted")
    except Exception as exc:
        logger.exception("Fatal: %s", exc)
