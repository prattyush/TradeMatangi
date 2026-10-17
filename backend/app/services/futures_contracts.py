"""Exact monthly equity/index Futures metadata. This module never places orders."""

import csv
import json
import math
import time
import uuid
from datetime import UTC, date, datetime

from app.config import DATA_DIR, SUPPORTED_SYMBOLS


def _expiry(value, provider):
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d%b%Y", "%d-%b-%Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    # Kotak *_fo master epoch conversion, matching installed SDK 3.0.7 scrip_search.
    if provider == "kotak":
        value = float(text)
        if math.isfinite(value) and value > 0:
            return datetime.fromtimestamp(value + 315511200, UTC).date().isoformat()
    raise ValueError("Unrecognized listed expiry")


def parse_contracts(symbol, provider, rows, as_of):
    if provider not in ("kite", "kotak"):
        raise ValueError("Futures metadata supports Kite and Kotak")
    definition = SUPPORTED_SYMBOLS.get(symbol)
    if not definition:
        raise ValueError("Unsupported Futures underlying")
    from app.services.kite_service import _KITE_NAMES

    name = _KITE_NAMES.get(symbol, symbol).upper()
    exchange = "BFO" if symbol == "BSESEN" else "NFO"
    segment = "bse_fo" if exchange == "BFO" else "nse_fo"
    index = bool(definition.get("options_only"))
    result = {}
    for row in rows:
        kind = str(row.get("instrument_type", "")).upper()
        if kind not in ("FUT", "FUTIDX", "FUTSTK"):
            continue
        if str(row.get("name", "")).upper() != name:
            continue
        if row.get("exchange") != (exchange if provider == "kite" else segment):
            continue
        if kind == "FUTIDX" and not index or kind == "FUTSTK" and index:
            continue
        try:
            expiry = _expiry(row.get("expiry"), provider)
            lots = float(row.get("lot_size"))
            tick = float(row.get("tick_size"))
            if not math.isfinite(lots) or not lots.is_integer() or lots <= 0:
                continue
            if not math.isfinite(tick) or tick <= 0:
                continue
            if date.fromisoformat(expiry) < as_of:
                continue
        except (TypeError, ValueError, OverflowError, OSError):
            continue
        token = row.get("instrument_token")
        trading_symbol = (
            row.get("tradingsymbol") if provider == "kite" else row.get("symbol")
        )
        if not token or not trading_symbol:
            continue
        contract = {
            "instrument_type": "futures",
            "symbol": symbol,
            "exchange": exchange,
            "expiry": expiry,
            "lot_size": int(lots),
            "tick_size": tick,
            "category": "index" if index else "stock",
            "provider": provider,
            "instrument_token": str(token),
            "trading_symbol": trading_symbol,
        }
        previous = result.get(expiry)
        if previous and previous != contract:
            raise ValueError("Ambiguous Futures master; exact contract needs review")
        result[expiry] = contract
    contracts = sorted(result.values(), key=lambda row: row["expiry"])
    near_expiry = (
        bool(contracts)
        and (date.fromisoformat(contracts[0]["expiry"]) - as_of).days <= 7
    )
    for index, contract in enumerate(contracts):
        contract["entry_eligible"] = index == 0 or index == 1 and near_expiry
    return contracts


def listed_contracts(symbol, provider, as_of):
    if symbol not in SUPPORTED_SYMBOLS:
        raise ValueError("Unsupported Futures underlying")
    exchange = "BFO" if symbol == "BSESEN" else "NFO"
    if provider == "kite":
        from app.services import kite_service

        path = DATA_DIR / f"kite_instruments_{exchange}.csv"
        if not path.exists() or time.time() - path.stat().st_mtime > 86400:
            kite_service._refresh_instruments_cache(exchange, path)
        with path.open(newline="") as handle:
            rows = list(csv.DictReader(handle))
    elif provider == "kotak":
        from app.services import kotak_history, kotak_service

        client = kotak_history._get_client()
        rows = kotak_service._get_kotak_instruments(client=client)
        # Upgrade legacy master caches that omitted Futures lot/tick metadata.
        if any(
            row.get("instrument_type") in ("FUTIDX", "FUTSTK", "FUT")
            and not row.get("lot_size")
            for row in rows
        ):
            rows = kotak_service._load_kotak_master_from_api(client=client)
    else:
        raise ValueError("Futures metadata supports Kite and Kotak")
    if not rows:
        raise RuntimeError("Futures instrument master is unavailable")
    contracts = parse_contracts(symbol, provider, rows, as_of)
    for contract in contracts:
        path = archive_path(symbol, contract["expiry"], provider)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(json.dumps(contract))
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return contracts


def archive_path(symbol, expiry, provider):
    if symbol not in SUPPORTED_SYMBOLS or provider not in ("kite", "kotak"):
        raise ValueError("Unsupported Futures identity")
    expiry = date.fromisoformat(expiry).isoformat()
    return DATA_DIR / "futures-contracts" / provider / symbol / f"{expiry}.json"


def resolve_contract(symbol, expiry, provider, *, historical=False):
    from app.services.swing_market import today

    current = date.fromisoformat(today())
    expired = date.fromisoformat(expiry) < current
    if expired:
        if not historical:
            raise ValueError(
                "Expired Futures require settlement reconciliation, not live entry"
            )
        path = archive_path(symbol, expiry, provider)
        if not path.exists():
            raise ValueError("Archived exact Futures metadata is unavailable")
        # Purged/reused Kite tokens cannot safely establish new expired-contract history.
        raise ValueError(
            "Use captured contract history or exact-expiry provider history for expired Futures"
        )
    contract = next(
        (
            row
            for row in listed_contracts(symbol, provider, current)
            if row["expiry"] == expiry
        ),
        None,
    )
    if contract is None:
        raise ValueError("Exact Futures contract is not listed by this provider")
    return contract
