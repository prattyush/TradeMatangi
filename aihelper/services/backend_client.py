"""
Async HTTP client for backend REST calls.
Uses httpx with a shared client for connection reuse.
"""
import logging
from typing import Any

import httpx

from config import BACKEND_URL

logger = logging.getLogger("aihelper.services.backend_client")

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0)
    return _client


async def place_order(session_id: str, payload: dict[str, Any]) -> dict:
    """
    POST /api/trades/buy or /api/trades/sell based on payload["side"].
    payload must have: side ("BUY"|"SELL"), right ("CE"|"PE"|null).
    """
    side = payload.get("side", "").upper()
    if side not in ("BUY", "SELL"):
        raise ValueError(f"place_order: invalid side '{side}'")
    endpoint = "/api/trades/buy" if side == "BUY" else "/api/trades/sell"
    body: dict[str, Any] = {"session_id": session_id}
    if payload.get("right") is not None:
        body["right"] = payload["right"]
    client = get_client()
    resp = await client.post(endpoint, json=body)
    resp.raise_for_status()
    return resp.json()


async def notify_ai_commands_active(session_id: str) -> None:
    """POST /api/simulation/ai-commands/active — tell backend to start firing bar-close hooks."""
    client = get_client()
    try:
        resp = await client.post("/api/simulation/ai-commands/active", json={"session_id": session_id})
        resp.raise_for_status()
    except Exception as exc:
        logger.warning("Failed to notify backend of active commands: %s", exc)


async def get_trades(user_id: str, from_date: str, to_date: str) -> list[dict]:
    """GET /api/analysis/trades — fetch trade history for analysis."""
    client = get_client()
    resp = await client.get(
        "/api/analysis/trades",
        params={"user_id": user_id, "from": from_date, "to": to_date},
    )
    resp.raise_for_status()
    return resp.json()


async def close() -> None:
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None
