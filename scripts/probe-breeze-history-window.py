"""Read-only Breeze window probe; saves sanitized summaries, never tokens/rows.

Example: project-python scripts/probe-breeze-history-window.py --date 2026-10-13
Runs eight paced history reads and authenticates once using the DDB Local token.
Does not connect sockets, submit orders or update caches/DynamoDB.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
from importlib.metadata import version
import logging
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True)
    parser.add_argument("--output", default=".cache/breeze-history/window-probe.json")
    args = parser.parse_args()
    from app.config import USE_DYNAMODB_LOCAL, SUPPORTED_SYMBOLS, get_market_close
    if not USE_DYNAMODB_LOCAL:
        raise SystemExit("This probe requires USE_DYNAMODB_LOCAL=true")
    from app.services.db import get_dynamodb_resource
    # Direct read: do not create a token table or silently use a file token.
    token = get_dynamodb_resource().Table("BrokerTokens").get_item(
        Key={"pk": "config", "sk": "icici_session"}, ConsistentRead=True
    ).get("Item", {}).get("value")
    if not token:
        raise SystemExit("DDB Local Breeze token is absent; no broker calls made")
    from app.services.broker_service import _get_breeze, _read_breeze_credentials
    from app.services.breeze_history import request_history
    import requests
    import time
    credentials = _read_breeze_credentials()
    if credentials["session_token"] != token:
        raise SystemExit("Credential source mismatch; no broker calls made")
    original_request = requests.Session.request
    def bounded_request(session, *params, **kwargs):
        kwargs.setdefault("timeout", 30)
        return original_request(session, *params, **kwargs)

    start = datetime.fromisoformat(args.date + "T09:15:00")
    close = datetime.fromisoformat(args.date + "T" + get_market_close(args.date))
    windows = [(f"reference_{i + 1}", start + timedelta(minutes=15*i), start + timedelta(minutes=15*(i+1))) for i in range(4)]
    windows += [("candidate_16m30s", start, start + timedelta(minutes=16, seconds=30)),
                ("candidate_30m", start, start + timedelta(minutes=30)),
                ("candidate_60m", start, start + timedelta(minutes=60)),
                ("candidate_full_day", start, close)]
    result = {"tested_at_utc": datetime.now(timezone.utc).isoformat(), "date": args.date,
              "symbol": "NIFTY", "interval": "1second", "token_source": "DDB Local",
              "sdk_version": version('breeze-connect'),
              "requests": []}
    reference = set()
    original_logging = logging.root.manager.disable
    logging.disable(logging.CRITICAL)  # SDK errors must not expose auth headers.
    try:
        with patch.object(requests.Session, "request", bounded_request):
            breeze = _get_breeze()
            sym = SUPPORTED_SYMBOLS["NIFTY"]
            for name, first, last in windows:
                before = time.monotonic()
                response = request_history(breeze, interval="1second",
                    from_date=first.strftime("%Y-%m-%d %H:%M:%S"),
                    to_date=last.strftime("%Y-%m-%d %H:%M:%S"),
                    stock_code=sym["breeze_stock_code"], exchange_code=sym["exchange_code"],
                    product_type=sym["product_type"])
                rows = (response or {}).get("Success") or []
                timestamps = set()
                for row in rows:
                    raw = row.get("datetime") or row.get("date") or row.get("time")
                    if raw:
                        timestamps.add(datetime.fromisoformat(str(raw)).replace(tzinfo=None))
                entry = dict(name=name, requested_from=first.isoformat(), requested_to=last.isoformat(),
                    status=(response or {}).get("Status"), has_error=bool((response or {}).get("Error")),
                    duration_seconds=round(time.monotonic()-before, 3), rows=len(rows),
                    unique_seconds=len(timestamps), first_returned=min(timestamps).isoformat() if timestamps else None,
                    last_returned=max(timestamps).isoformat() if timestamps else None,
                    outside_requested_window=sum(not first <= stamp <= last for stamp in timestamps))
                if name.startswith("reference"):
                    reference.update(timestamps)
                else:
                    expected = {stamp for stamp in reference if first <= stamp <= last}
                    missing = expected - timestamps
                    entry.update(reference_seconds=len(expected), missing_reference_seconds=len(missing),
                                 first_missing_reference=min(missing).isoformat() if missing else None)
                result["requests"].append(entry)
                print(json.dumps(entry), flush=True)
                if entry["has_error"] or entry["status"] not in (200, None) or not rows:
                    result["aborted"] = "No usable data; avoiding further calls"
                    break
    except Exception as exc:
        result["failure_type"] = type(exc).__name__  # Never serialize broker exceptions/tokens.
        print("Probe failed: " + type(exc).__name__, flush=True)
    finally:
        logging.disable(original_logging)
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(result, indent=2) + "\n")
        print("Saved sanitized results: " + str(target), flush=True)
    return 1 if result.get("failure_type") or result.get("aborted") else 0


if __name__ == "__main__":
    raise SystemExit(main())
