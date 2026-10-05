import asyncio
import time
import json
import logging
from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel, Field
from app.dependencies import get_request_user_id
from app.models.schemas import Order, OrderType, TradeSide, PlaceOrderRequest, UpdateOrderRequest, BulkUpdateSLRequest, ConvertOrderRequest, BulkConvertRequest
from app.services import order_service, simulation as sim_svc, trading as trading_service
from app.services.wallet_service import InsufficientFundsError, get_balance, get_ledger_balance
from app.config import LOT_SIZES, EQUITY_MIS_MARGIN_RATE

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/orders", tags=["orders"])


def _desktop_order_source(session) -> str | None:
    if getattr(session, "desktop_mode", None) == "paper" or getattr(session, "desktop_origin", None) == "desktop_paper":
        return "desktop_paper"
    if session.session_type == "stepwise":
        return "desktop_stepwise"
    if getattr(session, "desktop_origin", None) == "desktop_replay":
        return "desktop_replay"
    return None


def _ledger_kind(session) -> str:
    if session.session_type == "paper":
        return "paper"
    if session.session_type == "real":
        return "real"
    return "sim"


def _wallet_balance_for_session(session) -> float:
    ledger_id = getattr(session, "wallet_ledger_id", "")
    if ledger_id:
        return get_ledger_balance(session.user_id, session.date, ledger_id, _ledger_kind(session))
    return get_balance(session.user_id, session.date)


def _reservation_ledger_id(session) -> str | None:
    return getattr(session, "wallet_ledger_id", "") or None


def _uses_equity_intraday_margin(session, order_right: str | None = None) -> bool:
    if order_right is not None or session.instrument_type != "equity":
        return False
    return session.session_type in ("sim", "stepwise", "paper", "real")


def _is_closing_order_for_position(order: Order, position) -> bool:
    return (
        position.side != "FLAT"
        and (
            (position.side == "LONG" and order.side == TradeSide.SELL)
            or (position.side == "SHORT" and order.side == TradeSide.BUY)
        )
    )


def _get_closing_orders(session, right: str | None) -> list[Order]:
    return [
        order for order in order_service.get_open_orders(session.session_id)
        if (order.right or None) == right and sim_svc._is_position_exit(session, order)
    ]


def _stoploss_available_quantity(
    session,
    right: str | None,
    strike: int | None,
    expiry: str | None,
    exclude_order_id: str | None = None,
    broker_product: str = "MIS",
    broker_exchange: str | None = None,
) -> tuple[int, int]:
    """Return available closing quantity and current position quantity for a contract."""
    position = trading_service.get_position(
        session.session_id, session.symbol, right=right, strike=strike, expiry=expiry,
    )
    exchange = broker_exchange or (("bse_fo" if session.symbol == "BSESEN" else "nse_fo") if right else "nse_cm")
    if session.session_type == "real" and getattr(session, "broker_positions", None) is not None:
        matching = [p for p in session.broker_positions
                    if (p.get("right"), p.get("strike"), p.get("expiry")) == (right, strike, expiry)
                    and (p.get("product") or "MIS") == broker_product and (p.get("exchange") or exchange) == exchange]
        net = sum(p["quantity"] * (1 if p["side"] == "LONG" else -1 if p["side"] == "SHORT" else 0) for p in matching)
        position = position.model_copy(update={"quantity": abs(net), "side": "LONG" if net > 0 else "SHORT" if net < 0 else "FLAT"})
    if position.side == "FLAT" or position.quantity <= 0:
        return 0, 0
    exit_side = TradeSide.SELL if position.side == "LONG" else TradeSide.BUY
    covered = sum(
        max(0, order.quantity - order.broker_filled_quantity) if session.session_type == "real" else order.quantity
        for order in order_service.get_open_orders(session.session_id)
        if order.order_id != exclude_order_id
        and order.status == order_service.OrderStatus.PENDING
        and order.side == exit_side
        and (session.session_type != "real" or bool(order.kotak_order_id))
        and (session.session_type != "real" or ((order.broker_product or "MIS") == broker_product and (order.broker_exchange or exchange) == exchange))
        and (order.right or None) == right
        and (order.strike if order.strike is not None else None) == strike
        and (order.expiry if order.expiry is not None else None) == expiry
        and (order.is_stoploss or order.order_type in (OrderType.STOPLOSS, OrderType.LIMIT, OrderType.TARGET))
    )
    return max(0, position.quantity - covered), position.quantity


def _sync_kotak_after_convert(session, order: Order, new_order_type: OrderType, *, reprice: bool = False) -> None:
    from app.services.broker_order_service import sync_order_edit
    from app.services.kotak_service import KotakError
    try:
        sync_order_edit(session, order, new_order_type, reprice=reprice)
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _convert_with_broker(session, order, new_type, price=None):
    from app.services.broker_order_service import convert_order
    from app.services.kotak_service import KotakError
    try:
        return convert_order(session, order, new_type, price)
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class MissingStoplossRequest(BaseModel):
    session_id: str
    trigger_price: float = Field(gt=0, allow_inf_nan=False)
    request_id: str = Field(min_length=1, max_length=100)
    right: str | None = None
    strike: int | None = None
    expiry: str | None = None


@router.post("/fill-missing-stoploss")
async def fill_missing_stoploss(req: MissingStoplossRequest, user_id: str = Depends(get_request_user_id)):
    session = sim_svc.get_session(req.session_id)
    if not session or session.user_id != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.state == sim_svc.SimulationState.ENDED:
        raise HTTPException(status_code=409, detail="Session has ended")
    if getattr(session, "paper_lease_lost", False) or (getattr(session, "paper_engine_token", None) and time.monotonic() >= getattr(session, "paper_engine_valid_until", 0)):
        raise HTTPException(status_code=409, detail="Session engine ownership expired; reattach")
    right = req.right.upper() if req.right else None
    if right not in (None, "CE", "PE") or (right is None and session.instrument_type == "options"):
        raise HTTPException(status_code=400, detail="Select a traded equity or option chart")
    strike = (req.strike if req.strike is not None else session.strike_ce if right == "CE" else session.strike_pe) if right else None
    expiry = (req.expiry or session.expiry) if right else None
    if right and (strike is None or not expiry):
        raise HTTPException(status_code=400, detail="Full option identity is required")
    lock = getattr(session, "missing_stoploss_lock", None)
    if lock is None:
        lock = session.missing_stoploss_lock = asyncio.Lock()
    async with lock:
        group = "missing-sl:" + req.request_id
        existing = [o for o in order_service.get_all_orders(session.session_id) if o.group_id == group]
        if existing:
            if any((o.right, o.strike, o.expiry, o.trigger_price) != (right, strike, expiry, req.trigger_price) for o in existing):
                raise HTTPException(status_code=409, detail="Stop-loss request identity reused with different parameters")
            if any(o.status == order_service.OrderStatus.CANCELLED for o in existing):
                raise HTTPException(status_code=409, detail="Previous stop-loss request was cancelled or rejected; refresh and select SL again")
            return {"orders": existing, "quantity": sum(o.quantity for o in existing)}
        position = trading_service.get_position(session.session_id, session.symbol, right=right, strike=strike, expiry=expiry)
        available, _ = _stoploss_available_quantity(session, right, strike, expiry)
        if available <= 0:
            raise HTTPException(status_code=409, detail="Position is flat or already fully covered by exit orders")
        price = float(session.last_price or 0)
        if right:
            key = f"{session.symbol}:{expiry}:{strike}:{right}"
            quote = getattr(session, "desktop_contract_quotes", {}).get(key)
            if quote:
                price = float(quote.get("price", 0))
            elif strike == (session.strike_ce if right == "CE" else session.strike_pe) and expiry == session.expiry:
                price = float(session.last_price_ce if right == "CE" else session.last_price_pe)
            else:
                price = 0
        if price <= 0:
            raise HTTPException(status_code=409, detail="No authoritative price available for this chart")
        if (position.side == "LONG" and req.trigger_price >= price) or (position.side == "SHORT" and req.trigger_price <= price):
            raise HTTPException(status_code=400, detail="Long stop must be below current price; short stop above current price")
        lot_size = LOT_SIZES.get(session.symbol, 1) if right else 1
        if available % lot_size:
            raise HTTPException(status_code=409, detail="Uncovered option quantity must be complete lots")
        created = []
        # Submit each chunk through the full route so every Real broker error is
        # surfaced, rather than relying on the legacy best-effort extra chunks.
        chunks = [available]
        if right:
            capacity = (order_service.get_max_contracts(session.symbol) // lot_size) * lot_size
            if capacity < lot_size:
                raise HTTPException(status_code=409, detail="Broker order capacity is smaller than one option lot")
            chunks = [min(capacity, available - offset) for offset in range(0, available, capacity)]
        for quantity in chunks:
            order = await place_order(PlaceOrderRequest(session_id=session.session_id,
                side=TradeSide.SELL if position.side == "LONG" else TradeSide.BUY,
                order_type=OrderType.STOPLOSS, trigger_price=req.trigger_price,
                quantity=quantity, is_stoploss=True, right=right, strike=strike,
                expiry=expiry, group_id=group))
            created.append(order)
        return {"orders": created, "quantity": sum(o.quantity for o in created)}


@router.post("", response_model=Order)
async def place_order(req: PlaceOrderRequest):
    session = sim_svc.get_session(req.session_id)
    if session and session.session_type == "real" and getattr(session, "broker_refresh_events", None) is not None:
        raise HTTPException(status_code=409, detail="Broker refresh is in progress; retry shortly")
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")

    from app.services.guardrail_service import check_guardrails
    blocked, reason = check_guardrails(session)
    if blocked:
        raise HTTPException(status_code=403, detail=f"GUARDRAIL:{reason}")

    if req.order_type == OrderType.TARGET:
        if not req.trigger_price or req.trigger_price <= 0:
            raise HTTPException(status_code=400, detail="trigger_price is required and must be positive for TARGET orders")
    elif req.order_type == OrderType.STOPLOSS:
        if not req.trigger_price or req.trigger_price <= 0:
            raise HTTPException(status_code=400, detail="trigger_price is required and must be positive for STOPLOSS orders")
    else:  # LIMIT
        if not req.limit_price or req.limit_price <= 0:
            raise HTTPException(status_code=400, detail="limit_price is required and must be positive for LIMIT orders")

    # Resolve which options contract this order targets
    order_right: str | None = None
    order_strike: int | None = None
    order_expiry: str | None = None
    if session.instrument_type == "options" or req.right:
        order_right = req.right if req.right is not None else session.right
        if order_right is None:
            raise HTTPException(
                status_code=400,
                detail="right (CE or PE) is required when placing orders in a dual-stream options session",
            )
        order_strike = req.strike if req.strike is not None else (session.strike_ce if order_right == "CE" else session.strike_pe)
        order_expiry = req.expiry if req.expiry is not None else session.expiry

    if req.market_order:
        if req.order_type != OrderType.LIMIT:
            raise HTTPException(status_code=400, detail="Market execution requires a LIMIT order")
        if session.session_type == "real":
            from app.services.execution_price_service import gap_for, limit_price
            # Read the exact contract quote on the server; do not trust a client price.
            quote = (getattr(session, "desktop_contract_quotes", {}) or {}).get(
                f"{session.symbol}:{order_expiry}:{order_strike}:{order_right}") if order_right else None
            current = float(quote.get("price", 0)) if quote else (
                session.last_price_ce if order_right == "CE" else session.last_price_pe if order_right == "PE" else session.last_price)
            active_strike = session.strike_ce if order_right == "CE" else session.strike_pe if order_right == "PE" else None
            if order_right and not quote and (order_strike != active_strike or order_expiry != session.expiry):
                raise HTTPException(status_code=409, detail="No authoritative quote available for the selected contract")
            import math
            if not math.isfinite(current) or current <= 0:
                raise HTTPException(status_code=409, detail="No authoritative market quote available")
            req.quote_price = current
            req.quote_timestamp = int(quote.get("timestamp", session.current_time)) if quote else int(session.current_time)
            req.quote_source = str(quote.get("source", "server_quote")) if quote else "session_quote"
            req.limit_price = limit_price(req.side, current, gap_for(session.user_id))

    # Naked short margin check for options sessions
    if (
        order_right is not None
        and req.side == TradeSide.SELL
        and not req.is_stoploss
        and req.order_type != OrderType.STOPLOSS
    ):
        from app.services.trading import get_position
        position = get_position(session.session_id, session.symbol, right=order_right, strike=order_strike, expiry=order_expiry)
        if position.side != "LONG":  # no open buy position — naked short
            from app.services.options_service import compute_short_margin, get_underlying_price_at
            current_ts = int(session.current_time) if session.current_time else 0
            underlying_price = get_underlying_price_at(session.symbol, session.date, current_ts)
            if underlying_price is None:
                underlying_price = session.last_price  # fallback
            margin = compute_short_margin(session.symbol, underlying_price)
            current_wallet = _wallet_balance_for_session(session)
            if current_wallet < margin:
                raise HTTPException(
                    status_code=402,
                    detail=(
                        f"Insufficient funds for naked short margin. "
                        f"Required: ₹{margin:,.2f}, Available: ₹{current_wallet:,.2f}"
                    ),
                )

    # Resolve lot_size: 1 for equity; actual lot size for options
    lot_size = LOT_SIZES.get(session.symbol, 1) if order_right is not None else 1

    # Brokers require option quantities to be complete lots.  Enforce this at
    # the API boundary for stop-loss exits as well, so clients cannot bypass
    # the website control and submit quantities such as 1 or 66 contracts.
    if order_right is not None and req.order_type == OrderType.STOPLOSS:
        if req.quantity is not None and (req.quantity < lot_size or req.quantity % lot_size != 0):
            raise HTTPException(
                status_code=400,
                detail=f"{session.symbol} option stop-loss quantity must be a positive multiple of {lot_size}",
            )

    # Equity intraday sessions reserve 20% margin while P&L remains full-notional.
    order_margin_rate = EQUITY_MIS_MARGIN_RATE if _uses_equity_intraday_margin(session, order_right) else 1.0

    if req.entry_sl_price is not None and not req.is_stoploss and req.order_type != OrderType.STOPLOSS:
        entry = req.limit_price if req.order_type == OrderType.LIMIT else req.trigger_price
        if req.entry_sl_price <= 0 or (req.side == TradeSide.BUY and req.entry_sl_price >= entry) or (req.side == TradeSide.SELL and req.entry_sl_price <= entry):
            raise HTTPException(status_code=400, detail="Long stop must be below entry; short stop must be above entry")

    # Resolve quantity: either from funds_ratio_pct (FundsRatio mode) or explicit quantity
    if req.funds_ratio_pct is not None:
        if req.funds_ratio_pct <= 0 or req.funds_ratio_pct > 1:
            raise HTTPException(status_code=400, detail="funds_ratio_pct must be between 0 and 1")
        # Price for quantity computation: trigger for TARGET/SL, limit for LIMIT
        ratio_price = req.trigger_price if req.order_type in (OrderType.TARGET, OrderType.STOPLOSS) else req.limit_price
        if ratio_price is None or ratio_price <= 0:
            raise HTTPException(status_code=400, detail="A valid price is required for FundsRatio quantity computation")
        try:
            current_wallet = _wallet_balance_for_session(session)
            quantity = order_service.compute_funds_ratio_quantity(
                symbol=session.symbol,
                price=ratio_price,
                session_capital=session.session_capital,
                funds_ratio_pct=req.funds_ratio_pct,
                current_wallet=current_wallet,
                lot_size=lot_size,
                margin_rate=order_margin_rate,
            )
        except InsufficientFundsError as exc:
            raise HTTPException(status_code=402, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    elif req.risk_pct is not None or req.risk_ratio_pct is not None:
        if req.risk_pct is not None:
            if req.risk_pct <= 0 or req.risk_pct > 100:
                raise HTTPException(status_code=400, detail="risk_pct must be greater than 0 and at most 100")
            risk_fraction = req.risk_pct / 100.0
        else:
            # Backward compatibility for existing clients that send fractions.
            if req.risk_ratio_pct <= 0 or req.risk_ratio_pct > 1:
                raise HTTPException(status_code=400, detail="risk_ratio_pct must be between 0 and 1")
            risk_fraction = req.risk_ratio_pct

        # Entry price: trigger for TARGET/SL, limit for LIMIT
        entry_price = req.trigger_price if req.order_type in (OrderType.TARGET, OrderType.STOPLOSS) else req.limit_price
        if entry_price is None or entry_price <= 0:
            raise HTTPException(status_code=400, detail="A valid price is required for RiskRatio quantity computation")

        # Determine stoploss price
        sl_price = req.entry_sl_price  # user-provided SL
        if sl_price is None:
            # Use default SL % from user settings
            from app.services.user_settings_service import get_settings
            settings = get_settings(session.user_id)
            default_sl_pct = settings.get("default_sl_pct", 0.20)
            if req.side == TradeSide.BUY:
                sl_price = entry_price * (1 - default_sl_pct)
            else:
                sl_price = entry_price * (1 + default_sl_pct)

        try:
            current_wallet = _wallet_balance_for_session(session)
            quantity = order_service.compute_risk_ratio_quantity(
                symbol=session.symbol,
                entry_price=entry_price,
                stoploss_price=sl_price,
                session_capital=session.session_capital,
                risk_ratio_pct=risk_fraction,
                current_wallet=current_wallet,
                lot_size=lot_size,
                margin_rate=order_margin_rate,
                allow_minimum_share_over_risk=session.session_type in ("paper", "sim", "stepwise"),
            )
        except InsufficientFundsError as exc:
            raise HTTPException(status_code=402, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        if req.quantity is None or req.quantity < 1:
            raise HTTPException(status_code=400, detail="quantity must be at least 1")
        quantity = req.quantity

    if order_right is not None and (quantity < lot_size or quantity % lot_size):
        raise HTTPException(status_code=400, detail=f"Option quantity must be a positive multiple of {lot_size}")

    # Auto-split large options orders that exceed per-symbol max contracts limit.
    # qty_chunks[0] goes through the existing full code path below.
    # Any additional chunks are created afterwards using the same parameters.
    from types import SimpleNamespace
    is_real_exit = session.session_type == "real" and sim_svc._is_position_exit(session,
        SimpleNamespace(side=req.side, right=order_right, strike=order_strike, expiry=order_expiry))
    if order_right is not None and (req.is_stoploss or (is_real_exit and req.order_type in (OrderType.STOPLOSS, OrderType.LIMIT))):
        qty_chunks = order_service.split_quantity(session.symbol, quantity)
        quantity = qty_chunks[0]  # first chunk processed by existing code
    else:
        qty_chunks = [quantity]

    if req.order_type in (OrderType.TARGET, OrderType.LIMIT) and not req.is_stoploss:
        from app.services.guardrail_service import check_maxsize
        maxsize_price = req.limit_price if req.order_type == OrderType.LIMIT else req.trigger_price
        if maxsize_price is not None and maxsize_price > 0:
            blocked, reason = check_maxsize(session, maxsize_price, quantity, req.side.value, right=order_right, strike=order_strike, expiry=order_expiry)
            if blocked:
                raise HTTPException(status_code=403, detail=reason)

    try:
        order = order_service.place_order(
            session_id=req.session_id,
            symbol=session.symbol,
            side=req.side,
            order_type=req.order_type,
            quantity=quantity,
            created_at=int(session.current_time),
            trading_date=session.date,
            trigger_price=req.trigger_price,
            limit_price=req.limit_price,
            is_stoploss=req.is_stoploss,
            right=order_right,
            strike=order_strike,
            expiry=order_expiry,
            target_deviation_pct=req.target_deviation_pct,
            user_id=session.user_id,
            margin_rate=order_margin_rate,
            entry_sl_price=req.entry_sl_price,
            group_id=req.group_id,
            source=_desktop_order_source(session),
            quote_price=req.quote_price,
            quote_timestamp=req.quote_timestamp,
            quote_source=req.quote_source,
            market_order=req.market_order,
            wallet_ledger_id=_reservation_ledger_id(session),
            wallet_ledger_kind=_ledger_kind(session),
        )
    except InsufficientFundsError as exc:
        raise HTTPException(status_code=402, detail=str(exc))

    if req.execute_immediately and session.session_type == "real":
        if order.order_type != OrderType.LIMIT:
            order_service.cancel_order(session.session_id, order.order_id, session.date)
            raise HTTPException(status_code=400, detail="Immediate execution requires a marketable LIMIT")
        try:
            from app.services.broker_order_service import submit_immediate
            submit_immediate(session, order, asyncio.get_running_loop())
        except Exception as exc:
            if not order.kotak_order_id:
                order_service.cancel_order(session.session_id, order.order_id, session.date)
            raise HTTPException(status_code=502, detail=f"Broker placement failed: {exc}") from exc

    # Resting exits are broker-backed; new position orders are local triggers.
    if session.session_type == "real" and order.order_type in (OrderType.STOPLOSS, OrderType.LIMIT):
        try:
            sim_svc._register_kotak_sl_for_order(session, order, asyncio.get_running_loop())
        except Exception as exc:
            order_service.cancel_order(session.session_id, order.order_id, session.date)
            logger.warning("broker_exit_place_failed session=%s order=%s: %s", session.session_id, order.order_id, exc)
            raise HTTPException(status_code=502, detail=f"Broker exit placement failed: {exc}") from exc

    try:
        session.queue.put_nowait(json.dumps({
            "type": "order_placed",
            "order_id": order.order_id,
            "session_id": order.session_id,
            "user_id": order.user_id,
            "symbol": order.symbol,
            "side": order.side.value,
            "order_type": order.order_type.value,
            "quantity": order.quantity,
            "trigger_price": order.trigger_price,
            "limit_price": order.limit_price,
            "status": order.status.value,
            "created_at": order.created_at,
            "filled_at": order.filled_at,
            "filled_price": order.filled_price,
            "is_stoploss": order.is_stoploss,
            "right": order.right,
            "strike": order.strike,
            "expiry": order.expiry,
        }))
    except Exception:
        pass

    # Place additional split orders (chunks 2..N) for large options SL orders
    if len(qty_chunks) > 1:
        import asyncio as _asyncio
        _loop = _asyncio.get_event_loop()
        for extra_qty in qty_chunks[1:]:
            extra_order = None
            try:
                extra_order = order_service.place_order(
                    session_id=req.session_id,
                    symbol=session.symbol,
                    side=req.side,
                    order_type=req.order_type,
                    quantity=extra_qty,
                    created_at=int(session.current_time),
                    trading_date=session.date,
                    trigger_price=req.trigger_price,
                    limit_price=req.limit_price,
                    entry_sl_price=req.entry_sl_price,
                    is_stoploss=req.is_stoploss,
                    right=order_right,
                    strike=order_strike,
                    expiry=order_expiry,
                    group_id=req.group_id,
                    user_id=session.user_id,
                    margin_rate=order_margin_rate,
                    source=_desktop_order_source(session),
                    market_order=req.market_order,
                    quote_price=req.quote_price,
                    wallet_ledger_id=_reservation_ledger_id(session),
                    wallet_ledger_kind=_ledger_kind(session),
                )
                if session.session_type == "real" and req.order_type in (OrderType.STOPLOSS, OrderType.LIMIT):
                    from app.services.simulation import _register_kotak_sl_for_order
                    _register_kotak_sl_for_order(session, extra_order, _loop)
                try:
                    session.queue.put_nowait(json.dumps({
                        "type": "order_placed",
                        "order_id": extra_order.order_id,
                        "session_id": extra_order.session_id,
                        "user_id": extra_order.user_id,
                        "symbol": extra_order.symbol,
                        "side": extra_order.side.value,
                        "order_type": extra_order.order_type.value,
                        "quantity": extra_order.quantity,
                        "trigger_price": extra_order.trigger_price,
                        "limit_price": extra_order.limit_price,
                        "status": extra_order.status.value,
                        "created_at": extra_order.created_at,
                        "filled_at": extra_order.filled_at,
                        "filled_price": extra_order.filled_price,
                        "is_stoploss": extra_order.is_stoploss,
                        "right": extra_order.right,
                        "strike": extra_order.strike,
                        "expiry": extra_order.expiry,
                    }))
                except Exception:
                    pass
            except Exception as exc:
                if extra_order and not extra_order.kotak_order_id:
                    order_service.cancel_order(session.session_id, extra_order.order_id, session.date)
                logger.warning("broker_split_exit_failed session=%s quantity=%d: %s", session.session_id, extra_qty, exc)
                session.queue.put_nowait(json.dumps({"type": "broker_error", "message": f"Additional exit chunk ({extra_qty}) failed: {exc}"}))

    return order


@router.get("", response_model=list[Order])
async def get_orders(session_id: str = Query(...), open_only: bool = Query(default=True)):
    if open_only:
        return order_service.get_open_orders(session_id)
    return order_service.get_all_orders(session_id)


@router.delete("/{order_id}", response_model=Order)
async def cancel_order(order_id: str, session_id: str = Query(...)):
    session = sim_svc.get_session(session_id)
    if session and session.session_type == "real" and getattr(session, "broker_refresh_events", None) is not None:
        raise HTTPException(status_code=409, detail="Broker refresh is in progress; retry shortly")
    trading_date = session.date if session else ""
    existing = order_service.get_order(session_id, order_id)
    if existing is None or existing.status != order_service.OrderStatus.PENDING:
        raise HTTPException(status_code=404, detail="Order not found or already closed")
    if existing.kotak_order_id:
        try:
            from app.services.kotak_service import get_service as get_kotak
            get_kotak().cancel_order(existing.kotak_order_id)
        except Exception as exc:
            logger.warning("broker_order_cancel_failed order=%s: %s", order_id, exc)
            raise HTTPException(status_code=502, detail=f"Broker rejected cancellation: {exc}") from exc
    order = order_service.cancel_order(session_id, order_id, trading_date)
    if session and session.session_type == "real":
        from app.services.real_protection import request
        request(session, reason="order_cancel")

    return order


@router.patch("/bulk-update-sl")
async def bulk_update_sl_route(req: BulkUpdateSLRequest):
    """
    Set all pending stoploss closing orders for a session's symbol/right to the same price.
    Pending LIMIT/TARGET exit orders are intentionally left unchanged.
    Handles Kotak real-trading orders too.
    """
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if req.trigger_price <= 0:
        raise HTTPException(status_code=400, detail="trigger_price must be positive")

    right = req.right.upper() if req.right else None
    closing_orders = [
        order for order in _get_closing_orders(session, right)
        if order.is_stoploss
    ]

    if not closing_orders:
        return {"updated": 0, "orders": []}

    updated_orders = []
    for order in closing_orders:
        update_kwargs = (
            {"limit_price": req.trigger_price}
            if order.order_type == OrderType.LIMIT
            else {"trigger_price": req.trigger_price}
        )
        updated_order = await update_order(order.order_id, UpdateOrderRequest(**update_kwargs), session_id=req.session_id)
        if updated_order:
            updated_orders.append(updated_order)

    return {"updated": len(updated_orders), "orders": updated_orders}


@router.patch("/bulk-convert")
async def bulk_convert_route(req: BulkConvertRequest):
    """Convert all pending closing orders for a session's right to a different type, keeping same price."""
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    right = req.right.upper() if req.right else None
    target_orders = _get_closing_orders(session, right)

    if not target_orders:
        return {"converted": 0, "orders": []}

    converted_orders = []
    for order in target_orders:
        converted = _convert_with_broker(session, order, req.new_order_type, req.price)
        if converted:
            converted_orders.append(converted)

    return {"converted": len(converted_orders), "orders": converted_orders}


@router.post("/{order_id}/convert", response_model=Order)
async def convert_order(order_id: str, req: ConvertOrderRequest):
    """Convert a PENDING order to a different type (TARGET↔LIMIT, STOPLOSS→LIMIT)."""
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    existing = order_service.get_order(req.session_id, order_id)
    if existing is None or existing.status != order_service.OrderStatus.PENDING:
        raise HTTPException(status_code=404, detail="Order not found or not pending")
    order = _convert_with_broker(session, existing, req.new_order_type, req.price)

    # Emit SSE event so the frontend updates the order in-place
    try:
        import json as _json
        session.queue.put_nowait(_json.dumps({
            "type": "order_converted",
            "order_id": order.order_id,
            "new_order_type": order.order_type.value,
            "trigger_price": order.trigger_price,
            "limit_price": order.limit_price,
            "is_stoploss": order.is_stoploss,
        }))
    except Exception:
        pass

    return order


@router.patch("/{order_id}", response_model=Order)
async def update_order(order_id: str, req: UpdateOrderRequest, session_id: str = Query(...)):
    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    existing = order_service.get_order(session_id, order_id)
    if existing is None or existing.status != order_service.OrderStatus.PENDING:
        raise HTTPException(status_code=404, detail="Order not found or not pending")
    if req.trigger_price is None and req.limit_price is None and req.quantity is None:
        raise HTTPException(status_code=400, detail="Provide trigger_price, limit_price, or quantity to update")
    if req.quantity is not None and req.quantity != existing.quantity:
        if not (existing.is_stoploss or existing.order_type == OrderType.STOPLOSS):
            raise HTTPException(status_code=400, detail="Quantity can only be updated for pending stop-loss orders")
        lot_size = LOT_SIZES.get(session.symbol, 1) if existing.right else 1
        if req.quantity < lot_size or req.quantity % lot_size != 0:
            raise HTTPException(status_code=400, detail=f"Stop-loss quantity must be a positive multiple of {lot_size}")
        available, position_quantity = _stoploss_available_quantity(
            session, existing.right, existing.strike, existing.expiry, exclude_order_id=order_id,
            broker_product=existing.broker_product or "MIS", broker_exchange=existing.broker_exchange,
        )
        already_filled = existing.broker_filled_quantity if session.session_type == "real" else 0
        if session.session_type == "real" and req.quantity <= already_filled:
            raise HTTPException(status_code=400, detail="Pending exit quantity must exceed its filled quantity; cancel the order to remove the remaining exit")
        if req.quantity > available + already_filled:
            raise HTTPException(
                status_code=400,
                detail=f"Stop-loss quantity exceeds available uncovered position ({available} of {position_quantity})",
            )

    if existing.order_type != OrderType.LIMIT and req.limit_price is not None:
        raise HTTPException(status_code=400, detail="Target and stoploss limits are calculated from their trigger")
    candidate = existing.model_copy(deep=True)
    for name in ("trigger_price", "limit_price", "quantity"):
        value = getattr(req, name)
        if value is not None:
            setattr(candidate, name, value)
    _sync_kotak_after_convert(session, candidate, candidate.order_type, reprice=req.trigger_price is not None or req.limit_price is not None)

    order = order_service.update_order(
        session_id=session_id,
        order_id=order_id,
        trading_date=session.date,
        trigger_price=req.trigger_price,
        limit_price=req.limit_price,
        quantity=req.quantity,
        target_deviation_pct=req.target_deviation_pct,
        execution_gap_pct=candidate.execution_gap_pct,
    )
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found or not pending")

    order.kotak_order_id = candidate.kotak_order_id
    order.execution_role = candidate.execution_role
    order_service._write_order_to_db(order)
    return order
