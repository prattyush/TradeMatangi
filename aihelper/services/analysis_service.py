"""
Trade analysis service — fetches sessions+trades from backend, runs programmatic
pattern detection, then asks the LLM to synthesize the findings.
"""
import logging
from datetime import date, timedelta
from typing import Any

from services import backend_client
from services.llm_service import (
    analyze_trades as _analyze,
    extract_date_range as _extract_range,
    extract_analysis_params as _extract_params,
)
from services import pattern_detector as pd_

logger = logging.getLogger("aihelper.services.analysis_service")

_DEFAULT_PERIOD_DAYS = 7
_MAX_GROUPS_FOR_OHLC = 20  # cap OHLC context calls per analysis request


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
        date.fromisoformat(from_date)
        date.fromisoformat(to_date)
        return from_date, to_date, period_desc
    except Exception:
        logger.warning("Date range parse failed — defaulting to last %d days", _DEFAULT_PERIOD_DAYS)
        return _default_range()


async def parse_analysis_request(
    message: str,
) -> tuple[str, str, str, str | None, str | None]:
    """
    Parse all analysis parameters from user message in one LLM call.
    Returns: (from_date, to_date, period_description, symbol, session_type)
    """
    today = _today_str()
    try:
        result = await _extract_params(message, today)
        from_date = result.get("from_date", "")
        to_date = result.get("to_date", "")
        period_desc = result.get("period_description", f"last {_DEFAULT_PERIOD_DAYS} days")
        symbol = result.get("symbol") or None
        session_type = result.get("session_type") or None
        date.fromisoformat(from_date)
        date.fromisoformat(to_date)
        return from_date, to_date, period_desc, symbol, session_type
    except Exception:
        logger.warning("Analysis params parse failed — defaulting", exc_info=True)
        fd, td, desc = _default_range()
        return fd, td, desc, None, None


async def _run_pattern_analysis(
    sessions: list[dict],
) -> dict[str, Any]:
    """
    For each session, group trades, fetch OHLC context, and run pattern checks.
    Returns aggregated findings dict for the LLM.
    """
    group_findings: list[dict] = []
    groups_checked = 0

    for session in sessions:
        symbol = session.get("symbol", "")
        sess_date = session.get("date", "")
        instrument_type = session.get("instrument_type", "equity")
        trades_raw = session.get("trades", [])

        if not trades_raw:
            continue

        groups = pd_.group_trades(trades_raw)
        for g_idx, group in enumerate(groups):
            if groups_checked >= _MAX_GROUPS_FOR_OHLC:
                break

            direction = group["direction"]
            first_entry = group["first_entry"]
            last_exit = group["last_exit"]
            entry_ts = int(first_entry.get("timestamp", 0))
            exit_ts = int(last_exit.get("timestamp", 0)) if last_exit else None
            pnl = pd_.compute_group_pnl(group)

            # Options params from the trade records
            right = group.get("right") if instrument_type == "options" else None
            strike = group.get("strike")
            expiry = group.get("expiry")

            # Always run panic buying (doesn't need OHLC)
            panic = pd_.detect_panic_buying(trades_raw, direction)

            # Fetch OHLC context — skip gracefully if data unavailable
            bars: list[dict] = []
            has_ohlc = False
            try:
                if symbol and sess_date:
                    ctx = await backend_client.get_ohlc_context(
                        symbol=symbol,
                        date=sess_date,
                        entry_ts=entry_ts,
                        exit_ts=exit_ts,
                        right=right,
                        strike=int(strike) if strike is not None else None,
                        expiry=expiry,
                    )
                    bars = ctx.get("bars", [])
                    has_ohlc = bool(bars)
            except Exception as exc:
                logger.debug("OHLC context unavailable for %s %s: %s", symbol, sess_date, exc)

            labeled = pd_.extract_labeled_bars(bars) if bars else {}
            entry_bar = (labeled.get("entry") or labeled.get("entry_exit") or [None])[0]
            exit_bar = (labeled.get("exit") or labeled.get("entry_exit") or [None])[0]
            post_bars = labeled.get("post", [])
            after_entry = (
                labeled.get("trade", [])
                + labeled.get("exit", [])
                + labeled.get("post", [])
            )

            patterns: dict[str, Any] = {"panic_buying": panic}
            if has_ohlc:
                patterns["entry_deviation"] = pd_.detect_entry_deviation(first_entry, entry_bar)
                patterns["early_exit"] = pd_.detect_early_exit(exit_bar, post_bars, direction)
                patterns["scared_exit"] = pd_.detect_scared_exit(pnl, exit_bar, post_bars, direction)
                patterns["buying_on_top"] = pd_.detect_buying_on_top(entry_bar, after_entry, direction)

            group_findings.append({
                "group_id": f"{session.get('session_id', '')}_{g_idx}",
                "direction": direction,
                "pnl": round(pnl, 2),
                "has_ohlc": has_ohlc,
                "has_exit": last_exit is not None,
                "patterns": patterns,
            })
            groups_checked += 1

    return pd_.aggregate_findings(group_findings)


async def run_analysis(
    user_id: str,
    from_date: str,
    to_date: str,
    date_range: str,
    symbol: str | None = None,
    session_type: str | None = None,
) -> dict[str, Any]:
    """
    Fetch trade history from backend, run programmatic pattern checks,
    then ask the LLM to synthesize findings into structured insights.
    """
    logger.info(
        "Analysis: user=%s %s→%s symbol=%s session_type=%s",
        user_id, from_date, to_date, symbol, session_type,
    )
    trades = await backend_client.get_trades(
        user_id, from_date, to_date,
        symbol=symbol, session_type=session_type,
    )
    if not trades:
        return {
            "summary": f"No sessions found for the period {date_range}.",
            "patterns": [],
            "suggestions": ["Take some trades first to generate analysis."],
            "notable_stats": {},
        }

    pattern_findings = await _run_pattern_analysis(trades)
    return await _analyze(trades, date_range, pattern_findings=pattern_findings)
