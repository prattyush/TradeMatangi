import configparser
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR.parent / "data")))

# Read [paths] from accesskeys.ini so data locations are configurable without
# code changes. Falls back to DATA_DIR sub-dirs when the section is absent.
_cfg = configparser.ConfigParser()
_cfg.read(str(DATA_DIR / "accesskeys.ini"))
_paths = _cfg["paths"] if _cfg.has_section("paths") else {}

OHLCDATA_DIR = Path(_paths.get("ohlcdata", str(DATA_DIR / "ohlcdata")))
LOG_DIR = Path(_paths.get("logs", str(DATA_DIR / "logs")))

PORT = int(os.getenv("PORT", "8700"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "info")

DEFAULT_SYMBOL = "NIFTY"

MARKET_OPEN = "09:15:00"
MARKET_CLOSE = "15:30:00"

CANDLE_INTERVAL_MINUTES = 3

FIXED_USER_ID = "abc12300-0000-0000-0000-000000000001"

# DynamoDB — set USE_DYNAMODB_LOCAL=false to target real AWS DynamoDB
USE_DYNAMODB_LOCAL = os.getenv("USE_DYNAMODB_LOCAL", "true").lower() == "true"
DYNAMODB_LOCAL_ENDPOINT = os.getenv("DYNAMODB_LOCAL_ENDPOINT", "http://localhost:8000")
DYNAMODB_REGION = os.getenv("DYNAMODB_REGION", "us-east-1")

# Options lot sizes — hardcoded current values; update manually if SEBI revises
LOT_SIZES: dict[str, int] = {
    "NIFTY": 65,
    "BSESEN": 20,
    "RELIND": 250,
    "TATMOT": 1400,
    "TATPOW": 2700,
}

# Default FundsRatio percentages (0–100 scale); user can override in Settings
DEFAULT_FUNDS_RATIOS: dict[str, float] = {"l": 3.0, "m": 6.0, "h": 12.0}

# Supported symbols: key is the canonical ID used throughout the system.
# options_exchange_code: exchange used for F&O data (NFO for NSE, BFO for BSE).
# options_only: True for indices that cannot be traded as equity.
# Kotak Neo real-trading: price slippage applied to immediate buy/sell
# A BUY limit is placed at LTP × (1 + KOTAK_SLIPPAGE_PCT) to guarantee fill.
# A SELL limit is placed at LTP × (1 − KOTAK_SLIPPAGE_PCT).
KOTAK_SLIPPAGE_PCT: float = 0.005  # 0.5%

SUPPORTED_SYMBOLS: dict[str, dict] = {
    "NIFTY": {
        "display_name": "NIFTY 50",
        "exchange_code": "NSE",
        "breeze_stock_code": "NIFTY",
        "product_type": "cash",
        "options_exchange_code": "NFO",
        "options_only": True,
    },
    "BSESEN": {
        "display_name": "SENSEX",
        "exchange_code": "BSE",
        "breeze_stock_code": "BSESEN",
        "product_type": "cash",
        "options_exchange_code": "BFO",
        "options_only": True,
    },
    "TATPOW": {
        "display_name": "Tata Power",
        "exchange_code": "NSE",
        "breeze_stock_code": "TATPOW",
        "product_type": "cash",
        "options_exchange_code": "NFO",
        "options_only": False,
    },
    "TATMOT": {
        "display_name": "Tata Motors CV",  # post-Apr-2025 demerger: CV entity (NSE: TMCV); Breeze code: TATCOV
        "exchange_code": "NSE",
        "breeze_stock_code": "TATCOV",     # TATMOT in Breeze = Tata Motors PV (passenger vehicles); CV is TATCOV
        "product_type": "cash",
        "options_exchange_code": "NFO",
        "options_only": False,
    },
    "RELIND": {
        "display_name": "Reliance Industries",
        "exchange_code": "NSE",
        "breeze_stock_code": "RELIND",
        "product_type": "cash",
        "options_exchange_code": "NFO",
        "options_only": False,
    },
}
