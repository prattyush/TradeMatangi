import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR.parent / "data")))

PORT = int(os.getenv("PORT", "8700"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "info")

DEFAULT_SYMBOL = "NIFTY"

MARKET_OPEN = "09:15:00"
MARKET_CLOSE = "15:30:00"

CANDLE_INTERVAL_MINUTES = 3

PLACEHOLDER_USER_ID = "00000000-0000-0000-0000-000000000001"

# DynamoDB — set USE_DYNAMODB_LOCAL=false to target real AWS DynamoDB
USE_DYNAMODB_LOCAL = os.getenv("USE_DYNAMODB_LOCAL", "true").lower() == "true"
DYNAMODB_LOCAL_ENDPOINT = os.getenv("DYNAMODB_LOCAL_ENDPOINT", "http://localhost:8000")
DYNAMODB_REGION = os.getenv("DYNAMODB_REGION", "us-east-1")

# Supported symbols: key is the canonical ID used throughout the system
SUPPORTED_SYMBOLS: dict[str, dict] = {
    "NIFTY": {
        "display_name": "NIFTY 50",
        "exchange_code": "NSE",
        "breeze_stock_code": "NIFTY",
        "product_type": "cash",
    },
    "TATAPOWER": {
        "display_name": "Tata Power",
        "exchange_code": "NSE",
        "breeze_stock_code": "TATAPOWER",
        "product_type": "cash",
    },
    "TATAMOTORS": {
        "display_name": "Tata Motors",
        "exchange_code": "NSE",
        "breeze_stock_code": "TATAMOTORS",
        "product_type": "cash",
    },
    "RELIANCE": {
        "display_name": "Reliance Industries",
        "exchange_code": "NSE",
        "breeze_stock_code": "RELIANCE",
        "product_type": "cash",
    },
}
