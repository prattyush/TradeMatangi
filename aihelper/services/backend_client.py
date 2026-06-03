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


async def get_trades(
    user_id: str,
    from_date: str,
    to_date: str,
    symbol: str | None = None,
    session_type: str | None = None,
) -> list[dict]:
    """GET /api/analysis/trades — fetch trade history for analysis."""
    client = get_client()
    params: dict = {"user_id": user_id, "from": from_date, "to": to_date}
    if symbol:
        params["symbol"] = symbol
    if session_type:
        params["session_type"] = session_type
    resp = await client.get("/api/analysis/trades", params=params)
    resp.raise_for_status()
    return resp.json()


async def get_ohlc_context(
    symbol: str,
    date: str,
    entry_ts: int,
    exit_ts: int | None = None,
    right: str | None = None,
    strike: int | None = None,
    expiry: str | None = None,
    pre_bars: int = 6,
    post_bars: int = 3,
) -> dict:
    """GET /api/analysis/ohlc-context — labeled OHLC bars surrounding a trade."""
    client = get_client()
    params: dict = {
        "symbol": symbol,
        "date": date,
        "entry_ts": entry_ts,
        "pre_bars": pre_bars,
        "post_bars": post_bars,
    }
    if exit_ts is not None:
        params["exit_ts"] = exit_ts
    if right is not None:
        params["right"] = right
    if strike is not None:
        params["strike"] = strike
    if expiry is not None:
        params["expiry"] = expiry
    resp = await client.get("/api/analysis/ohlc-context", params=params)
    resp.raise_for_status()
    return resp.json()


async def get_user_funds_ratios(user_id: str) -> dict[str, float]:
    """GET /api/users/settings — return the user-configured funds ratio percentages."""
    client = get_client()
    try:
        resp = await client.get("/api/users/settings", headers={"X-User-Id": user_id})
        resp.raise_for_status()
        data = resp.json()
        return {
            "ratio_l": data.get("funds_ratio_l_pct", _DEFAULT_RATIO_PCT["ratio_l"]),
            "ratio_m": data.get("funds_ratio_m_pct", _DEFAULT_RATIO_PCT["ratio_m"]),
            "ratio_h": data.get("funds_ratio_h_pct", _DEFAULT_RATIO_PCT["ratio_h"]),
        }
    except Exception as exc:
        logger.warning("Failed to fetch user funds ratios for %s: %s", user_id, exc)
        return _DEFAULT_RATIO_PCT.copy()


async def get_user_settings(user_id: str) -> dict:
    """GET /api/users/settings — return all user-configurable settings."""
    client = get_client()
    try:
        resp = await client.get("/api/users/settings", headers={"X-User-Id": user_id})
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        logger.warning("Failed to fetch user settings for %s: %s", user_id, exc)
        return {}


async def get_position(session_id: str, right: str | None) -> dict:
    """GET /api/trades/position — return current open position for session/right."""
    client = get_client()
    params: dict[str, Any] = {"session_id": session_id}
    if right is not None:
        params["right"] = right
    resp = await client.get("/api/trades/position", params=params)
    resp.raise_for_status()
    return resp.json()


async def get_open_orders(session_id: str) -> list[dict]:
    """GET /api/orders?open_only=true — return all pending orders for the session."""
    client = get_client()
    resp = await client.get("/api/orders", params={"session_id": session_id, "open_only": "true"})
    resp.raise_for_status()
    return resp.json()


async def get_session_trades(session_id: str) -> list[dict]:
    """GET /api/trades?session_id={id} — fetch all trades for the session."""
    client = get_client()
    resp = await client.get("/api/trades", params={"session_id": session_id})
    resp.raise_for_status()
    return resp.json()


async def update_stoploss_order(session_id: str, order_id: str, trigger_price: float) -> dict:
    """PATCH /api/orders/{order_id} — update stoploss trigger price."""
    client = get_client()
    resp = await client.patch(
        f"/api/orders/{order_id}",
        params={"session_id": session_id},
        json={"trigger_price": round(trigger_price, 2)},
    )
    resp.raise_for_status()
    return resp.json()


async def create_stoploss_order(
    session_id: str,
    right: str | None,
    trigger_price: float,
    quantity: int,
    side: str = "SELL",
) -> dict:
    """POST /api/orders — create a new stoploss order."""
    client = get_client()
    body: dict[str, Any] = {
        "session_id": session_id,
        "side": side,
        "order_type": "STOPLOSS",
        "trigger_price": round(trigger_price, 2),
        "quantity": quantity,
        "is_stoploss": True,
    }
    if right is not None:
        body["right"] = right
    resp = await client.post("/api/orders", json=body)
    resp.raise_for_status()
    return resp.json()


async def update_or_create_stoploss(
    session_id: str,
    right: str | None,
    trigger_price: float,
    position: dict,
) -> dict:
    """
    Find an existing STOPLOSS order for the right and update it, or create a new one.
    Position dict is used to determine the order side (SELL for LONG, BUY for SHORT)
    and the quantity.
    """
    qty = int(position.get("qty", 0))
    pos_side = (position.get("side") or "LONG").upper()
    order_side = "BUY" if pos_side == "SHORT" else "SELL"

    try:
        orders = await get_open_orders(session_id)
        sl_order = next(
            (o for o in orders if o.get("is_stoploss") and o.get("right") == right),
            None,
        )
    except Exception as exc:
        logger.warning("get_open_orders failed (%s), will attempt to create new SL", exc)
        sl_order = None

    if sl_order:
        result = await update_stoploss_order(session_id, sl_order["order_id"], trigger_price)
        return {"action": "updated", "order": result}
    else:
        result = await create_stoploss_order(session_id, right, trigger_price, qty, side=order_side)
        return {"action": "created", "order": result}


async def exit_position_market(session_id: str, right: str | None) -> dict:
    """POST /api/trades/sell — exit the open position at market price."""
    client = get_client()
    body: dict[str, Any] = {"session_id": session_id}
    if right is not None:
        body["right"] = right
    resp = await client.post("/api/trades/sell", json=body)
    resp.raise_for_status()
    return resp.json()


async def cancel_open_stoploss(session_id: str, right: str | None) -> None:
    """Cancel any pending stoploss orders for this session/right after an AI-triggered exit."""
    try:
        orders = await get_open_orders(session_id)
        sl_orders = [o for o in orders if o.get("is_stoploss") and o.get("right") == right]
        client = get_client()
        for o in sl_orders:
            await client.delete(
                f"/api/orders/{o['order_id']}",
                params={"session_id": session_id},
            )
            logger.info(
                "Cancelled SL order %s for session %s right=%s",
                o["order_id"], session_id, right,
            )
    except Exception as exc:
        logger.warning(
            "cancel_open_stoploss failed (session=%s right=%s): %s", session_id, right, exc
        )


async def start_takeprofit_strategy(
    session_id: str,
    right: str | None,
    target_price: float,
) -> dict:
    """POST /api/strategies/start — start a TargetProfit strategy at the given price."""
    client = get_client()
    body: dict[str, Any] = {
        "session_id": session_id,
        "strategy_type": "TargetProfit",
        "target_profit_value": round(target_price, 2),
        "target_profit_is_pct": False,
        "direction": "BUY",
    }
    if right is not None:
        body["right"] = right
    resp = await client.post("/api/strategies/start", json=body)
    resp.raise_for_status()
    return resp.json()


# ── Settings cache (60 s TTL) ─────────────────────────────────────────────────

import time as _time
_settings_cache: dict[str, tuple[dict, float]] = {}
_SETTINGS_TTL = 60.0


async def get_user_settings_cached(user_id: str) -> dict:
    """Return user settings, refreshing at most once per minute."""
    entry = _settings_cache.get(user_id)
    if entry and entry[1] > _time.monotonic():
        return entry[0]
    settings = await get_user_settings(user_id)
    _settings_cache[user_id] = (settings, _time.monotonic() + _SETTINGS_TTL)
    return settings


# ── Pattern alert emission ─────────────────────────────────────────────────────

async def emit_pattern_alert(session_id: str, result: Any) -> None:
    """
    POST /api/internal/emit-event/{session_id} — inject a pattern_alert SSE event.
    result must be a PatternResult (or any object with .pattern, .category, etc.).
    """
    payload = {
        "type": "pattern_alert",
        "pattern": result.pattern,
        "category": result.category,
        "title": result.title,
        "severity": result.severity,
        "description": result.description,
        "trade_suggestion": result.trade_suggestion,
    }
    client = get_client()
    try:
        resp = await client.post(f"/api/internal/emit-event/{session_id}", json=payload)
        resp.raise_for_status()
    except Exception as exc:
        logger.debug("emit_pattern_alert failed (session=%s): %s", session_id, exc)


async def close() -> None:
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None
