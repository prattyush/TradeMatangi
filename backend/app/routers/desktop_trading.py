"""Desktop trading facade for the chart cockpit.

This router keeps the desktop app on a versioned API while reusing the
existing simulation, order, strategy, wallet, and trade services as the source
of truth for Stepwise and desktop Replay trading.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.dependencies import get_desktop_user_id
from app.models.schemas import (
    CancelAllStrategiesRequest,
    ConvertOrderRequest,
    Order,
    OrderType,
    PlaceOrderRequest,
    SimulationStartRequest,
    SimulationStartResponse,
    StartStrategyRequest,
    StrategyResponse,
    TradeSide,
    UpdateOrderRequest,
    UpdateStrategyPriceRequest,
    WalletResetRequest,
)
from app.routers import simulation as simulation_router
from app.services import order_service, options_service, simulation as sim_svc, strategy_service, trading as trading_service, wallet_service
from app.services.user_settings_service import get_settings, update_settings

router = APIRouter(prefix="/api/desktop/v1/trading", tags=["desktop"])


class DesktopTradingSnapshot(BaseModel):
    version: int = 1
    desktop_mode: str = "stepwise"
    source: str = "desktop_stepwise"
    session: SimulationStartResponse
    current_time: int = 0
    current_bar_index: int = 0
    current_price: float
    current_price_ce: float
    current_price_pe: float
    contract_quotes: dict[str, dict] = {}
    trades: list[dict]
    open_orders: list[Order]
    strategies: list[StrategyResponse]
    positions: dict
    contracts: list[dict] = []
    positions_by_contract: dict[str, dict] = {}
    wallet_balance: float
    pnl: dict
    settings: dict


class DesktopOptionContract(BaseModel):
    symbol: str
    expiry: str
    strike: int
    right: str


class AttachContractRequest(DesktopOptionContract):
    pass


class ChartOrderIntent(BaseModel):
    """An entry selected from a specific option chart.

    Market orders deliberately carry no renderer-computed price.  The server
    resolves the chart contract's quote and records the resulting proxy limit.
    """
    symbol: str
    expiry: str
    strike: int
    right: str
    side: TradeSide
    intent: str = Field(pattern="^(market|limit|target)$")
    price: float | None = Field(default=None, gt=0)
    quantity: int | None = Field(default=None, ge=1)
    funds_ratio_pct: float | None = None
    risk_pct: float | None = None
    entry_sl_price: float | None = Field(default=None, gt=0)
    group_id: str | None = None
    target_deviation_pct: float = 0.01


class FlattenRequest(BaseModel):
    right: str | None = None
    strike: int | None = None
    expiry: str | None = None
    emergency_offset_pct: float = Field(default=0.03, ge=0.001, le=0.25)


class BulkChartConvertRequest(BaseModel):
    new_order_type: OrderType
    right: str | None = None
    strike: int | None = None
    expiry: str | None = None
    price: float = Field(gt=0)


class BulkChartUpdateSLRequest(BaseModel):
    trigger_price: float = Field(gt=0)
    right: str | None = None
    strike: int | None = None
    expiry: str | None = None


class DesktopSettingsUpdateRequest(BaseModel):
    settings: dict


class DesktopLabelMetadata(BaseModel):
    categories: list[str] = []
    strategies: list[str] = []
    entry_tags: list[str] = []
    exit_tags: list[str] = []


class DesktopTradeLabelRequest(BaseModel):
    round_trip_index: int = Field(ge=0)
    expected_category: str = ""
    expected_strategy: str = ""
    actual_category: str = ""
    actual_strategy: str = ""
    entry_tag: str = "AS_PER_PATTERN"
    exit_tag: str = "AS_PER_PATTERN"


class DesktopTradingStartRequest(SimulationStartRequest):
    desktop_mode: str = Field(default="stepwise", pattern="^(stepwise|replay)$")


def _desktop_mode(session) -> str:
    return str(getattr(session, "desktop_mode", "") or ("stepwise" if session.session_type == "stepwise" else "replay" if getattr(session, "desktop_origin", None) == "desktop_replay" else session.session_type))


def _desktop_source(session) -> str:
    return "desktop_replay" if _desktop_mode(session) == "replay" else "desktop_stepwise"


def _require_session(session_id: str, user_id: str):
    session = sim_svc.get_session(session_id)
    if not session or session.user_id != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


def _session_response(session) -> SimulationStartResponse:
    return simulation_router._session_response(session)


def _contract_key(symbol: str, expiry: str | None, strike: int | None, right: str | None) -> str:
    return f"{symbol}:{expiry or ''}:{strike or ''}:{(right or '').upper()}"


def _desktop_contracts(session) -> list[dict]:
    contracts = getattr(session, "desktop_contracts", None)
    if contracts is None:
        contracts = []
        setattr(session, "desktop_contracts", contracts)
    return contracts


def _normalise_contract(req: DesktopOptionContract) -> dict:
    right = req.right.upper()
    if right not in ("CE", "PE"):
        raise HTTPException(status_code=400, detail="right must be CE or PE")
    return {
        "symbol": req.symbol,
        "expiry": req.expiry,
        "strike": int(req.strike),
        "right": right,
        "contract_key": _contract_key(req.symbol, req.expiry, int(req.strike), right),
    }


def _get_registered_contract(session, right: str | None, strike: int | None, expiry: str | None) -> dict | None:
    if not right or strike is None or not expiry:
        return None
    key = _contract_key(session.symbol, expiry, int(strike), right)
    return next((item for item in _desktop_contracts(session) if item.get("contract_key") == key), None)


def _require_registered_contract(session, right: str | None, strike: int | None, expiry: str | None) -> dict:
    contract = _get_registered_contract(session, right, strike, expiry)
    if not contract:
        raise HTTPException(status_code=400, detail="Option contract is not attached to this desktop trading session")
    return contract


def _register_contract(session, contract: dict) -> dict:
    contracts = _desktop_contracts(session)
    existing = next((item for item in contracts if item.get("contract_key") == contract["contract_key"]), None)
    if existing:
        return existing
    contracts.append(contract)
    return contract


def _quote_registry(session) -> dict[str, dict]:
    registry = getattr(session, "desktop_contract_quotes", None)
    if registry is None:
        registry = {}
        setattr(session, "desktop_contract_quotes", registry)
    return registry


def _historical_contract_quote(session, contract: dict) -> dict | None:
    """Resolve the quote at the shared simulation clock, caching a contract's ticks.

    This makes attached strikes first-class even though the legacy simulator
    only maintains CE/PE convenience prices for its primary streams.
    """
    current_time = int(session.current_time or 0)
    if current_time <= 0:
        return None
    cache = getattr(session, "desktop_contract_quote_ticks", None)
    if cache is None:
        cache = {}
        setattr(session, "desktop_contract_quote_ticks", cache)
    key = contract["contract_key"]
    ticks = cache.get(key)
    if ticks is None:
        try:
            from app.services.options_service import options_iter_ticks
            ticks = list(options_iter_ticks(session.symbol, session.date, contract["strike"], contract["expiry"], contract["right"], session.start_time))
        except Exception:
            ticks = []
        cache[key] = ticks
    eligible = [tick for tick in ticks if int(tick.get("time", 0)) <= current_time]
    if eligible:
        tick = eligible[-1]
        return {"price": float(tick["close"]), "timestamp": int(tick["time"]), "source": "historical_stepwise"}
    # Existing sessions/tests that have not loaded source data retain the
    # historic CE/PE values as a compatibility fallback only for that exact
    # active contract.
    active_strike = session.strike_ce if contract["right"] == "CE" else session.strike_pe
    if int(active_strike or 0) == int(contract["strike"]):
        price = session.last_price_ce if contract["right"] == "CE" else session.last_price_pe
        if price:
            return {"price": float(price), "timestamp": current_time, "source": "historical_stepwise"}
    return None


def _refresh_contract_quotes(session) -> dict[str, dict]:
    registry = _quote_registry(session)
    for contract in _desktop_contracts(session):
        quote = _historical_contract_quote(session, contract) if session.session_type in ("stepwise", "sim") else registry.get(contract["contract_key"])
        if quote:
            registry[contract["contract_key"]] = {**contract, **quote}
    return registry


def _has_open_contract_risk(session, contract: dict) -> bool:
    position = _position_for(session, contract["right"], contract["strike"], contract["expiry"])
    if position.side != "FLAT" and position.quantity > 0:
        return True
    for order in order_service.get_open_orders(session.session_id):
        if (
            order.symbol == contract["symbol"]
            and (order.right or "").upper() == contract["right"]
            and int(order.strike or 0) == int(contract["strike"])
            and (order.expiry or "") == contract["expiry"]
        ):
            return True
    return False


def _assert_can_switch_active_right(session, contract: dict) -> None:
    for existing in _desktop_contracts(session):
        if existing["right"] != contract["right"] or existing["contract_key"] == contract["contract_key"]:
            continue
        if _has_open_contract_risk(session, existing):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Close open {existing['symbol']} {existing['strike']} {existing['right']} "
                    "orders/position before switching this right to another strike"
                ),
            )
    for strategy in strategy_service.list_running(session.session_id):
        if strategy.right == contract["right"] and strategy.metadata.get("desktop_contract_key") != contract["contract_key"]:
            raise HTTPException(
                status_code=409,
                detail=f"Cancel the active {contract['right']} strategy before switching this right to another strike",
            )


def _seed_underlying_options_request(req: SimulationStartRequest) -> None:
    """Resolve expiry/ATM for desktop sessions that start from only the underlying chart."""
    if req.instrument_type != "options" or (req.strike is not None and req.expiry):
        return
    expiry = req.expiry or options_service.get_expiry_date(req.symbol, req.date)
    start_time = req.start_time if len(req.start_time) == 8 else f"{req.start_time}:00"
    ts = int(datetime.strptime(f"{req.date} {start_time}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp())
    underlying = options_service.get_underlying_price_at(req.symbol, req.date, ts)
    if underlying is None or underlying <= 0:
        simulation_router._ensure_session_data(req.symbol, req.date)
        underlying = options_service.get_underlying_price_at(req.symbol, req.date, ts)
    if underlying is None or underlying <= 0:
        raise HTTPException(status_code=400, detail="Could not resolve ATM strike from the underlying chart for this date/start time")
    atm = options_service.get_atm_strike(req.symbol, underlying)
    req.expiry = expiry
    req.strike = atm
    req.strike_ce = req.strike_ce if req.strike_ce is not None else atm
    req.strike_pe = req.strike_pe if req.strike_pe is not None else atm
    req.right = None


def _strategy_response(instance) -> StrategyResponse:
    metadata = instance.metadata
    price = None
    if instance.strategy_type in ("TargetProfit", "UnderlyingTargetProfit"):
        value = metadata.get("target_profit_value")
        if value is not None and not metadata.get("target_profit_is_pct", False):
            price = float(value)
    elif instance.strategy_type == "LockProfit":
        value = metadata.get("lock_profit_price", metadata.get("lock_profit_value"))
        if value is not None and not metadata.get("lock_profit_is_pct", False):
            price = float(value)
    elif instance.strategy_type == "UnderlyingStoploss":
        value = metadata.get("underlying_sl_price")
        if value is not None:
            price = float(value)
    return StrategyResponse(
        strategy_id=instance.strategy_id,
        strategy_type=instance.strategy_type,
        symbol=instance.symbol,
        right=instance.right,
        status=instance.status.value,
        triggered=bool(instance.metadata.get("triggered", False)),
        price=price,
        strike=instance.metadata.get("desktop_strike"),
        expiry=instance.metadata.get("desktop_expiry"),
        contract_key=instance.metadata.get("desktop_contract_key"),
    )


def _last_price_for_right(session, right: str | None, strike: int | None = None, expiry: str | None = None) -> float:
    if session.instrument_type == "options":
        contract = _get_registered_contract(session, right, strike, expiry)
        if contract:
            quote = _refresh_contract_quotes(session).get(contract["contract_key"])
            if quote:
                return float(quote["price"])
        if right == "CE":
            return float(session.last_price_ce or 0)
        if right == "PE":
            return float(session.last_price_pe or 0)
    return float(session.last_price or 0)


def _position_for(session, right: str | None, strike: int | None = None, expiry: str | None = None):
    return trading_service.get_position(session.session_id, session.symbol, right=right, strike=strike, expiry=expiry)


def _estimate_exit_commission(session, side: TradeSide, price: float, quantity: int) -> float:
    if price <= 0 or quantity <= 0:
        return 0.0
    return trading_service.compute_commission(side, price, quantity, session.brokerage_per_order)


def _position_pnl(session, right: str | None, strike: int | None = None, expiry: str | None = None) -> float:
    position = _position_for(session, right, strike, expiry)
    price = _last_price_for_right(session, right, strike, expiry)
    if position.side == "FLAT" or price <= 0:
        return 0.0
    direction = 1 if position.side == "LONG" else -1
    exit_side = TradeSide.SELL if position.side == "LONG" else TradeSide.BUY
    return round(
        direction * position.quantity * (price - position.avg_entry_price)
        - position.entry_commission
        - _estimate_exit_commission(session, exit_side, price, position.quantity),
        2,
    )


def _day_pnl(session) -> float:
    """Return realised cash flow plus the market value of still-open lots.

    Trade cash flow already includes the original entry debit/credit.  Adding
    `_position_pnl` to it therefore subtracts an open entry a second time.
    Marking each remaining lot at its contract quote produces the proper
    realised + unrealised session P&L instead.
    """
    trades = trading_service.get_trades(session.session_id)
    net = 0.0
    for trade in trades:
        net += trade.quantity * trade.price if trade.side == TradeSide.SELL else -trade.quantity * trade.price
        net -= trade.commission or 0

    if session.instrument_type == "options":
        contracts = _desktop_contracts(session)
        if contracts:
            for item in contracts:
                position = _position_for(session, item["right"], item["strike"], item["expiry"])
                price = _last_price_for_right(session, item["right"], item["strike"], item["expiry"])
                if position.side != "FLAT" and price > 0:
                    net += position.quantity * price if position.side == "LONG" else -position.quantity * price
        else:
            for right in ("CE", "PE"):
                position = _position_for(session, right)
                price = _last_price_for_right(session, right)
                if position.side != "FLAT" and price > 0:
                    net += position.quantity * price if position.side == "LONG" else -position.quantity * price
    else:
        position = _position_for(session, None)
        price = _last_price_for_right(session, None)
        if position.side != "FLAT" and price > 0:
            net += position.quantity * price if position.side == "LONG" else -position.quantity * price
    return round(net, 2)


def _snapshot(session, user_id: str) -> DesktopTradingSnapshot:
    wallet = wallet_service.get_ledger_balance(user_id, session.date, session.wallet_ledger_id)
    strategies = [_strategy_response(item) for item in strategy_service.list_running(session.session_id)]
    day_pnl = _day_pnl(session)
    session_capital = float(session.session_capital or 0)
    pnl_pct = round((day_pnl / session_capital) * 100, 2) if session_capital > 0 else 0.0
    settings = get_settings(user_id)
    contracts = _desktop_contracts(session)
    quotes = _refresh_contract_quotes(session)
    positions_by_contract = {
        item["contract_key"]: _position_for(session, item["right"], item["strike"], item["expiry"]).model_dump(mode="json")
        for item in contracts
    }
    return DesktopTradingSnapshot(
        desktop_mode=_desktop_mode(session),
        source=_desktop_source(session),
        session=_session_response(session),
        current_time=int(session.current_time or 0),
        current_bar_index=int(session.current_bar_index or 0),
        current_price=float(session.last_price or 0),
        current_price_ce=float(session.last_price_ce or 0),
        current_price_pe=float(session.last_price_pe or 0),
        contract_quotes=quotes,
        trades=[trade.model_dump(mode="json") for trade in trading_service.get_trades(session.session_id)],
        open_orders=order_service.get_open_orders(session.session_id),
        strategies=strategies,
        positions={
            "equity": _position_for(session, None).model_dump(mode="json"),
            "CE": _position_for(session, "CE").model_dump(mode="json"),
            "PE": _position_for(session, "PE").model_dump(mode="json"),
        },
        contracts=contracts,
        positions_by_contract=positions_by_contract,
        wallet_balance=wallet,
        pnl={
            "equity": _position_pnl(session, None),
            "ce": _position_pnl(session, "CE"),
            "pe": _position_pnl(session, "PE"),
            "contracts": {
                item["contract_key"]: _position_pnl(session, item["right"], item["strike"], item["expiry"])
                for item in contracts
            },
            "day": day_pnl,
            "day_pct": pnl_pct,
        },
        settings={
            "desktop_hide_chart_labels": settings.get("desktop_hide_chart_labels", False),
            "desktop_order_size_mode": settings.get("desktop_order_size_mode", "quantity"),
            "desktop_pnl_display_mode": settings.get("desktop_pnl_display_mode", "currency"),
            "desktop_confirm_flatten": settings.get("desktop_confirm_flatten", True),
            "context_menu_sl_mode": settings.get("context_menu_sl_mode", "longOnly"),
            "target_deviation_pct": settings.get("target_deviation_pct", 0.01),
            "funds_ratio_l_pct": settings.get("funds_ratio_l_pct", 0.03),
            "funds_ratio_m_pct": settings.get("funds_ratio_m_pct", 0.06),
            "funds_ratio_h_pct": settings.get("funds_ratio_h_pct", 0.12),
            "risk_ratio_l_pct": settings.get("risk_ratio_l_pct", 1.0),
            "risk_ratio_m_pct": settings.get("risk_ratio_m_pct", 2.0),
            "risk_ratio_h_pct": settings.get("risk_ratio_h_pct", 4.0),
            "default_sl_pct": settings.get("default_sl_pct", 0.20),
        },
    )


def _desktop_label_state(session) -> dict:
    """Expose in-session, contract-aware label slots for desktop historical sessions."""
    if session.session_type not in ("stepwise", "sim"):
        raise HTTPException(status_code=409, detail="Trade labels are available only for desktop historical sessions")
    from app.services import trade_label_service
    trades = [trade.model_dump(mode="json") for trade in trading_service.get_trades(session.session_id)]
    completed, open_trips = trade_label_service.compute_round_trip_state(trades)
    return {
        "completed": completed,
        "open": open_trips,
        "labels": trade_label_service.get_labels_for_session(session.session_id),
    }


def _emit_order_event(session, event: dict) -> None:
    try:
        import json
        session.queue.put_nowait(json.dumps(event))
    except Exception:
        pass


def _emit_order_converted(session, order: Order) -> None:
    _emit_order_event(session, {
        "type": "order_converted",
        "order_id": order.order_id,
        "new_order_type": order.order_type.value,
        "trigger_price": order.trigger_price,
        "limit_price": order.limit_price,
        "is_stoploss": order.is_stoploss,
    })


def _is_closing_order(order: Order, position) -> bool:
    return (
        position.side != "FLAT"
        and (
            (position.side == "LONG" and order.side == TradeSide.SELL)
            or (position.side == "SHORT" and order.side == TradeSide.BUY)
        )
    )


def _closing_orders(session, right: str | None, strike: int | None = None, expiry: str | None = None) -> list[Order]:
    position = _position_for(session, right, strike, expiry)
    if position.side == "FLAT":
        return []
    return [
        order for order in order_service.get_open_orders(session.session_id)
        if (order.right or None) == right
        and (strike is None or order.strike == strike)
        and (expiry is None or order.expiry == expiry)
        and _is_closing_order(order, position)
    ]


def _target_scope(session, right: str | None, strike: int | None, expiry: str | None) -> tuple[str | None, int | None, str | None]:
    scoped_right = right.upper() if right else None
    if scoped_right and strike is not None and expiry:
        contract = _require_registered_contract(session, scoped_right, strike, expiry)
        return contract["right"], contract["strike"], contract["expiry"]
    return scoped_right, strike, expiry


@router.post("/start", response_model=DesktopTradingSnapshot, status_code=201)
async def start_desktop_trading(req: DesktopTradingStartRequest, user_id: str = Depends(get_desktop_user_id)):
    if req.desktop_mode == "replay":
        req.session_type = "sim"
        req.stepwise = False
        req.speed = max(0.01, 1 / max(float(req.speed), 0.05))
    else:
        req.session_type = "stepwise"
        req.stepwise = True
    _seed_underlying_options_request(req)
    session_response = await simulation_router.start_simulation(req, user_id)
    session = _require_session(session_response.session_id, user_id)
    setattr(session, "desktop_mode", req.desktop_mode)
    setattr(session, "desktop_origin", _desktop_source(session))
    if session.instrument_type == "options" and req.expiry:
        if req.strike_ce is not None:
            _register_contract(session, _normalise_contract(DesktopOptionContract(symbol=session.symbol, expiry=req.expiry, strike=req.strike_ce, right="CE")))
        if req.strike_pe is not None:
            _register_contract(session, _normalise_contract(DesktopOptionContract(symbol=session.symbol, expiry=req.expiry, strike=req.strike_pe, right="PE")))
    return _snapshot(session, user_id)


@router.post("/{session_id}/contracts", response_model=DesktopTradingSnapshot)
async def attach_contract(session_id: str, req: AttachContractRequest, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    contract = _normalise_contract(req)
    if session.instrument_type != "options":
        raise HTTPException(status_code=400, detail="This desktop trading session is not configured for options")
    if contract["symbol"] != session.symbol:
        raise HTTPException(status_code=400, detail=f"This desktop trading session is locked to {session.symbol}. Open another screen to use {contract['symbol']}.")
    if session.expiry and contract["expiry"] != session.expiry:
        raise HTTPException(status_code=400, detail=f"This desktop trading session is locked to expiry {session.expiry}")
    if not session.expiry:
        session.expiry = contract["expiry"]
    _assert_can_switch_active_right(session, contract)
    simulation_router._ensure_options_data(session.symbol, session.date, contract["strike"], contract["expiry"], contract["right"])
    if contract["right"] == "CE":
        session.strike_ce = contract["strike"]
    else:
        session.strike_pe = contract["strike"]
    _register_contract(session, contract)
    return _snapshot(session, user_id)


@router.get("/active", response_model=DesktopTradingSnapshot | None)
async def active_stepwise(
    symbol: str | None = Query(default=None),
    date: str | None = Query(default=None),
    instrument_type: str | None = Query(default=None),
    desktop_mode: str | None = Query(default=None, pattern="^(stepwise|replay)$"),
    user_id: str = Depends(get_desktop_user_id),
):
    for session in list(sim_svc._sessions.values()):
        if session.user_id != user_id or session.state == sim_svc.SimulationState.ENDED:
            continue
        mode = _desktop_mode(session)
        if desktop_mode and mode != desktop_mode:
            continue
        if not desktop_mode and session.session_type != "stepwise":
            continue
        if symbol and session.symbol != symbol:
            continue
        if date and session.date != date:
            continue
        if instrument_type and session.instrument_type != instrument_type:
            continue
        return _snapshot(session, user_id)
    return None


@router.get("/{session_id}/snapshot", response_model=DesktopTradingSnapshot)
async def snapshot(session_id: str, user_id: str = Depends(get_desktop_user_id)):
    return _snapshot(_require_session(session_id, user_id), user_id)


@router.post("/{session_id}/stop")
async def stop_stepwise(session_id: str, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    sim_svc.stop_session(session)
    return {"status": "stopped"}


@router.post("/{session_id}/next-bar", response_model=DesktopTradingSnapshot)
async def next_bar(session_id: str, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    if not session.stepwise:
        raise HTTPException(status_code=400, detail="Session is not in stepwise mode")
    if session.state == sim_svc.SimulationState.ENDED:
        raise HTTPException(status_code=409, detail="Stepwise session has ended")
    previous_index = session.current_bar_index
    session.bar_paused_event.clear()
    session.step_event.set()
    try:
        await asyncio.wait_for(session.bar_paused_event.wait(), timeout=3)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=409, detail="Stepwise trading session did not complete the next bar")
    if session.current_bar_index <= previous_index:
        raise HTTPException(status_code=409, detail="Stepwise trading session did not advance")
    return _snapshot(session, user_id)


@router.post("/{session_id}/orders", response_model=Order)
async def place_order(session_id: str, req: PlaceOrderRequest, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    req.session_id = session_id
    if session.instrument_type == "options":
        right = req.right.upper() if req.right else None
        expiry = req.expiry or session.expiry
        strike = req.strike if req.strike is not None else (session.strike_ce if right == "CE" else session.strike_pe if right == "PE" else None)
        contract = _require_registered_contract(session, right, strike, expiry)
        req.right = contract["right"]
        req.strike = contract["strike"]
        req.expiry = contract["expiry"]
    from app.routers.orders import place_order as web_place_order
    return await web_place_order(req)


@router.post("/{session_id}/chart-orders", response_model=Order)
async def place_chart_order(session_id: str, intent: ChartOrderIntent, user_id: str = Depends(get_desktop_user_id)):
    """Place an option-chart entry without trusting a frontend market price."""
    session = _require_session(session_id, user_id)
    if session.instrument_type != "options":
        raise HTTPException(status_code=400, detail="Desktop chart entry is available only for option contracts")
    contract = _require_registered_contract(session, intent.right.upper(), intent.strike, intent.expiry)
    if intent.symbol != contract["symbol"]:
        raise HTTPException(status_code=400, detail="Chart contract symbol does not match the attached contract")
    quote = _refresh_contract_quotes(session).get(contract["contract_key"])
    if intent.intent == "market":
        if not quote or float(quote.get("price", 0)) <= 0:
            raise HTTPException(status_code=409, detail="No authoritative quote is available for this chart contract")
        quote_price = float(quote["price"])
        entry_price = round(quote_price * (1.01 if intent.side == TradeSide.BUY else 0.99), 2)
        order_type = OrderType.LIMIT
    else:
        if intent.price is None:
            raise HTTPException(status_code=422, detail="A chart-selected price is required for limit and target orders")
        quote_price = float(intent.price)
        entry_price = float(intent.price)
        order_type = OrderType.LIMIT if intent.intent == "limit" else OrderType.TARGET

    req = PlaceOrderRequest(
        session_id=session_id,
        side=intent.side,
        order_type=order_type,
        limit_price=entry_price if order_type == OrderType.LIMIT else None,
        trigger_price=entry_price if order_type == OrderType.TARGET else None,
        quantity=intent.quantity,
        funds_ratio_pct=intent.funds_ratio_pct,
        risk_pct=intent.risk_pct,
        entry_sl_price=intent.entry_sl_price,
        group_id=intent.group_id,
        target_deviation_pct=intent.target_deviation_pct,
        right=contract["right"], strike=contract["strike"], expiry=contract["expiry"],
        quote_price=quote_price,
        quote_timestamp=int(quote["timestamp"]) if quote else int(session.current_time or 0),
        quote_source=str(quote["source"]) if quote else "chart_selected",
    )
    from app.routers.orders import place_order as web_place_order
    return await web_place_order(req)


@router.patch("/{session_id}/orders/bulk-convert")
async def bulk_convert(session_id: str, req: BulkChartConvertRequest, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    right, strike, expiry = _target_scope(session, req.right, req.strike, req.expiry)
    converted: list[Order] = []
    for order in _closing_orders(session, right, strike, expiry):
        updated = order_service.convert_order(
            session_id=session_id,
            order_id=order.order_id,
            new_order_type=req.new_order_type,
            trading_date=session.date,
            price=req.price,
        )
        if updated:
            converted.append(updated)
            _emit_order_converted(session, updated)
    return {"converted": len(converted), "orders": converted}


@router.patch("/{session_id}/orders/bulk-update-sl")
async def bulk_update_sl(session_id: str, req: BulkChartUpdateSLRequest, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    right, strike, expiry = _target_scope(session, req.right, req.strike, req.expiry)
    updated: list[Order] = []
    for order in _closing_orders(session, right, strike, expiry):
        if not order.is_stoploss:
            continue
        result = order_service.update_order(
            session_id=session_id,
            order_id=order.order_id,
            trading_date=session.date,
            trigger_price=req.trigger_price,
        )
        if result:
            updated.append(result)
            _emit_order_event(session, {
                "type": "order_updated",
                "order_id": result.order_id,
                "trigger_price": result.trigger_price,
                "limit_price": result.limit_price,
                "is_stoploss": result.is_stoploss,
            })
    return {"updated": len(updated), "orders": updated}


@router.patch("/{session_id}/orders/{order_id}", response_model=Order)
async def update_order(session_id: str, order_id: str, req: UpdateOrderRequest, user_id: str = Depends(get_desktop_user_id)):
    _require_session(session_id, user_id)
    from app.routers.orders import update_order as web_update_order
    return await web_update_order(order_id, req, session_id=session_id)


@router.delete("/{session_id}/orders/{order_id}", response_model=Order | None)
async def cancel_order(session_id: str, order_id: str, user_id: str = Depends(get_desktop_user_id)):
    _require_session(session_id, user_id)
    from app.routers.orders import cancel_order as web_cancel_order
    return await web_cancel_order(order_id, session_id=session_id)


@router.post("/{session_id}/orders/{order_id}/convert", response_model=Order)
async def convert_order(session_id: str, order_id: str, req: ConvertOrderRequest, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    req.session_id = session_id
    from app.routers.orders import convert_order as web_convert_order
    return await web_convert_order(order_id, req)


@router.post("/{session_id}/strategies/start", response_model=StrategyResponse)
async def start_strategy(session_id: str, req: StartStrategyRequest, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    req.session_id = session_id
    contract = None
    if session.instrument_type == "options" and req.right:
        right = req.right.upper()
        strike = session.strike_ce if right == "CE" else session.strike_pe if right == "PE" else None
        contract = _require_registered_contract(session, right, strike, session.expiry)
    from app.routers.strategies import start_strategy as web_start_strategy
    response = web_start_strategy(req, user_id=user_id)
    if contract:
        strategy_id = response.strategy_id if isinstance(response, StrategyResponse) else response.get("strategy_id")
        instance = next((item for item in strategy_service.list_running(session_id) if item.strategy_id == strategy_id), None)
        if instance:
            instance.metadata.update({
                "desktop_contract_key": contract["contract_key"],
                "desktop_strike": contract["strike"],
                "desktop_expiry": contract["expiry"],
            })
            strategy_service._write_strategy_to_db(instance)
            return _strategy_response(instance)
    return response


@router.post("/{session_id}/strategies/cancel-all")
async def cancel_all_strategies(session_id: str, user_id: str = Depends(get_desktop_user_id)):
    _require_session(session_id, user_id)
    from app.routers.strategies import cancel_all_strategies as web_cancel_all
    return web_cancel_all(CancelAllStrategiesRequest(session_id=session_id), user_id=user_id)


@router.post("/{session_id}/strategies/{strategy_id}/cancel")
async def cancel_strategy(session_id: str, strategy_id: str, user_id: str = Depends(get_desktop_user_id)):
    _require_session(session_id, user_id)
    from app.routers.strategies import cancel_strategy as web_cancel_strategy
    return web_cancel_strategy(strategy_id, CancelAllStrategiesRequest(session_id=session_id), user_id=user_id)


@router.patch("/{session_id}/strategies/{strategy_id}/price")
async def update_strategy_price(session_id: str, strategy_id: str, req: UpdateStrategyPriceRequest, user_id: str = Depends(get_desktop_user_id)):
    _require_session(session_id, user_id)
    req.session_id = session_id
    from app.routers.strategies import update_strategy_price as web_update_price
    return web_update_price(strategy_id, req, user_id=user_id)


@router.post("/{session_id}/flatten")
async def flatten(session_id: str, req: FlattenRequest, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    if session.instrument_type == "options" and req.right and req.strike is not None and req.expiry:
        targets = [_require_registered_contract(session, req.right.upper(), req.strike, req.expiry)]
    elif session.instrument_type == "options" and req.right is None and _desktop_contracts(session):
        targets = _desktop_contracts(session)
    else:
        targets = [{"right": right, "strike": None, "expiry": None} for right in (["CE", "PE"] if session.instrument_type == "options" and req.right is None else [req.right])]
    result = {"converted": [], "created": [], "cancelled": []}
    for target in targets:
        right = target.get("right")
        strike = target.get("strike")
        expiry = target.get("expiry")
        position = _position_for(session, right, strike, expiry)
        if position.side == "FLAT" or position.quantity <= 0:
            continue
        exit_side = TradeSide.SELL if position.side == "LONG" else TradeSide.BUY
        price = _last_price_for_right(session, right, strike, expiry)
        if price <= 0:
            continue
        emergency_price = round(price * (1 - req.emergency_offset_pct), 2) if exit_side == TradeSide.SELL else round(price * (1 + req.emergency_offset_pct), 2)
        closers = _closing_orders(session, right, strike, expiry)
        if closers:
            for order in closers:
                converted = order_service.convert_order(session_id, order.order_id, OrderType.LIMIT, session.date, emergency_price)
                if converted:
                    result["converted"].append(converted.model_dump(mode="json"))
                    _emit_order_converted(session, converted)
        else:
            created = order_service.place_order(
                session_id=session_id,
                symbol=session.symbol,
                side=exit_side,
                order_type=OrderType.LIMIT,
                quantity=position.quantity,
                created_at=int(session.current_time) if session.current_time else 0,
                trading_date=session.date,
                limit_price=emergency_price,
                right=right,
                strike=strike if strike is not None else session.strike_ce if right == "CE" else session.strike_pe if right == "PE" else None,
                expiry=expiry if expiry is not None else session.expiry,
                user_id=user_id,
                source=_desktop_source(session),
            )
            result["created"].append(created.model_dump(mode="json"))
            _emit_order_event(session, {
                "type": "order_placed",
                "order_id": created.order_id,
                "session_id": created.session_id,
                "user_id": created.user_id,
                "symbol": created.symbol,
                "side": created.side.value,
                "order_type": created.order_type.value,
                "quantity": created.quantity,
                "trigger_price": created.trigger_price,
                "limit_price": created.limit_price,
                "status": created.status.value,
                "created_at": created.created_at,
                "filled_at": created.filled_at,
                "filled_price": created.filled_price,
                "is_stoploss": created.is_stoploss,
                "right": created.right,
                "strike": created.strike,
            })
    result["snapshot"] = _snapshot(session, user_id).model_dump(mode="json")
    return result


@router.get("/{session_id}/wallet")
async def wallet(session_id: str, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    return {"user_id": user_id, "date": session.date, "balance": wallet_service.get_ledger_balance(user_id, session.date, session.wallet_ledger_id)}


@router.post("/{session_id}/wallet/reset")
async def reset_wallet(session_id: str, req: WalletResetRequest, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    balance = wallet_service.reset_ledger(user_id, session.date, session.wallet_ledger_id, req.amount, "sim")
    return {"user_id": user_id, "date": session.date, "balance": balance}


@router.get("/{session_id}/trade-labels")
async def trade_labels(session_id: str, user_id: str = Depends(get_desktop_user_id)):
    return _desktop_label_state(_require_session(session_id, user_id))


@router.get("/trade-labels/metadata", response_model=DesktopLabelMetadata)
async def trade_label_metadata(user_id: str = Depends(get_desktop_user_id)):
    from app.services import pattern_logger_service, trade_label_service
    return DesktopLabelMetadata(
        categories=pattern_logger_service.list_category_names(user_id),
        strategies=pattern_logger_service.list_strategy_names(user_id),
        entry_tags=trade_label_service.list_entry_tags(user_id),
        exit_tags=trade_label_service.list_exit_tags(user_id),
    )


@router.post("/{session_id}/trade-labels")
async def save_trade_label(session_id: str, req: DesktopTradeLabelRequest, user_id: str = Depends(get_desktop_user_id)):
    session = _require_session(session_id, user_id)
    _desktop_label_state(session)  # validates Stepwise before writing
    from app.services import trade_label_service
    saved = trade_label_service.save_labels(session_id, [req.model_dump()], user_id)
    return {"label": saved[0] if saved else None, **_desktop_label_state(session)}


@router.get("/settings/current")
async def get_desktop_settings(user_id: str = Depends(get_desktop_user_id)):
    return get_settings(user_id)


@router.put("/settings/current")
async def update_desktop_settings(req: DesktopSettingsUpdateRequest, user_id: str = Depends(get_desktop_user_id)):
    return update_settings(user_id, req.settings)
