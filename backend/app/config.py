import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR.parent / "data")))

PORT = int(os.getenv("PORT", "8700"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "info")

DEFAULT_SYMBOL = "NIFTY"
DEFAULT_DATE = "2026-05-06"
TRADING_DATE = "2026-05-06"
PRIOR_DATES = ["2026-05-04", "2026-05-05"]

MARKET_OPEN = "09:15:00"
MARKET_CLOSE = "15:30:00"

CANDLE_INTERVAL_MINUTES = 3

PLACEHOLDER_USER_ID = "00000000-0000-0000-0000-000000000001"
