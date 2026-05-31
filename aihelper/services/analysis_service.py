"""
Trade analysis service — Step 8 will complete this.
Step 1 stub: defines the interface.
"""
import logging
from typing import Any

from services import backend_client
from services.llm_service import analyze_trades as _analyze

logger = logging.getLogger("aihelper.services.analysis_service")


async def run_analysis(user_id: str, from_date: str, to_date: str) -> dict[str, Any]:
    """
    Fetch trade history from backend and ask the LLM for structured insights.
    Placeholder — Step 8 implements full parsing and display.
    """
    logger.info("Analysis requested: user=%s %s → %s", user_id, from_date, to_date)
    trades = await backend_client.get_trades(user_id, from_date, to_date)
    date_range = f"{from_date} to {to_date}"
    return await _analyze(trades, date_range)
