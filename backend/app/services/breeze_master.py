"""
Breeze security master loader.

The Breeze Security Master (FOBSEScripMaster.txt for BFO, FONSEScripMaster.txt
for NFO) maps each ScripCode → (strike_price, right, expiry). We need this
mapping at runtime because Breeze WS payloads include the ScripCode in the
raw `symbol` field (e.g. "8.1!855562") but do NOT carry right/strike_price
on BFO option streams.

The master is published daily at ~8:00 AM by Breeze at:
  https://directlink.icicidirect.com/NewSecurityMaster/SecurityMaster.zip

We download the master zip once per day, cache it under
<DATA_DIR>/ICICISecurityMaster/, and parse it for the requested strike/right.

Precedence when locating the master:
  1. <DATA_DIR>/ICICISecurityMaster/<file>.txt  (locally-extracted copy)
  2. <DATA_DIR>/ICICISecurityMaster/SecurityMaster.zip + extract
  3. Download from Breeze URL (only if cache is older than today's 8 AM)
"""
from __future__ import annotations

import csv
import logging
import urllib.request
import zipfile
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


_SECURITY_MASTER_URL = (
    "https://directlink.icicidirect.com/NewSecurityMaster/SecurityMaster.zip"
)

_OPTS_FILE_FOR_EXCHANGE = {
    "BFO": "FOBSEScripMaster.txt",
    "NFO": "FONSEScripMaster.txt",
}


def _master_cache_dir() -> Path:
    from app.config import DATA_DIR
    cache_dir = Path(DATA_DIR) / "ICICISecurityMaster"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _master_file_for_exchange(exchange_code: str) -> str:
    return _OPTS_FILE_FOR_EXCHANGE.get(exchange_code, "FONSEScripMaster.txt")


def _master_txt_path(exchange_code: str) -> Path:
    return _master_cache_dir() / _master_file_for_exchange(exchange_code)


def _master_zip_path() -> Path:
    return _master_cache_dir() / "SecurityMaster.zip"


def _daily_refresh_cutoff() -> datetime:
    """
    The Breeze Security Master is regenerated daily at 8:00 AM. We only
    re-download if the cache is older than today's 8 AM (i.e. we haven't
    yet picked up today's master).
    """
    now = datetime.now()
    return datetime.combine(now.date(), time(8, 0))


def _is_cache_fresh(zip_path: Path) -> bool:
    if not zip_path.exists():
        return False
    mtime = datetime.fromtimestamp(zip_path.stat().st_mtime)
    return mtime >= _daily_refresh_cutoff()


def ensure_security_master_downloaded(exchange_code: str) -> Optional[Path]:
    """
    Make sure the security master files are present and up-to-date for the
    given exchange (BFO or NFO). Returns the path to the extracted .txt file,
    or None on failure. Idempotent — runs at most one download per day.
    """
    target_txt = _master_txt_path(exchange_code)
    zip_path = _master_zip_path()

    if target_txt.exists() and _is_cache_fresh(zip_path):
        return target_txt

    if not _is_cache_fresh(zip_path):
        try:
            logger.info(
                "Breeze security master: downloading from %s (cache stale or missing)",
                _SECURITY_MASTER_URL,
            )
            urllib.request.urlretrieve(_SECURITY_MASTER_URL, zip_path)
        except Exception as exc:
            logger.warning(
                "Breeze security master download failed: %s — using existing cache if available",
                exc,
            )
            if target_txt.exists():
                return target_txt
            return None

    try:
        with zipfile.ZipFile(zip_path) as zf:
            opts_file = _master_file_for_exchange(exchange_code)
            if opts_file not in zf.namelist():
                logger.warning(
                    "Breeze security master zip missing %s — found: %s",
                    opts_file, zf.namelist(),
                )
                return None
            zf.extract(opts_file, _master_cache_dir())
        logger.info(
            "Breeze security master: extracted %s → %s",
            opts_file, target_txt,
        )
        return target_txt
    except Exception as exc:
        logger.warning("Breeze security master extract failed: %s", exc)
        return None


def load_breeze_security_master(
    stock_code: str,
    exchange_code: str,
    strike: int,
    right: str,
    expiry_breeze: str,
) -> dict[str, tuple[int, str]]:
    """
    Return a {ScripCode: (strike, right)} map of BFO/NFO option instruments
    matching the requested (stock_code, strike, right, expiry_breeze).

    Ensures the security master is downloaded (at most once per day) and
    parses the extracted file. Returns an empty dict if the file is missing
    or no matches are found.
    """
    master_txt = ensure_security_master_downloaded(exchange_code)
    if master_txt is None or not master_txt.exists():
        return {}

    scrip_map: dict[str, tuple[int, str]] = {}
    try:
        with open(master_txt, newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if (
                    row.get("ShortName", "").upper() != stock_code.upper()
                    or row.get("Series", "").upper() != "OPTION"
                ):
                    continue
                try:
                    if int(row.get("StrikePrice", "0")) != strike:
                        continue
                except ValueError:
                    continue
                if row.get("ExpiryDate", "").strip() != expiry_breeze:
                    continue
                if row.get("OptionType", "").strip().upper() != right.upper():
                    continue
                token = row.get("Token", "").strip()
                if token:
                    scrip_map[token] = (strike, right.upper())
    except Exception as exc:
        logger.debug("Breeze security master parse failed: %s", exc)
        return {}

    return scrip_map