#!/usr/bin/env python3
"""Pre-fetch the minute data the Patterns screens use, for a range of days, so Patterns opens instantly afterwards.

For every trading day in the range it does what the Patterns screen does for that day, with the same functions, so the
cache files it fills are exactly the ones the screen will ask for:

  1. the underlying's minute candles for the day and the context days before it;
  2. the CE and PE strikes for the day, picked at 09:30 (see below);
  3. those two contracts' minute candles for the day and the context days.

Strike pick (both are decided from data at 09:30 by default):
  --mode max-price   the first strike from ATM outwards whose premium at 09:30 is at or below the cap, separately for CE
                     and PE (the Settings "Max Price" button). The cap is one of 30, 50, 75 or 100 (--max-price for both,
                     --max-price-pe for a different PE cap). Indices only (NIFTY, BSESEN), like the screen.
  --mode otm         ATM from the 09:30 price, CE = ATM + offset steps, PE = ATM - offset steps (--otm-offset, default 0).
                     Note the Patterns screen itself takes ATM at 09:15; pass --atm-time 09:15 to match it exactly.

Data comes from the existing minute source (a complete second-level cache if there is one, else the minute cache, else
Kite, else Breeze 1-minute; expired options are Breeze only). Nothing is ever written under a second-level file name and no
second-level (Breeze tick) download is made. Files of finished days are final, so the script can be stopped and run again:
everything already fetched is reused.

STOP THE BACKEND FIRST (Breeze allows one session per login, and the script uses the same credentials). The script refuses to
start while something listens on the backend port unless --allow-running is given.

    source ~/venvs/tradematangi/bin/activate
    python scripts/fetch-patterns-data.py --symbol NIFTY --mode max-price --max-price 50 --months 3
    python scripts/fetch-patterns-data.py --symbol NIFTY --mode max-price --max-price 50 --max-price-pe 30 --start 2026-08-01 --end 2026-11-13
    python scripts/fetch-patterns-data.py --symbol BSESEN --mode otm --otm-offset 2 --months 4 --atm-time 09:15
    python scripts/fetch-patterns-data.py --symbol NIFTY --mode max-price --max-price 100 --months 3 --dry-run
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import socket
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

MAX_PRICES = (30, 50, 75, 100)
INDEX_SYMBOLS = ("NIFTY", "BSESEN")
log = logging.getLogger("fetch-patterns-data")


class Abort(Exception):
    """The run cannot continue (expired broker session, repeated failures)."""


@dataclass
class Plan:
    symbol: str
    mode: str
    cap_ce: float | None
    cap_pe: float | None
    offset: int
    pick_time: str
    atm_time: str
    context_days: int
    start: dt.date
    end: dt.date


@dataclass
class DayResult:
    date: str
    status: str = "ok"            # ok | no_data | partial | failed | skipped
    expiry: str | None = None
    price: float | None = None
    ce: int | float | None = None
    pe: int | float | None = None
    ce_premium: float | None = None
    pe_premium: float | None = None
    bars: dict = field(default_factory=dict)
    note: str = ""


# ------------------------------------------------------------------ dates and arguments
def parse_time(value: str) -> str:
    """HH:MM or HH:MM:SS to HH:MM:SS."""
    parts = value.split(":")
    if len(parts) not in (2, 3) or not all(p.isdigit() for p in parts):
        raise argparse.ArgumentTypeError(f"time must be HH:MM or HH:MM:SS, got {value!r}")
    hours, minutes = int(parts[0]), int(parts[1])
    seconds = int(parts[2]) if len(parts) == 3 else 0
    if not (0 <= hours < 24 and 0 <= minutes < 60 and 0 <= seconds < 60):
        raise argparse.ArgumentTypeError(f"time out of range: {value!r}")
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def parse_date(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"date must be YYYY-MM-DD, got {value!r}") from None


def months_back(end: dt.date, months: float) -> dt.date:
    """About `months` calendar months before `end` (30.44 days each)."""
    return end - dt.timedelta(days=round(months * 30.44))


def last_completed_day(today: dt.date | None = None) -> dt.date:
    """Yesterday: today's file is incomplete until the close, so it is not part of a default range."""
    return (today or dt.date.today()) - dt.timedelta(days=1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="NIFTY", help="NIFTY (default), BSESEN or an equity symbol (OTM mode only)")
    parser.add_argument("--mode", choices=("max-price", "otm"), required=True)
    parser.add_argument("--max-price", type=int, choices=MAX_PRICES, help="CE cap, and PE cap unless --max-price-pe is given (30, 50, 75 or 100)")
    parser.add_argument("--max-price-pe", type=int, choices=MAX_PRICES, help="a different cap for the PE side")
    parser.add_argument("--otm-offset", type=int, default=0, help="OTM mode: strikes away from ATM (CE up, PE down); a negative number is ITM (default 0)")
    parser.add_argument("--pick-time", type=parse_time, default="09:30:00", help="time the Max Price cap is checked at (default 09:30)")
    parser.add_argument("--atm-time", type=parse_time, default="09:30:00", help="time the ATM price is taken at in OTM mode (default 09:30; the Patterns screen uses 09:15)")
    parser.add_argument("--start", type=parse_date, help="first day (YYYY-MM-DD)")
    parser.add_argument("--end", type=parse_date, help="last day (default: yesterday)")
    parser.add_argument("--months", type=float, default=3.0, help="when --start is not given: this many months back from --end (default 3)")
    parser.add_argument("--context-days", type=int, default=2, help="prior trading days fetched with each day, like the Patterns 'historical days' setting (default 2)")
    parser.add_argument("--delay", type=float, default=0.3, help="seconds to pause between days (default 0.3)")
    parser.add_argument("--max-failures", type=int, default=8, help="stop after this many days in a row that failed (default 8)")
    parser.add_argument("--port", type=int, default=8700, help="backend port to check (default 8700)")
    parser.add_argument("--allow-running", action="store_true", help="do not refuse to start when the backend port is in use")
    parser.add_argument("--dry-run", action="store_true", help="list the days and what would be fetched; no data is requested")
    parser.add_argument("--report", type=Path, help="write a JSON report of every day to this file")
    return parser


def make_plan(args: argparse.Namespace) -> Plan:
    symbol = args.symbol.upper()
    if args.mode == "max-price":
        if symbol not in INDEX_SYMBOLS:
            raise SystemExit(f"Max Price mode is for {' and '.join(INDEX_SYMBOLS)} only (like the Patterns screen); use --mode otm for {symbol}.")
        if args.max_price is None:
            raise SystemExit("--max-price is required in max-price mode (30, 50, 75 or 100).")
    cap_ce = float(args.max_price) if args.max_price else None
    cap_pe = float(args.max_price_pe or args.max_price) if args.max_price else None
    end = args.end or last_completed_day()
    start = args.start or months_back(end, args.months)
    if start > end:
        raise SystemExit(f"--start {start} is after --end {end}.")
    if args.context_days < 0 or args.context_days > 10:
        raise SystemExit("--context-days must be between 0 and 10.")
    return Plan(symbol, args.mode, cap_ce, cap_pe, args.otm_offset, args.pick_time, args.atm_time, args.context_days, start, end)


def trading_days(start: dt.date, end: dt.date, is_trading_day) -> list[str]:
    days, current = [], start
    while current <= end:
        if is_trading_day(current):
            days.append(current.isoformat())
        current += dt.timedelta(days=1)
    return days


def backend_running(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


# ------------------------------------------------------------------ one day
class Deps:
    """The backend functions the script calls, in one place so tests can replace them."""

    def __init__(self) -> None:
        from app.services import desktop_preparation, minute_history, minute_ohlc, options_service
        from app.services.broker_service import BreezeTokenError

        self.BreezeTokenError = BreezeTokenError
        self.candle_records = minute_ohlc.candle_records
        self.load_minute = minute_history.load
        self.price_at = desktop_preparation.price_at
        self.find_max_price_strike = desktop_preparation.find_max_price_strike_minute
        self.get_expiry_date = options_service.get_expiry_date
        self.get_atm_strike = options_service.get_atm_strike
        self.strike_interval = options_service.STRIKE_INTERVALS


def _timestamp(date: str, time_text: str):
    import pandas as pd
    return pd.Timestamp(f"{date} {time_text}", tz="UTC")


def run_day(plan: Plan, date: str, deps) -> DayResult:
    """Fetch one day. Returns its result; raises Abort for an expired broker session."""
    result = DayResult(date)
    guarded = (deps.BreezeTokenError,)

    def fetch(label: str, *args, **contract) -> int | None:
        try:
            records = deps.candle_records(plan.symbol, date, 1, plan.context_days, **contract)
        except guarded as exc:
            raise Abort(f"The Breeze session has expired ({exc}). Log in to Breeze again, then run the script again; "
                        f"everything fetched so far is kept.") from exc
        except FileNotFoundError:
            result.note += f"{label}: no data; "
            return None
        except Exception as exc:  # noqa: BLE001 - one bad contract must not stop the whole run
            result.note += f"{label}: {exc}; "
            return None
        result.bars[label] = len(records)
        return len(records)

    if fetch("underlying") is None:
        result.status = "no_data" if "no data" in result.note else "failed"
        return result
    try:
        underlying = deps.load_minute(plan.symbol, date)
    except guarded as exc:
        raise Abort(f"The Breeze session has expired ({exc}).") from exc
    except Exception as exc:  # noqa: BLE001
        result.status, result.note = "failed", f"underlying reload: {exc}"
        return result

    result.expiry = deps.get_expiry_date(plan.symbol, date)
    step = deps.strike_interval.get(plan.symbol, 50)
    if plan.mode == "otm":
        price = deps.price_at(underlying, date, _timestamp(date, plan.atm_time))
        if price is None:
            result.status, result.note = "partial", f"no price at {plan.atm_time}"
            return result
        result.price = round(float(price), 2)
        atm = deps.get_atm_strike(plan.symbol, result.price)
        result.ce, result.pe = atm + plan.offset * step, atm - plan.offset * step
        picks = {"CE": result.ce, "PE": result.pe}
    else:
        picks = {}
        for right, cap in (("CE", plan.cap_ce), ("PE", plan.cap_pe)):
            try:
                found = deps.find_max_price_strike(plan.symbol, date, result.expiry, right, cap, plan.pick_time)
            except guarded as exc:
                raise Abort(f"The Breeze session has expired ({exc}). Log in to Breeze again, then run the script again.") from exc
            except ValueError as exc:
                result.note += f"{right}: {exc}; "
                continue
            except Exception as exc:  # noqa: BLE001 - FileNotFoundError, provider failure
                result.note += f"{right}: {exc}; "
                continue
            picks[right] = found["strike"]
            if right == "CE":
                result.ce, result.ce_premium = found["strike"], found["price"]
            else:
                result.pe, result.pe_premium = found["strike"], found["price"]

    for right, strike in picks.items():
        fetch(right, strike=strike, expiry=result.expiry, right=right)
    wanted = 3  # underlying + CE + PE
    result.status = "ok" if len(result.bars) == wanted else "partial"
    return result


# ------------------------------------------------------------------ the run
def describe(result: DayResult) -> str:
    def side(name, strike, premium):
        if strike is None:
            return f"{name} -"
        return f"{name} {strike}" + (f" @{premium:.2f}" if premium is not None else "")
    bars = " ".join(f"{k}:{v}" for k, v in result.bars.items())
    price = f" spot {result.price:.2f}" if result.price is not None else ""
    return f"{result.date}  {result.status:<8} exp {result.expiry or '-'}{price}  {side('CE', result.ce, result.ce_premium)}  {side('PE', result.pe, result.pe_premium)}  bars[{bars}] {result.note.strip()}"


def count_minute_files() -> int:
    from app.services import minute_history
    folder = minute_history.minute_folder()
    return sum(1 for _ in folder.rglob("*.parquet")) if folder.exists() else 0


def run(plan: Plan, args: argparse.Namespace, deps=None, days: list[str] | None = None, sleep=time.sleep) -> tuple[list[DayResult], int]:
    from app.utils import is_trading_day
    days = days if days is not None else trading_days(plan.start, plan.end, is_trading_day)
    print(f"{plan.symbol} {plan.mode}"
          + (f" CE<={plan.cap_ce:g} PE<={plan.cap_pe:g} at {plan.pick_time}" if plan.mode == "max-price" else f" offset {plan.offset} from ATM at {plan.atm_time}")
          + f", {len(days)} trading days {plan.start} .. {plan.end}, {plan.context_days} context days each")
    if args.dry_run:
        for day in days:
            print(f"  would fetch {day}")
        print("Dry run: nothing was requested.")
        return [], 0
    deps = deps or Deps()
    before = count_minute_files()
    results: list[DayResult] = []
    failures = 0
    started = time.monotonic()
    try:
        for i, day in enumerate(days, 1):
            result = run_day(plan, day, deps)
            results.append(result)
            print(f"[{i}/{len(days)}] {describe(result)}", flush=True)
            failures = failures + 1 if result.status == "failed" else 0
            if failures >= args.max_failures:
                raise Abort(f"{failures} days in a row failed; stopping (a provider problem, an expired session or no network). Run again later.")
            sleep(args.delay)
    except Abort as exc:
        print(f"\nSTOPPED: {exc}", file=sys.stderr)
        return results, 2
    except KeyboardInterrupt:
        print("\nInterrupted. What was fetched is kept; run the same command again to continue.", file=sys.stderr)
        return results, 130
    finally:
        added = count_minute_files() - before
        counts = {s: sum(1 for r in results if r.status == s) for s in ("ok", "partial", "no_data", "failed")}
        print(f"\nDone in {time.monotonic() - started:.0f}s: {counts['ok']} days complete, {counts['partial']} partial, {counts['no_data']} without data, "
              f"{counts['failed']} failed; {added} new minute files in the cache.")
        if args.report:
            args.report.write_text(json.dumps([r.__dict__ for r in results], indent=1, default=str))
    return results, 0 if not any(r.status == "failed" for r in results) else 1


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    plan = make_plan(args)
    if not args.dry_run and not args.allow_running and backend_running(args.port):
        print(f"Something is listening on port {args.port}: stop the backend first (scripts/stop-backend.sh), or pass --allow-running.", file=sys.stderr)
        return 3
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    _, code = run(plan, args)
    return code


if __name__ == "__main__":
    sys.exit(main())
