"""
Trade analysis service — fetches sessions+trades from backend, runs LLM analysis.
"""
import logging
from datetime import date, timedelta
from typing import Any

from services import backend_client
from services.llm_service import analyze_trades as _analyze, extract_date_range as _extract_range

logger = logging.getLogger("aihelper.services.analysis_service")

_DEFAULT_PERIOD_DAYS = 7


def _today_str() -> str:
    return date.today().isoformat()


def _default_range() -> tuple[str, str, str]:
    today = date.today()
    from_date = (today - timedelta(days=_DEFAULT_PERIOD_DAYS)).isoformat()
    return from_date, today.isoformat(), f"last {_DEFAULT_PERIOD_DAYS} days"


async def parse_date_range(message: str) -> tuple[str, str, str]:
    """
    Parse from_date, to_date, period_description from a user message.
    Falls back to last 7 days on any error.
    """
    today = _today_str()
    try:
        result = await _extract_range(message, today)
        from_date = result.get("from_date", "")
        to_date = result.get("to_date", "")
        period_desc = result.get("period_description", f"last {_DEFAULT_PERIOD_DAYS} days")
        # Validate format
        date.fromisoformat(from_date)
        date.fromisoformat(to_date)
        return from_date, to_date, period_desc
    except Exception:
        logger.warning("Date range parse failed — defaulting to last %d days", _DEFAULT_PERIOD_DAYS)
        return _default_range()


async def run_analysis(user_id: str, from_date: str, to_date: str, date_range: str) -> dict[str, Any]:
    """
    Fetch trade history from backend and ask the LLM for structured insights.
    Returns the analysis dict: {summary, patterns, suggestions, notable_stats}
    """
    logger.info("Analysis requested: user=%s %s → %s", user_id, from_date, to_date)
    trades = await backend_client.get_trades(user_id, from_date, to_date)
    if not trades:
        return {
            "summary": f"No sessions found for the period {date_range}.",
            "patterns": [],
            "suggestions": ["Take some trades first to generate analysis."],
            "notable_stats": {},
        }
    return await _analyze(trades, date_range)
