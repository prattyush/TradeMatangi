import pytest
import pandas as pd
import numpy as np
from datetime import datetime, timedelta


@pytest.fixture
def sample_df_ist():
    """1-minute second-level OHLC with tz-naive IST index (60 seconds)."""
    start = datetime(2026, 5, 6, 9, 15, 0)
    idx = pd.date_range(start, periods=60, freq="s")
    rng = np.random.default_rng(42)
    base = 24200.0
    data = {
        "open": base + rng.uniform(-5, 5, 60),
        "high": base + rng.uniform(0, 10, 60),
        "low": base + rng.uniform(-10, 0, 60),
        "close": base + rng.uniform(-5, 5, 60),
    }
    return pd.DataFrame(data, index=idx)
