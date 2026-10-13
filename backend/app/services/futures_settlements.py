"""Official exchange settlement evidence; an OHLC close is never substituted."""

import csv
import io
import threading
import time
import urllib.request
import uuid
import zipfile
from datetime import datetime

from app.config import DATA_DIR

_lock = threading.Lock()
_failures = {}


def settlement_from_csv(text, contract, day):
    from app.services.kite_service import _KITE_NAMES

    name = _KITE_NAMES.get(contract["symbol"], contract["symbol"])
    for row in csv.DictReader(io.StringIO(text)):
        if row.get("TradDt") and row["TradDt"] != day:
            continue
        symbol = row.get("TckrSymb") or row.get("SYMBOL") or row.get("Ticker")
        kind = row.get("FinInstrmTp") or row.get("INSTRUMENT")
        expiry = (
            row.get("FininstrmActlXpryDt") or row.get("XpryDt") or row.get("EXPIRY_DT")
        )
        if symbol != name or kind not in ("IDF", "STF", "FUTIDX", "FUTSTK"):
            continue
        for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y"):
            try:
                expiry = datetime.strptime(expiry, fmt).date().isoformat()
                break
            except (ValueError, TypeError):
                pass
        if expiry != contract["expiry"]:
            continue
        value = row.get("SttlmPric") or row.get("SETTLE_PR")
        try:
            price = float(value)
        except (ValueError, TypeError):
            continue
        from math import isfinite

        if isfinite(price) and price > 0:
            return {"date": day, "price": price, "source": "official exchange bhavcopy"}
    raise ValueError(
        "Official settlement evidence is unavailable for this exact contract"
    )


def official(contract, day):
    stamp = datetime.fromisoformat(day).strftime("%Y%m%d")
    exchange = contract["exchange"]
    name = (
        f"BhavCopy_{'BSE' if exchange == 'BFO' else 'NSE'}_FO_0_0_0_{stamp}_F_0000.csv"
        + ("" if exchange == "BFO" else ".zip")
    )
    url = (
        "https://www.bseindia.com/download/BhavCopy/Derivative/"
        if exchange == "BFO"
        else "https://nsearchives.nseindia.com/content/fo/"
    ) + name
    path = DATA_DIR / "futures-settlements" / exchange / name
    with _lock:
        if not path.exists():
            key = (exchange, day)
            if time.monotonic() < _failures.get(key, 0):
                raise ValueError("Official settlement publication is pending")
            try:
                request = urllib.request.Request(
                    url, headers={"User-Agent": "TradeMatangi/1.0"}
                )
                with urllib.request.urlopen(request, timeout=15) as response:
                    content = response.read()
                if exchange == "BFO":
                    header = content.decode("utf-8-sig").splitlines()[0]
                    if "SttlmPric" not in header or "FinInstrmTp" not in header:
                        raise ValueError("Exchange response has no settlement CSV")
                else:
                    with zipfile.ZipFile(io.BytesIO(content)) as archive:
                        if not any(
                            info.filename.lower().endswith(".csv")
                            for info in archive.infolist()
                        ):
                            raise ValueError("Exchange response has no settlement CSV")
                path.parent.mkdir(parents=True, exist_ok=True)
                temp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
                try:
                    temp.write_bytes(content)
                    temp.replace(path)
                finally:
                    temp.unlink(missing_ok=True)
            except Exception:
                _failures[key] = time.monotonic() + 300
                raise
    if exchange == "BFO":
        return {
            **settlement_from_csv(path.read_text(encoding="utf-8-sig"), contract, day),
            "source": url,
        }
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.filename.lower().endswith(".csv"):
                return {
                    **settlement_from_csv(
                        archive.read(info).decode("utf-8-sig"), contract, day
                    ),
                    "source": url,
                }
    raise ValueError("Official settlement CSV is unavailable")
