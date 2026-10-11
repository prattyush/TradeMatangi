"""Owned Swing portfolio actions, independent of dated intraday session controls."""

import asyncio
import json
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import Field, model_validator
from typing import Literal
from datetime import date as calendar_date
from app.dependencies import get_desktop_user_id
from app.models.schemas import ContractModel, TradeSide, OrderType
from app.services import (
    swing_portfolio_store as store,
    swing_portfolio_service as service,
)
from app.services import order_service, trading

router = APIRouter(prefix="/swing/portfolios", tags=["swing"])


class StartPortfolio(ContractModel):
    mode: Literal["paper"] = "paper"
    capital: float = Field(ge=0.01, allow_inf_nan=False)
    loss_limit_pct: float | None = Field(default=None, gt=0, le=1, allow_inf_nan=False)


class ContextRequest(ContractModel):
    symbol: str
    instrument_type: Literal["equity", "options"] = "equity"
    right: Literal["CE", "PE"] | None = None
    strike: int | float | None = Field(default=None, gt=0)
    expiry: str | None = None

    @model_validator(mode="after")
    def exact_contract(self):
        if self.instrument_type == "equity":
            if any(
                value is not None for value in (self.right, self.strike, self.expiry)
            ):
                raise ValueError(
                    "Equity requests cannot include option contract fields"
                )
        else:
            if self.right is None or self.strike is None or not self.expiry:
                raise ValueError("Options require right, strike and expiry")
            calendar_date.fromisoformat(self.expiry)
        return self


class PortfolioOrder(ContextRequest):
    side: TradeSide
    order_type: OrderType = OrderType.LIMIT
    quantity: int = Field(gt=0)
    price: float = Field(gt=0, allow_inf_nan=False)
    request_id: str = Field(min_length=1, max_length=100)


class PauseRequest(ContractModel):
    paused: bool


class ResetCapital(ContractModel):
    capital: float = Field(ge=0.01, allow_inf_nan=False)


@router.get("/active")
async def active(user: str = Depends(get_desktop_user_id)):
    portfolio = await asyncio.to_thread(store.active, user, "paper")
    if not portfolio:
        return {"portfolio": None}
    await service.ensure(user, portfolio["session_id"])
    return service.snapshot(user, portfolio["session_id"])


@router.post("")
async def start(req: StartPortfolio, user: str = Depends(get_desktop_user_id)):
    portfolio = await asyncio.to_thread(
        store.create, user, req.mode, req.capital, loss_limit_pct=req.loss_limit_pct
    )
    return service.snapshot(user, portfolio["session_id"])


@router.get("/{portfolio_id}")
async def snapshot(portfolio_id: str, user: str = Depends(get_desktop_user_id)):
    portfolio = await asyncio.to_thread(store.owned, user, portfolio_id)
    await service.ensure(user, portfolio_id)
    return service.snapshot(user, portfolio_id)


@router.post("/{portfolio_id}/contexts")
async def attach(
    portfolio_id: str, req: ContextRequest, user: str = Depends(get_desktop_user_id)
):
    await prepare_listed_contract(user, portfolio_id, req)
    child = service.attach_context(
        user,
        portfolio_id,
        req.symbol,
        req.instrument_type,
        req.strike,
        req.expiry,
        req.right,
    )
    return {"session_id": child.session_id, **service.snapshot(user, portfolio_id)}


@router.post("/{portfolio_id}/orders")
async def place(
    portfolio_id: str, req: PortfolioOrder, user: str = Depends(get_desktop_user_id)
):
    import uuid

    await service.ensure(user, portfolio_id)
    await prepare_listed_contract(user, portfolio_id, req)
    child = service.attach_context(
        user,
        portfolio_id,
        req.symbol,
        req.instrument_type,
        req.strike,
        req.expiry,
        req.right,
    )
    contract = next(
        (
            c
            for c in getattr(child, "desktop_contracts", [])
            if (c.get("strike"), c.get("expiry"), c.get("right"))
            == (req.strike, req.expiry, req.right)
        ),
        None,
    )
    if req.instrument_type == "options" and (
        not contract
        or not contract.get("lot_size")
        or req.quantity % contract["lot_size"]
    ):
        raise HTTPException(422, "Option quantity must be complete lots")
    if req.side == TradeSide.BUY and req.order_type == OrderType.STOPLOSS:
        raise HTTPException(
            422,
            "Swing entries use Limit or Target intentions; SL protects a held long position",
        )
    if req.side == TradeSide.SELL and req.order_type == OrderType.TARGET:
        raise HTTPException(
            422, "Use an SL/limit exit or a Target strategy for a held Swing position"
        )
    identifier = str(
        uuid.uuid5(uuid.NAMESPACE_URL, child.session_id + ":order:" + req.request_id)
    )
    from app.services.db import get_dynamodb_resource

    saved = await asyncio.to_thread(
        lambda: (
            get_dynamodb_resource()
            .Table("Orders")
            .get_item(
                Key={"session_id": child.session_id, "order_id": identifier},
                ConsistentRead=True,
            )
            .get("Item")
        )
    )
    if saved:
        matching = (
            saved.get("symbol") == req.symbol
            and saved.get("side") == req.side.value
            and saved.get("order_type") == req.order_type.value
            and int(saved["quantity"]) == req.quantity
            and float(saved["trigger_price"]) == req.price
            and saved.get("right") == req.right
            and saved.get("strike") == req.strike
            and saved.get("expiry") == req.expiry
        )
        if not matching:
            raise HTTPException(
                409, "Order request identity was reused with different instructions"
            )
        return {"order_id": identifier, **service.snapshot(user, portfolio_id)}
    service.require_entry_allowed(
        child, req.side, req.quantity, req.right, req.strike, req.expiry
    )
    held = trading.get_position(
        child.session_id, child.symbol, req.right, req.strike, req.expiry
    )
    if req.side == TradeSide.SELL:
        outstanding = sum(
            o.quantity
            for o in order_service.get_open_orders(child.session_id)
            if o.side == TradeSide.SELL
            and (o.right, o.strike, o.expiry) == (req.right, req.strike, req.expiry)
        )
        if outstanding + req.quantity > held.quantity:
            raise HTTPException(
                409,
                "Existing exits already cover this quantity; edit or cancel them first",
            )
    kwargs = (
        {"trigger_price": req.price}
        if req.order_type != OrderType.LIMIT
        else {"limit_price": req.price}
    )
    from app.services.swing_paper_recovery import current_market_timestamp

    order = order_service.place_order(
        child.session_id,
        child.symbol,
        req.side,
        req.order_type,
        req.quantity,
        current_market_timestamp(),
        child.date,
        **kwargs,
        right=req.right,
        strike=req.strike,
        expiry=req.expiry,
        user_id=user,
        source="swing_paper",
        order_id=identifier,
        margin_rate=1,
        wallet_ledger_id=child.wallet_ledger_id,
        wallet_ledger_kind="paper",
    )
    current = service.runtime(user, portfolio_id)
    current.emit({"type": "portfolio_snapshot", **service.snapshot(user, portfolio_id)})
    return {"order_id": order.order_id, **service.snapshot(user, portfolio_id)}


@router.post("/{portfolio_id}/pause")
async def pause(
    portfolio_id: str, req: PauseRequest, user: str = Depends(get_desktop_user_id)
):
    await service.ensure(user, portfolio_id)
    store.pause_entries(user, portfolio_id, req.paused)
    current = service.runtime(user, portfolio_id)
    for child in current.contexts.values():
        child.swing_entries_paused = req.paused
    result = service.snapshot(user, portfolio_id)
    current.emit({"type": "portfolio_snapshot", **result})
    return result


@router.post("/{portfolio_id}/capital")
async def reset_capital(
    portfolio_id: str, req: ResetCapital, user: str = Depends(get_desktop_user_id)
):
    await service.ensure(user, portfolio_id)
    current = service.snapshot(user, portfolio_id)
    if current["pnl"] is None:
        raise HTTPException(
            409, "Wait for position prices before resetting the guardrail period"
        )
    store.reset_guardrail_reference(user, portfolio_id, req.capital, current["pnl"])
    active = service.runtime(user, portfolio_id)
    row = store.owned(user, portfolio_id)
    for child in active.contexts.values():
        child.session_capital = req.capital
        child.swing_entries_paused = row["entries_paused"]
    result = service.snapshot(user, portfolio_id)
    active.emit({"type": "portfolio_snapshot", **result})
    return result


@router.post("/{portfolio_id}/close")
async def close(portfolio_id: str, user: str = Depends(get_desktop_user_id)):
    await service.close_portfolio(user, portfolio_id)
    return service.snapshot(user, portfolio_id)


@router.get("/{portfolio_id}/events")
async def events(portfolio_id: str, user: str = Depends(get_desktop_user_id)):
    store.owned(user, portfolio_id)
    current = await service.ensure(user, portfolio_id)

    async def stream():
        queue = asyncio.Queue(maxsize=64)
        current.subscribers.append(queue)
        try:
            yield (
                "event: snapshot\ndata: "
                + json.dumps(
                    {
                        "type": "portfolio_snapshot",
                        **service.snapshot(user, portfolio_id),
                    }
                )
                + "\n\n"
            )
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield "event: portfolio\ndata: " + json.dumps(event) + "\n\n"
        finally:
            if queue in current.subscribers:
                current.subscribers.remove(queue)

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.post("/{portfolio_id}/orders/{order_id}/cancel")
async def cancel(
    portfolio_id: str, order_id: str, user: str = Depends(get_desktop_user_id)
):
    current = await service.ensure(user, portfolio_id)
    for child in current.contexts.values():
        if order_id in order_service._orders.get(child.session_id, {}):
            order_service.cancel_order(child.session_id, order_id, child.date)
            result = service.snapshot(user, portfolio_id)
            current.emit({"type": "portfolio_snapshot", **result})
            return result
    raise HTTPException(404, "Portfolio order not found")


@router.get("/contracts/metadata")
async def option_metadata(symbol: str, user: str = Depends(get_desktop_user_id)):
    from app.services.breeze_master import listed_option_contracts
    from app.services.real_trading_day import market_date

    try:
        contracts = await asyncio.to_thread(listed_option_contracts, symbol)
    except FileNotFoundError as exc:
        raise HTTPException(503, "Option contract metadata is unavailable") from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {
        "symbol": symbol,
        "contracts": [c for c in contracts if c["expiry"] >= market_date()],
    }


async def prepare_listed_contract(user, portfolio_id, req):
    if req.instrument_type != "options":
        return
    current = service.runtime(user, portfolio_id)
    child = current.contexts.get(req.symbol + ":options")
    if child and any(
        (c.get("strike"), c.get("expiry"), c.get("right"))
        == (req.strike, req.expiry, req.right)
        for c in getattr(child, "desktop_contracts", [])
    ):
        return
    # Restoring existing contexts first preserves their frozen exact metadata.
    await service.ensure(user, portfolio_id)
    child = current.contexts.get(req.symbol + ":options")
    if child and any(
        (c.get("strike"), c.get("expiry"), c.get("right"))
        == (req.strike, req.expiry, req.right)
        for c in getattr(child, "desktop_contracts", [])
    ):
        return
    from app.services.breeze_master import listed_option_contract

    try:
        await asyncio.to_thread(
            listed_option_contract, req.symbol, req.strike, req.expiry, req.right
        )
    except FileNotFoundError as exc:
        raise HTTPException(503, "Option contract metadata is unavailable") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
