import pytest
import pandas as pd
import numpy as np


@pytest.fixture(autouse=True)
def isolated_kotak_report_pacing(monkeypatch):
    """Broker mocks do not need production sleeps; pacing tests override this."""
    from app.services import kotak_reports, kotak_protection
    monkeypatch.setattr(kotak_protection, "_closing", False)
    monkeypatch.setattr(kotak_reports, "MIN_INTERVAL", 0)
    kotak_reports._accounts.clear()
    yield
    kotak_reports._accounts.clear()
from datetime import datetime, timedelta


@pytest.fixture(autouse=True)
def isolated_history_throttle(monkeypatch):
    """No real pacing delays or cooldown state shared between broker mocks."""
    from app.services import breeze_history, options_service
    monkeypatch.setattr(breeze_history, "_MIN_INTERVAL", 0.0)
    monkeypatch.setattr(breeze_history, "_next_request", 0.0)
    monkeypatch.setattr(breeze_history, "_retry_after", 0.0)
    options_service._options_fetch_failures.clear()
    yield
    options_service._options_fetch_failures.clear()


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


@pytest.fixture(autouse=True)
def isolated_protection_journal(monkeypatch):
    """New protection/cancel bookkeeping must never contact a real database."""
    from app.services import protection_journal, protection_recovery
    from tests.helpers.protection_memory_journal import MemoryJournal
    memory = MemoryJournal()
    monkeypatch.setattr(protection_journal, 'store', memory)
    protection_recovery._tasks.clear()
    protection_recovery._scope_locks.clear()
    protection_recovery._pending_events.clear()
    protection_recovery._closing = False
    yield memory
    protection_recovery._tasks.clear()
    protection_recovery._scope_locks.clear()
    protection_recovery._pending_events.clear()
    protection_recovery._closing = False
