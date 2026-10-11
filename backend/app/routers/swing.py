"""Owned Swing portfolio actions, independent of dated intraday session controls."""

import asyncio
import json
import uuid
from datetime import date as calendar_date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import Field, model_validator

from app.dependencies import get_desktop_user_id
from app.models.schemas import ContractModel, OrderType, TradeSide
from app.services import order_service, trading
from app.services.real_recovery import CloseRequest
from app.services import (
    swing_portfolio_service as service,
)
from app.services import (
    swing_portfolio_store as store,
)

router = APIRouter(prefix="/swing/portfolios", tags=["swing"])


async def funding_action(action):
    try:
        return await action
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def portfolio_order(*args, **kwargs):
    from app.services.wallet_service import InsufficientFundsError
    try:
        return order_service.place_order(*args, **kwargs)
    except InsufficientFundsError as exc:
        raise HTTPException(402, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


class StartPortfolio(ContractModel):
    mode: Literal["paper", "real"] = "paper"
    execution_broker: Literal["kotak", "kite"] | None = None
    allocation_pct: float = Field(default=1, gt=0, le=1, allow_inf_nan=False)
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
    request_id: str = Field(default_factory=lambda: str(uuid.uuid4()), min_length=1, max_length=100)
    capital: float = Field(ge=0.01, allow_inf_nan=False)


@router.get("/capabilities")
async def capabilities(user: str = Depends(get_desktop_user_id)):
    from app.dependencies import require_real_trading_access
    try:
        require_real_trading_access(user)
    except HTTPException:
        return {"real_trading_enabled": False}
    return {"real_trading_enabled": True}


@router.get("/active")
async def active(mode: Literal["paper", "real"] = "paper", execution_broker: Literal["kotak", "kite"] | None = None, user: str = Depends(get_desktop_user_id)):
    if mode == "real":
        from app.dependencies import require_real_trading_access
        from app.services.user_settings_service import get_settings
        require_real_trading_access(user)
        execution_broker = execution_broker or (await asyncio.to_thread(get_settings, user, strict=True))["real_execution_broker"]
    portfolio = await asyncio.to_thread(store.active, user, mode, execution_broker)
    if not portfolio:
        return {"portfolio": None}
    await service.ensure(user, portfolio["session_id"])
    return service.snapshot(user, portfolio["session_id"])


@router.post("")
async def start(req: StartPortfolio, user: str = Depends(get_desktop_user_id)):
    if req.mode == "real":
        from app.services.swing_real import start as start_real
        portfolio = await funding_action(start_real(user, req))
        await service.ensure(user, portfolio["session_id"])
    else:
        portfolio = await asyncio.to_thread(
            store.create, user, req.mode, req.capital, loss_limit_pct=req.loss_limit_pct
        )
    return service.snapshot(user, portfolio["session_id"])


@router.get("/{portfolio_id}")
async def snapshot(portfolio_id: str, user: str = Depends(get_desktop_user_id)):
    await service.ensure(user, portfolio_id)
    return service.snapshot(user, portfolio_id)


@router.post("/{portfolio_id}/contexts")
async def attach(
    portfolio_id: str, req: ContextRequest, user: str = Depends(get_desktop_user_id)
):
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
    if child.session_type == "real":
        from app.services.swing_real import refresh
        await refresh(child)
    from app.routers.orders import _session_edit_lock
    async with _session_edit_lock(child):
        identifier = str(
            uuid.uuid5(uuid.NAMESPACE_URL, child.session_id + ":order:" + req.request_id)
        )
        from app.services.db import get_dynamodb_resource
        from app.services.execution_analytics import normalize_metadata
        from app.services.execution_analytics import snapshot as decision_snapshot
        from app.services.real_broker_state import active_partition

        saved = await asyncio.to_thread(
            lambda: (
                get_dynamodb_resource()
                .Table("Orders")
                .get_item(
                    Key={"session_id": active_partition(child.session_id) or child.session_id, "order_id": identifier},
                    ConsistentRead=True,
                )
                .get("Item")
            )
        )
        if saved:
            original_request = normalize_metadata((saved.get("analytics") or {}).get("swing_request"))
            matching = original_request == req.model_dump(mode="json") if original_request else (
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
                max(0, o.quantity - o.broker_filled_quantity)
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

        order = portfolio_order(
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
            analytics={**decision_snapshot(child, quantity=req.quantity, price=req.price, side=req.side.value, margin_rate=1, entry_method=req.order_type.value, action_id=identifier),
                       "swing_request": req.model_dump(mode="json")},
            source="swing_real" if child.session_type == "real" else "swing_paper",
            order_id=identifier,
            margin_rate=1,
            wallet_ledger_id=child.wallet_ledger_id,
            wallet_ledger_kind="real" if child.session_type == "real" else "paper",
        )
        if child.session_type == "real":
            try:
                from app.services.broker_order_service import submit_immediate
                if order.order_type == OrderType.LIMIT:
                    submit_immediate(child, order, asyncio.get_running_loop())
                elif order.order_type == OrderType.STOPLOSS:
                    from app.services import simulation
                    simulation._register_kotak_sl_for_order(child, order, asyncio.get_running_loop())
            except Exception as exc:  # noqa: BLE001 - preserve uncertain broker writes and return their recovery state
                if not order.broker_order_id and order.recovery_state not in ("submitting", "unknown"):
                    order_service.cancel_order(child.session_id, order.order_id, child.date)
                raise HTTPException(502, f"Broker placement needs review: {exc}") from exc
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
    if store.owned(user, portfolio_id)["mode"] == "real":
        from app.services.swing_real import reset_capital as reset_real_capital
        await funding_action(reset_real_capital(service.runtime(user, portfolio_id), req.capital, req.request_id))
        return service.snapshot(user, portfolio_id)
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
async def close(portfolio_id: str, user: str = Depends(get_desktop_user_id), req: CloseRequest | None = None):
    await service.close_portfolio(user, portfolio_id, req.acknowledge_undated_submission_ids if req else None)
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
                except TimeoutError:
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
            if child.session_type == "real":
                from app.routers.orders import cancel_order
                await cancel_order(order_id, child.session_id)
            else:
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


@router.post("/{portfolio_id}/reconcile")
async def reconcile_portfolio(portfolio_id: str, user: str = Depends(get_desktop_user_id)):
    current = await service.ensure(user, portfolio_id)
    row = store.owned(user, portfolio_id)
    if row["mode"] == "real":
        from app.services.real_recovery import verify
        from app.services.swing_real import refresh
        issues = []
        for child in current.contexts.values():
            verification = await verify(child)
            try:
                await refresh(child)
            except (ValueError, TypeError) as exc:
                issues.append({"session_id": child.session_id, "message": str(exc), **verification})
        result = service.snapshot(user, portfolio_id)
        result["recovery_issues"] = issues
        return result
    return service.snapshot(user, portfolio_id)


class ImportInventory(ContextRequest):
    fingerprint: str = Field(min_length=1, max_length=100)
    request_id: str = Field(min_length=1, max_length=100)


async def import_context(user, portfolio_id, req):
    await service.ensure(user, portfolio_id)
    if store.owned(user, portfolio_id)['mode'] != 'real':
        raise HTTPException(409, 'Opening broker inventory requires a Real portfolio')
    await prepare_listed_contract(user, portfolio_id, req)
    return service.attach_context(user, portfolio_id, req.symbol, req.instrument_type, req.strike, req.expiry, req.right)


@router.post('/{portfolio_id}/import-preview')
async def import_preview(portfolio_id: str, req: ContextRequest, user: str = Depends(get_desktop_user_id)):
    from app.services.swing_real import inventory_preview
    return await inventory_preview(await import_context(user, portfolio_id, req))


@router.post('/{portfolio_id}/import')
async def import_inventory(portfolio_id: str, req: ImportInventory, user: str = Depends(get_desktop_user_id)):
    from app.services.swing_real import import_inventory as apply_import
    child = await import_context(user, portfolio_id, req)
    await apply_import(child, req.fingerprint, req.request_id)
    return service.snapshot(user, portfolio_id)


class AllocationRequest(ContractModel):
    fraction: float = Field(gt=0, le=1, allow_inf_nan=False)
    request_id: str = Field(min_length=1, max_length=100)


@router.post('/{portfolio_id}/allocation')
async def change_allocation(portfolio_id: str, req: AllocationRequest, user: str = Depends(get_desktop_user_id)):
    current = await service.ensure(user, portfolio_id)
    if store.owned(user, portfolio_id)['mode'] != 'real':
        raise HTTPException(409, 'Shared allocations apply only to Real portfolios')
    from app.services.swing_real import allocation
    await funding_action(allocation(current, req.fraction, req.request_id))
    return service.snapshot(user, portfolio_id)


class CashCorrection(ContractModel):
    adjustment: float = Field(lt=0, allow_inf_nan=False)
    reason: str = Field(min_length=1, max_length=500)
    request_id: str = Field(min_length=1, max_length=100)
    funding_version: int | None = Field(default=None, ge=0)


@router.post('/{portfolio_id}/funding-correction-preview')
async def cash_correction_preview(portfolio_id: str, req: CashCorrection, user: str = Depends(get_desktop_user_id)):
    current = await service.ensure(user, portfolio_id)
    if store.owned(user, portfolio_id)['mode'] != 'real':
        raise HTTPException(409, 'Cash corrections apply only to Real funding')
    from app.services.swing_real import correction_preview
    preview = await funding_action(correction_preview(current, req.adjustment, req.reason))
    return {key: value for key, value in preview.items() if key not in ('pool', 'parent')}


@router.post('/{portfolio_id}/funding-correction')
async def cash_correction(portfolio_id: str, req: CashCorrection, user: str = Depends(get_desktop_user_id)):
    current = await service.ensure(user, portfolio_id)
    if store.owned(user, portfolio_id)['mode'] != 'real' or req.funding_version is None:
        raise HTTPException(409, 'Review a Real funding correction preview first')
    from app.services.swing_real import correct_shortfall
    await funding_action(correct_shortfall(current, req.adjustment, req.reason, req.request_id, req.funding_version))
    return service.snapshot(user, portfolio_id)
