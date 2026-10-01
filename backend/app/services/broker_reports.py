"""Normalize broker facts without borrowing contract identity from chart settings."""
from __future__ import annotations
import calendar
import math
import re
from datetime import datetime
from zoneinfo import ZoneInfo


class UnknownContractError(ValueError):
    pass


def number(value, default=0):
    if value in (None, "", "NA", "-", "--"):
        return default
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Nonfinite broker number")
    return result


def wall_time(value: str) -> int:
    """Broker IST wall clock encoded as UTC, matching chart/trade timestamps."""
    value = str(value or "").strip()
    for fmt in ("%d-%b-%Y %H:%M:%S", "%d/%m/%Y %H:%M:%S", "%d-%m-%Y %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return calendar.timegm(datetime.strptime(value, fmt).timetuple())
        except ValueError:
            pass
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"Cannot parse broker timestamp: {value!r}") from exc
    if dt.tzinfo:
        dt = dt.astimezone(ZoneInfo("Asia/Kolkata")).replace(tzinfo=None)
    return calendar.timegm(dt.timetuple())


def expiry_date(value) -> str | None:
    value = str(value or "").strip()
    if value in ("", "NA", "-", "--"):
        return None
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d%b%Y", "%d/%m/%Y", "%d-%m-%Y", "%d%b%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(value.split("T")[0].split(" ")[0], fmt).date().isoformat()
        except ValueError:
            pass
    return None


def normalize_order(raw: dict) -> dict:
    side = str(raw.get("trnsTp") or raw.get("side") or "B").upper()
    kind = str(raw.get("prcTp") or raw.get("order_type") or "L").upper()
    result = {
        "kotak_order_id": str(raw.get("nOrdNo") or raw.get("kotak_order_id") or ""),
        "status": str(raw.get("ordSt") or raw.get("status") or raw.get("stat") or "").strip().lower().replace("_", " "),
        "side": "BUY" if side in ("B", "BUY") else "SELL",
        "symbol": str(raw.get("trdSym") or raw.get("symbol") or raw.get("sym") or "").strip(),
        "underlying": str(raw.get("sym") or raw.get("underlying") or "").strip(),
        "exchange": str(raw.get("exSeg") or raw.get("exchange") or "").strip().lower(),
        "quantity": int(number(raw.get("qty", raw.get("quantity")))),
        "filled_quantity": int(number(raw.get("fldQty") or raw.get("flQty") or raw.get("filled_quantity"))),
        "limit_price": number(raw.get("prc", raw.get("limit_price"))),
        "trigger_price": number(raw.get("trgPrc", raw.get("trigger_price"))),
        "filled_price": number(raw.get("avgPrc") or raw.get("flPrc") or raw.get("filled_price")),
        "order_type": {"L": "LIMIT", "MKT": "MARKET"}.get(kind, kind),
        "order_time": str(raw.get("ordDtTm") or raw.get("ordEntTm") or raw.get("order_time") or ""),
        "product": str(raw.get("prod") or raw.get("product") or "MIS"),
        "reject_reason": str(raw.get("rejRsn") or raw.get("rjRsn") or raw.get("rejectionReason") or raw.get("reject_reason") or ""),
        "right": str(raw.get("optTp") or raw.get("right") or "").strip().upper() or None,
        "strike": int(number(raw.get("stkPrc") or raw.get("strike"))) or None,
        "expiry": expiry_date(raw.get("expDt") or raw.get("expiry")),
        "instrument_token": str(raw.get("tok") or raw.get("instrument_token") or ""),
    }

    if result["status"] in ("complete", "filled") and not result["filled_quantity"]:
        result["filled_quantity"] = result["quantity"]
    return result


def normalize_execution(raw: dict) -> dict:
    result = normalize_order(raw)
    result.update(execution_id=str(raw.get("flId") or raw.get("execution_id") or ""),
                  execution_time=str(raw.get("execution_time") or (
                      f'{raw.get("flDt", "")} {raw.get("flTm", "")}'.strip()) or raw.get("exTm") or raw.get("hsUpTm") or ""),
                  quantity=int(number(raw.get("fldQty") or raw.get("flQty") or raw.get("quantity"))),
                  price=number(raw.get("flPrc") or raw.get("price") or raw.get("avgPrc")))
    if not result["execution_id"] or not result["kotak_order_id"] or result["quantity"] <= 0 or result["price"] <= 0:
        raise ValueError("Broker execution is missing identity, quantity or price")
    result["timestamp"] = wall_time(result["execution_time"])
    return result


def in_scope(session, row: dict) -> bool:
    from app.services.kotak_service import _SYMBOL_MAP
    symbol = str(row.get("symbol", "")).upper()
    if session.instrument_type != "options":
        expected = _SYMBOL_MAP.get(session.symbol, (session.symbol, ""))[0].upper()
        return symbol == expected
    base = "SENSEX" if session.symbol == "BSESEN" else session.symbol.upper()
    return bool(re.fullmatch(re.escape(base) + r"\d{2}(?:[1-9OND]\d{2}|[A-Z]{3})\d+(?:CE|PE)", symbol))


def contract(session, row: dict, master=None) -> dict:
    if session.instrument_type != "options":
        return {"right": None, "strike": None, "expiry": None}
    symbol = row["symbol"].upper()
    base = "SENSEX" if session.symbol == "BSESEN" else session.symbol.upper()
    weekly = re.fullmatch(re.escape(base) + r"(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)", symbol)
    if weekly:
        year, month, day, strike, right = weekly.groups()
        month_number = {"O": 10, "N": 11, "D": 12}.get(month, int(month) if month.isdigit() else 0)
        expiry = datetime(2000 + int(year), month_number, int(day)).date().isoformat()
        return {"right": right, "strike": int(strike), "expiry": expiry}
    metadata = row
    if not metadata.get("expiry") and master:
        metadata = next((r for r in master if str(r.get("symbol", "")).upper() == symbol), row)
    monthly = re.fullmatch(re.escape(base) + r"(\d{2})([A-Z]{3})(\d+)(CE|PE)", symbol)
    if monthly and metadata.get("expiry"):
        year, month, strike, right = monthly.groups()
        expiry = expiry_date(metadata["expiry"])
        if expiry and datetime.fromisoformat(expiry).strftime("%y%b").upper() == (year + month):
            return {"right": right, "strike": int(strike), "expiry": expiry}
    raise UnknownContractError(f"Cannot resolve exact broker expiry for {symbol}")
