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


_DEFAULT_RATIO_PCT: dict[str, float] = {"ratio_l": 0.03, "ratio_m": 0.06, "ratio_h": 0.12}


def _resolve_ratio(qty_type: str, qty_value: Any, funds_ratios: dict[str, float]) -> dict[str, Any]:
    """Map quantity_type → funds_ratio_pct (or quantity for fixed type)."""
    if qty_type in funds_ratios:
        return {"funds_ratio_pct": funds_ratios[qty_type]}
    if qty_type == "fixed" and qty_value is not None:
        return {"quantity": int(qty_value)}
    return {"funds_ratio_pct": funds_ratios.get("ratio_l", _DEFAULT_RATIO_PCT["ratio_l"])}


async def place_order(session_id: str, payload: dict[str, Any]) -> dict:
    """
    Route to the correct backend endpoint based on order_type:
    - "market" → POST /api/trades/buy or /api/trades/sell (immediate fill)
    - "limit"  → POST /api/orders/place  (pending limit order; shows in Open Orders)
    - "target" → POST /api/orders/place  (pending target/stop-limit; shows in Open Orders)
    payload fields: side, order_type, right, quantity_type, quantity_value, computed_price, funds_ratios
    funds_ratios: user-configured ratio map, e.g. {"ratio_l": 0.03, "ratio_m": 0.24, "ratio_h": 0.12}
    """
    side = payload.get("side", "").upper()
    if side not in ("BUY", "SELL"):
        raise ValueError(f"place_order: invalid side '{side}'")
    order_type = (payload.get("order_type") or "market").lower()
    funds_ratios: dict[str, float] = payload.get("funds_ratios") or _DEFAULT_RATIO_PCT
    qty_type = payload.get("quantity_type", "ratio_l")
    qty_value = payload.get("quantity_value")
    client = get_client()

    if order_type == "market":
        endpoint = "/api/trades/buy" if side == "BUY" else "/api/trades/sell"
        body: dict[str, Any] = {"session_id": session_id}
        if payload.get("right") is not None:
            body["right"] = payload["right"]
        body.update(_resolve_ratio(qty_type, qty_value, funds_ratios))
        resp = await client.post(endpoint, json=body)
        resp.raise_for_status()
        return resp.json()

    # Limit or Target — place a pending order via /api/orders/place
    computed_price = payload.get("computed_price")
    if computed_price is None:
        raise ValueError(f"place_order: computed_price required for {order_type} order")

    body = {
        "session_id": session_id,
        "side": side,
        "order_type": order_type.upper(),
    }
    if order_type == "limit":
        body["limit_price"] = float(computed_price)
    else:  # target
        body["trigger_price"] = float(computed_price)

    body.update(_resolve_ratio(qty_type, qty_value, funds_ratios))

    if payload.get("right") is not None:
        body["right"] = payload["right"]

    resp = await client.post("/api/orders", json=body)
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
