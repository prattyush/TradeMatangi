"""Unit test for performance_service.load_session_cycles's bounded retry
around the transient "Execution membership changed during analytics read"
race (Fix 2a)."""
from unittest.mock import patch

import pytest

from app.services import performance_service as perf


def test_retries_once_then_succeeds():
    calls = {"n": 0}

    def flaky(session, include_labels, apply_fee_correction):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("Execution membership changed during analytics read; retry")
        return "ok"

    with patch("app.services.performance_service._load_session_cycles_once", side_effect=flaky), \
         patch("time.sleep"):
        result = perf.load_session_cycles({"session_id": "s"})
    assert result == "ok"
    assert calls["n"] == 2


def test_raises_after_exhausting_attempts():
    def always_fails(session, include_labels, apply_fee_correction):
        raise RuntimeError("Execution membership changed during analytics read; retry")

    with patch("app.services.performance_service._load_session_cycles_once", side_effect=always_fails), \
         patch("time.sleep"), \
         pytest.raises(RuntimeError):
        perf.load_session_cycles({"session_id": "s"})


def test_no_retry_needed_on_clean_read():
    with patch("app.services.performance_service._load_session_cycles_once", return_value="ok") as mock_once:
        result = perf.load_session_cycles({"session_id": "s"})
    assert result == "ok"
    assert mock_once.call_count == 1
