"""
Kotak Neo broker endpoints for real trading.

All endpoints require the user to be in the real-trading whitelist
(or be an admin).  The TOTP login must be called before starting a
real-trading session.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_request_user_id, require_real_trading_access

logger = logging.getLogger(__name__)
from app.models.schemas import KotakLoginRequest, KotakStatusResponse, KotakFundsResponse
from app.services.kotak_service import get_service, KotakError

router = APIRouter(prefix="/api/kotak", tags=["kotak"])


@router.post("/login")
async def kotak_login(
    req: KotakLoginRequest,
    user_id: str = Depends(require_real_trading_access),
):
    """
    Authenticate with Kotak Neo using a TOTP.
    Must be called before starting a real trading session.
    Returns 502 with the exact Kotak error message on failure.
    """
    try:
        get_service().login_with_totp(req.totp)
        return {"status": "ok", "broker": "KotakNeo"}
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/status", response_model=KotakStatusResponse)
async def kotak_status(
    user_id: str = Depends(require_real_trading_access),
):
    """Return whether the Kotak client is currently authenticated."""
    return KotakStatusResponse(authenticated=get_service().is_authenticated())


@router.get("/funds", response_model=KotakFundsResponse)
async def kotak_funds(
    user_id: str = Depends(require_real_trading_access),
):
    """Return the available funds (Net balance) from Kotak."""
    try:
        balance = get_service().get_funds()
        return KotakFundsResponse(balance=balance)
    except Exception as e:

        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/order-history")
async def kotak_order_history(
    user_id: str = Depends(require_real_trading_access),
):
    """Return today's order history from Kotak."""
    try:
        orders = get_service().get_order_history()
        return {"orders": orders}
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/reconcile")
async def kotak_reconcile(
    session_id: str = Query(...),
    user_id: str = Depends(require_real_trading_access),
):
    """
    Reconcile fills from Kotak's order_report() against local pending orders
    and any external (manually placed) orders.  Also syncs the wallet balance
    from Kotak so the displayed balance reflects the broker's actual funds.
    Returns the number of newly-recorded fills and the updated wallet balance.
    """
    import asyncio
    import json as _json
    from app.services import simulation as sim_svc, order_service, wallet_service
    from app.services.trading import record_trade
    from app.models.schemas import OrderStatus, TradeSide
    from app.services.kotak_service import _SYMBOL_MAP

    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.session_type != "real":
        raise HTTPException(status_code=400, detail="Only real sessions support reconciliation")

    kotak_svc = get_service()
    try:
        kotak_orders = kotak_svc.get_order_history()
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    # Invert kotak_order_map (order_id → kotak_id) to find by kotak_id
    reverse_map: dict[str, str] = {v: k for k, v in session.kotak_order_map.items()}

    # Resolve the expected Kotak trading symbol for this session (for external order matching)
    session_kotak_sym: str = ""
    if session.symbol in _SYMBOL_MAP:
        session_kotak_sym = _SYMBOL_MAP[session.symbol][0]  # e.g. "TMCV-EQ", "RELIANCE-EQ"

    reconciled = 0

    # ── Pass 1: reconcile fills for locally-tracked orders ───────────────────
    for ko in kotak_orders:
        k_id = ko.get("kotak_order_id", "")
        if ko.get("status") not in ("complete", "filled"):
            continue

        order_id = reverse_map.get(k_id)
        if not order_id:
            continue

        o = order_service.get_order(session_id, order_id)
        if o is None or o.status == OrderStatus.CANCELLED:
            continue  # cancelled orders need no fill reconciliation
        if o.kotak_fill_confirmed:
            continue  # fill already recorded by WebSocket callback

        avg_prc = ko.get("filled_price", 0.0)
        fill_qty = ko.get("filled_quantity") or ko.get("quantity", 0)
        if avg_prc <= 0 or fill_qty <= 0:
            continue

        fill_ts = int(session.current_time) if session.current_time else 0

        o.kotak_fill_confirmed = True
        o.status = OrderStatus.FILLED
        o.filled_price = avg_prc
        o.filled_at = fill_ts

        record_trade(
            session_id=session_id,
            side=o.side,
            price=avg_prc,
            timestamp=fill_ts,
            quantity=fill_qty,
            symbol=o.symbol,
            instrument_type=session.instrument_type,
            strike=o.strike if o.strike is not None else session.strike,
            expiry=session.expiry,
            right=o.right,
            brokerage_per_order=session.brokerage_per_order,
            user_id=session.user_id,
            session_type=session.session_type,
        )

        order_service._write_order_to_db(o)

        evt = {
            "type": "order_filled",
            "order_id": order_id,
            "side": o.side.value,
            "quantity": fill_qty,
            "trigger_price": o.trigger_price,
            "filled_price": avg_prc,
            "filled_at": fill_ts,
            "right": o.right,
        }
        try:
            session.queue.put_nowait(_json.dumps(evt))
        except Exception:
            pass

        logger.info(
            "Reconciled fill for order %s (kotak %s): side=%s qty=%d price=%.2f",
            order_id, k_id, o.side.value, fill_qty, avg_prc,
        )
        reconciled += 1

    # ── Pass 2: pick up external / manually-placed broker orders ─────────────
    # These are complete orders whose kotak_id is not in our internal map.
    # Typical scenario: user placed a sell directly on the Kotak mobile app.
    for ko in kotak_orders:
        k_id = ko.get("kotak_order_id", "")
        if ko.get("status") not in ("complete", "filled"):
            continue
        if k_id in reverse_map:
            continue  # already handled in Pass 1
        if k_id in session.external_reconciled_kotak_ids:
            continue  # already recorded in a prior reconcile call

        avg_prc = ko.get("filled_price", 0.0)
        fill_qty = ko.get("filled_quantity") or ko.get("quantity", 0)
        if avg_prc <= 0 or fill_qty <= 0:
            continue

        # Only reconcile orders that belong to the session's symbol.
        # Kotak symbol may include suffixes like "-EQ"; check substring match.
        ko_sym = ko.get("symbol", "")
        if session_kotak_sym and session_kotak_sym.split("-")[0].upper() not in ko_sym.upper():
            logger.debug(
                "Reconcile: skipping external order %s (symbol %s, session expects %s)",
                k_id, ko_sym, session_kotak_sym,
            )
            continue

        side_str = ko.get("side", "BUY")
        trade_side = TradeSide.BUY if side_str == "BUY" else TradeSide.SELL
        fill_ts = int(session.current_time) if session.current_time else 0

        # Detect right (CE/PE) from the Kotak trading symbol suffix so options
        # positions update correctly (CE and PE are tracked independently).
        ko_sym_upper = ko_sym.upper()
        if ko_sym_upper.endswith("CE"):
            ext_right: str | None = "CE"
        elif ko_sym_upper.endswith("PE"):
            ext_right = "PE"
        else:
            ext_right = None  # equity or unrecognised

        # For options, use session expiry/strike as approximations.
        # For equity, these are None.
        ext_instrument_type = session.instrument_type
        ext_strike = session.strike if ext_right else None
        ext_expiry = session.expiry if ext_right else None

        record_trade(
            session_id=session_id,
            side=trade_side,
            price=avg_prc,
            timestamp=fill_ts,
            quantity=fill_qty,
            symbol=session.symbol,
            instrument_type=ext_instrument_type,
            strike=ext_strike,
            expiry=ext_expiry,
            right=ext_right,
            brokerage_per_order=session.brokerage_per_order,
            user_id=session.user_id,
            session_type=session.session_type,
        )

        session.external_reconciled_kotak_ids.add(k_id)

        evt = {
            "type": "order_filled",
            "order_id": f"external_{k_id}",
            "side": side_str,
            "quantity": fill_qty,
            "trigger_price": avg_prc,
            "filled_price": avg_prc,
            "filled_at": fill_ts,
            "right": ext_right,
        }
        try:
            session.queue.put_nowait(_json.dumps(evt))
        except Exception:
            pass

        logger.info(
            "Reconciled external order %s: side=%s qty=%d price=%.2f symbol=%s right=%s",
            k_id, side_str, fill_qty, avg_prc, ko_sym, ext_right,
        )
        reconciled += 1

    # ── Wallet sync: reset to Kotak's actual net balance ─────────────────────
    # This corrects any drift caused by external trades or missed callbacks.
    wallet_balance: float | None = None
    try:
        wallet_balance = kotak_svc.get_funds()
        wallet_service.reset(session.user_id, session.date, wallet_balance)
        logger.info(
            "Reconcile: wallet synced from Kotak for user %s date %s: ₹%.2f",
            session.user_id, session.date, wallet_balance,
        )
    except KotakError as exc:
        logger.warning("Reconcile: wallet sync from Kotak failed: %s", exc)

    # ── Pass 3: cancel local PENDING orders whose broker-side order was cancelled/rejected ──
    # Covers the case where modify_sl_to_limit_order() caused Kotak to cancel the SL order
    # (transitional state) so the local order never gets cleared without explicit reconcile.
    for ko in kotak_orders:
        k_id = ko.get("kotak_order_id", "")
        if ko.get("status") not in ("cancelled", "rejected"):
            continue
        order_id = reverse_map.get(k_id)
        if not order_id:
            continue
        o = order_service.get_order(session_id, order_id)
        if o is None or o.status != OrderStatus.PENDING:
            continue
        order_service.cancel_order(session_id, order_id, session.date)
        evt = {"type": "order_cancelled", "order_id": order_id}
        try:
            session.queue.put_nowait(_json.dumps(evt))
        except Exception:
            pass
        logger.info(
            "Reconcile: cancelled local order %s — broker order %s was %s",
            order_id, k_id, ko.get("status"),
        )

    # Collect currently open/pending Kotak orders for informational display
    open_kotak_orders = [
        ko for ko in kotak_orders
        if ko.get("status") in ("open", "trigger pending", "amo")
    ]
    return {
        "reconciled": reconciled,
        "open_orders": open_kotak_orders,
        "wallet_balance": wallet_balance,
    }


@router.get("/check-access")
async def check_real_trading_access(
    user_id: str = Depends(get_request_user_id),
):
    """
    Returns whether the current user has real trading access.
    Used by the frontend to decide whether to show the real trading option.
    Does NOT require whitelist access itself (so non-whitelisted users can
    call this safely to find out they don't have access).
    """
    from app.services.user_service import get_user_info
    from app.services import real_trading_service
    info = get_user_info(user_id)
    has_access = bool(
        (info and info.get("is_admin"))
        or real_trading_service.is_whitelisted_user(user_id)
    )
    return {"has_access": has_access}
