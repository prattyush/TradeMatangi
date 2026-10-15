"""Owned Swing portfolio actions, independent of dated intraday session controls."""

import asyncio
import json
import uuid
from datetime import date as calendar_date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
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


def publish_snapshot(user, portfolio_id):
    value = service.snapshot(user, portfolio_id)
    service.runtime(user, portfolio_id).emit({"type": "portfolio_snapshot", **value})
    return value


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
    paper_broker: Literal["kite", "kotak"] = "kite"
    mode: Literal["paper", "real"] = "paper"
    execution_broker: Literal["kotak", "kite"] | None = None
    allocation_pct: float = Field(default=1, gt=0, le=1, allow_inf_nan=False)
    capital: float = Field(ge=0.01, allow_inf_nan=False)
    loss_limit_pct: float | None = Field(default=None, gt=0, le=1, allow_inf_nan=False)


class ContextRequest(ContractModel):
    symbol: str
    instrument_type: Literal["equity", "options", "futures"] = "equity"
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
        elif self.instrument_type == "futures":
            if self.right is not None or self.strike is not None or not self.expiry:
                raise ValueError("Futures require expiry without option right/strike")
            calendar_date.fromisoformat(self.expiry)
        else:
            if self.right is None or self.strike is None or not self.expiry:
                raise ValueError("Options require right, strike and expiry")
            calendar_date.fromisoformat(self.expiry)
        return self


class PortfolioOrder(ContextRequest):
    client: Literal["website", "desktop"] = "website"
    side: TradeSide
    order_type: OrderType = OrderType.LIMIT
    quantity: int = Field(gt=0)
    price: float = Field(gt=0, allow_inf_nan=False)
    request_id: str = Field(min_length=1, max_length=100)
    capital_pct: float | None = Field(default=None, gt=0, le=1, allow_inf_nan=False)
    capital_revision: int | None = Field(default=None, ge=0)
    approved_budget: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    fee_hash: str | None = Field(default=None, min_length=64, max_length=64)

    @model_validator(mode="after")
    def percentage_entry(self):
        if self.capital_pct is not None and ((self.side != TradeSide.BUY and self.instrument_type != "futures") or self.capital_revision is None):
            raise ValueError("Capital percentage is for BUY entries and requires the capital revision")
        return self


class SwingCloseRequest(CloseRequest):
    acknowledge_delivery_context_ids: list[str] = Field(default_factory=list,max_length=250)


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
        return {"real_trading_enabled": False, "user_id": user}
    return {"real_trading_enabled": True, "user_id": user}


@router.get("/broker-status")
async def broker_status(
    execution_broker: Literal["kotak", "kite"], user: str = Depends(get_desktop_user_id)
):
    from app.dependencies import require_real_trading_access
    from app.services import execution_broker as brokers

    require_real_trading_access(user)

    def read():
        broker = brokers.get_service(execution_broker)
        return {"broker": execution_broker, "authenticated": broker.is_authenticated()}

    return await asyncio.to_thread(read)


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
            store.create, user, req.mode, req.capital, loss_limit_pct=req.loss_limit_pct, paper_broker=req.paper_broker
        )
    return service.snapshot(user, portfolio["session_id"])


@router.get('/label-metadata')
async def swing_label_metadata(user:str=Depends(get_desktop_user_id)):
    from app.services import pattern_logger_service,trade_label_service
    def read():
        return {'categories':pattern_logger_service.list_category_names(user),'strategies':pattern_logger_service.list_strategy_names(user),'entry_tags':trade_label_service.list_entry_tags(user),'exit_tags':trade_label_service.list_exit_tags(user)}
    return await asyncio.to_thread(read)



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
    return {"session_id": child.session_id, **publish_snapshot(user, portfolio_id)}


async def capital_sizing(user, portfolio_id, req):
    from app.services.swing_sizing import capital_quantity

    row = store.owned(user, portfolio_id)
    if row["guardrail_epoch"] != req.capital_revision:
        raise HTTPException(409, "Portfolio capital changed; review sizing again")
    lot_size = 1
    current = service.runtime(user, portfolio_id)
    child = current.contexts.get(req.symbol + ":" + req.instrument_type)
    if req.instrument_type == "options":
        contract = next(
            (c for c in getattr(child, "desktop_contracts", [])
             if (c.get("strike"), c.get("expiry"), c.get("right"))
             == (req.strike, req.expiry, req.right)),
            None,
        )
        if contract is None:
            from app.services.breeze_master import listed_option_contract

            try:
                contract = await asyncio.to_thread(
                    listed_option_contract, req.symbol, req.strike, req.expiry, req.right
                )
            except FileNotFoundError as exc:
                raise HTTPException(503, "Option contract metadata is unavailable") from exc
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
        lot_size = int(contract["lot_size"])
    return capital_quantity(
        row["session_capital"], req.capital_pct, req.price, lot_size,
        getattr(child, "brokerage_per_order", 1.0),
    )


def economic_instructions(body):
    # New optional sizing fields must not change the identity of legacy retries.
    return {k: v for k, v in body.items()
            if k != "client" and not (k in ("capital_pct", "capital_revision", "approved_budget", "fee_hash") and v is None)}


@router.post("/{portfolio_id}/order-preview")
async def preview_order(
    portfolio_id: str, req: PortfolioOrder, user: str = Depends(get_desktop_user_id)
):
    from app.config import SUPPORTED_SYMBOLS

    await service.ensure(user, portfolio_id)
    if req.instrument_type == "futures":
        from app.services.futures_preview import preview
        return await asyncio.to_thread(preview, user, portfolio_id, req)
    if req.capital_pct is None:
        raise HTTPException(422, "Select capital percentage sizing")
    definition = SUPPORTED_SYMBOLS.get(req.symbol)
    if not definition or (req.instrument_type == "equity" and definition.get("options_only")):
        raise HTTPException(422, "Select a supported tradable instrument")
    if req.order_type == OrderType.STOPLOSS:
        raise HTTPException(422, "Capital percentage is for Limit or Target entries")
    sizing = await capital_sizing(user, portfolio_id, req)
    return {
        **sizing,
        "capital_revision": req.capital_revision,
        "source": "existing-swing-cost-model",
        "message": "Limit/trigger price estimate; execution and available funds are checked at submission",
    }


@router.post("/{portfolio_id}/orders")
async def place(
    portfolio_id: str, req: PortfolioOrder, user: str = Depends(get_desktop_user_id)
):
    import uuid

    if req.instrument_type == "futures":
        from app.services.swing_futures import place as future_place
        return await future_place(user,portfolio_id,req)
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
            # Client attribution is not part of the economic order intent.
            matching = (
                economic_instructions(original_request)
                == economic_instructions(req.model_dump(mode="json"))
            ) if original_request else (
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
        if req.capital_pct is not None:
            sizing = await capital_sizing(user, portfolio_id, req)
            if not sizing["quantity"]:
                raise HTTPException(422, f"Budget cannot buy one lot; minimum funds {sizing['minimum_funds']}")
            if sizing["quantity"] != req.quantity:
                raise HTTPException(409, "Sizing estimate changed; review quantity before placing")
            # No await between this final capital check and order placement below.
            if store.owned(user, portfolio_id)["guardrail_epoch"] != req.capital_revision:
                raise HTTPException(409, "Portfolio capital changed; review sizing again")
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
            analytics={**decision_snapshot(child, quantity=req.quantity, price=req.price, side=req.side.value, margin_rate=1, entry_method=req.order_type.value, action_id=identifier),"client":req.client,
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
        return publish_snapshot(user, portfolio_id)
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
async def close(portfolio_id: str, user: str = Depends(get_desktop_user_id), req: SwingCloseRequest | None = None):
    await service.close_portfolio(user, portfolio_id, req.acknowledge_undated_submission_ids if req else None, acknowledge_delivery_context_ids=req.acknowledge_delivery_context_ids if req else None)
    return publish_snapshot(user, portfolio_id)


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

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class AmendPortfolioOrder(ContractModel):
    price: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    quantity: int | None = Field(default=None, gt=0)


@router.patch("/{portfolio_id}/orders/{order_id}")
async def amend(portfolio_id: str, order_id: str, req: AmendPortfolioOrder, user: str = Depends(get_desktop_user_id)):
    from app.services.swing_order_actions import act
    return await act(user, portfolio_id, order_id, price=req.price, quantity=req.quantity)


@router.post("/{portfolio_id}/orders/{order_id}/cancel")
async def cancel(portfolio_id: str, order_id: str, user: str = Depends(get_desktop_user_id)):
    from app.services.swing_order_actions import act
    return await act(user, portfolio_id, order_id, cancel=True)


@router.get("/contracts/futures")
async def futures_metadata(
    symbol: str,
    provider: Literal["kite", "kotak"] = "kite",
    user: str = Depends(get_desktop_user_id),
):
    from app.services.futures_contracts import listed_contracts
    from app.services.swing_market import today

    try:
        contracts = await asyncio.to_thread(listed_contracts, symbol, provider, calendar_date.fromisoformat(today()))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, "Futures metadata unavailable; retry after provider recovery") from exc
    from app.services.futures_risk import settings
    config = await asyncio.to_thread(settings)
    return {"symbol": symbol, "provider": provider, "contracts": contracts,
            "paper_enabled": config.paper_enabled,
            "real_enabled": getattr(config, f"{provider}_real_enabled"),
            "execution_enabled": config.paper_enabled or getattr(config, f"{provider}_real_enabled") }


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
        result = publish_snapshot(user, portfolio_id)
        result["recovery_issues"] = issues
        return result
    return publish_snapshot(user, portfolio_id)


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
    return publish_snapshot(user, portfolio_id)


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
    return publish_snapshot(user, portfolio_id)



class ChartHistoryRequest(ContextRequest):
    interval: Literal["1m", "3m", "5m", "15m", "30m", "1h", "1D"] = "1D"
    as_of_date: calendar_date
    follow_today: bool = False
    before: int | None = Field(default=None, ge=0)
    limit: int | None = Field(default=None, ge=1, le=500)
    marker_mode: Literal["open", "all", "off"] = "open"


class ChartWatch(ContractModel):
    items: list[ChartHistoryRequest] = Field(max_length=4)


@router.post("/{portfolio_id}/charts/history")
async def chart_history(
    portfolio_id: str,
    req: ChartHistoryRequest,
    user: str = Depends(get_desktop_user_id),
):
    from app.services import swing_charts

    row = store.owned(user, portfolio_id)
    if row["mode"] == "real":
        from app.dependencies import require_real_trading_access

        require_real_trading_access(user)
    item = swing_charts.instrument(
        req.symbol, req.instrument_type, req.right, req.strike, req.expiry
    )
    result = await asyncio.to_thread(
        swing_charts.history,
        item,
        req.interval,
        req.as_of_date.isoformat(),
        req.before,
        req.limit,
    )

    if row["mode"] == "paper" and req.before is None:
        from app.services import swing_market
        if req.as_of_date.isoformat() == swing_market.today() and result.get("valuation_quote"):
            await service.apply_history_valuation(user, portfolio_id, item, result["valuation_quote"])
    return result


@router.post("/{portfolio_id}/charts/watch")
async def chart_watch(
    portfolio_id: str, req: ChartWatch, user: str = Depends(get_desktop_user_id)
):
    from app.services import swing_charts, swing_market

    row = store.owned(user, portfolio_id)
    if row["state"] == "ended":
        raise HTTPException(409, "Closed portfolios have historical charts only")
    if row["mode"] == "real":
        from app.dependencies import require_real_trading_access

        require_real_trading_access(user)
    items = {
        json.dumps(
            swing_charts.instrument(
                p.symbol, p.instrument_type, p.right, p.strike, p.expiry
            ),
            sort_keys=True,
        )
        for p in req.items
        if p.as_of_date.isoformat() == swing_market.today()
        and (not p.expiry or p.expiry >= swing_market.today())
    }
    identifier = str(uuid.uuid4())
    swing_charts._viewers[identifier] = swing_charts.Viewer(
        user,
        portfolio_id,
        [json.loads(item) for item in sorted(items)],
        row["mode"] == "real",
        identifier,
    )
    return {"watch_id": identifier}


@router.get("/{portfolio_id}/charts/watch/{watch_id}")
async def chart_quotes(
    portfolio_id: str, watch_id: str, user: str = Depends(get_desktop_user_id)
):
    from app.services import swing_charts, swing_market
    from app.services.market_data import selected_provider

    viewer = swing_charts._viewers.get(watch_id)
    if not viewer or viewer.user != user or viewer.portfolio != portfolio_id:
        raise HTTPException(404, "Chart viewer expired")
    viewer.last_seen = __import__("time").monotonic()
    if viewer.task.done() and store.owned(user, portfolio_id)["state"] != "ended":
        viewer.task = asyncio.create_task(viewer.run())
    return {
        "quotes": list(viewer.quotes.values()),
        "error": viewer.error,
        "market_open": bool(swing_market.window(swing_market.now())),
        "provider": viewer.actual or selected_provider(),
    }


@router.get("/{portfolio_id}/charts/watch/{watch_id}/events")
async def chart_events(portfolio_id: str, watch_id: str, user: str = Depends(get_desktop_user_id)):
    from app.services import swing_charts
    # Authenticate/validate ownership before starting a streaming response.
    await chart_quotes(portfolio_id, watch_id, user)
    viewer = swing_charts._viewers[watch_id]

    async def stream():
        try:
            while True:
                if swing_charts._viewers.get(watch_id) is not viewer:
                    yield 'data: {"type":"chart_watch_expired"}\n\n'
                    return
                viewer.changed.clear()
                value = await chart_quotes(portfolio_id, watch_id, user)
                yield "event: quotes\ndata: " + json.dumps({"type": "chart_quotes", **value}) + "\n\n"
                while not viewer.changed.is_set():
                    try:
                        await asyncio.wait_for(viewer.changed.wait(), timeout=15)
                    except TimeoutError:
                        viewer.last_seen = __import__("time").monotonic()
                        if viewer.task.done() or swing_charts._viewers.get(watch_id) is not viewer:
                            yield 'data: {"type":"chart_watch_expired"}\n\n'
                            return
                        yield ": keepalive\n\n"
        finally:
            # The owned watch is also deleted by the client; expiration cleans up
            # abrupt disconnects without affecting another viewer's subscriptions.
            viewer.last_seen = __import__("time").monotonic()

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.delete("/{portfolio_id}/charts/watch/{watch_id}")
async def stop_chart_watch(
    portfolio_id: str, watch_id: str, user: str = Depends(get_desktop_user_id)
):
    from app.services import swing_charts

    viewer = swing_charts._viewers.get(watch_id)
    if viewer and (viewer.user != user or viewer.portfolio != portfolio_id):
        raise HTTPException(404, "Chart viewer not found")
    swing_charts.stop_viewer(watch_id, user)
    return {"stopped": True}


class ChartWorkspace(ContractModel):
    workspace_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{1,64}$")
    surface: Literal["website", "desktop"]
    panes: list[ChartHistoryRequest] = Field(min_length=1, max_length=4)
    active: int = Field(default=0, ge=0, le=3)
    rail_open: bool = True
    ticket_open: bool = True
    tools_collapsed: bool = False

    @model_validator(mode="after")
    def active_pane_exists(self):
        if self.active >= len(self.panes):
            raise ValueError("Active chart must exist in the workspace")
        return self


@router.get("/{portfolio_id}/charts/workspace")
async def load_workspace(
    portfolio_id: str,
    surface: Literal["website", "desktop"],
    workspace_id: str | None = Query(default=None, pattern=r"^[A-Za-z0-9-]{1,64}$"),
    user: str = Depends(get_desktop_user_id),
):
    row = store.owned(user, portfolio_id)
    from app.services.desktop_persistence_service import _table

    key = f"swing-ui:{surface}:{row['mode']}:{row.get('execution_broker') or 'paper'}"
    if workspace_id:
        key += f":{portfolio_id}:{workspace_id}"
    result = await asyncio.to_thread(
        lambda: (
            _table("DesktopChartSettings")
            .get_item(Key={"user_id": user, "record_id": key}, ConsistentRead=True)
            .get("Item", {})
        )
    )
    from app.services.swing_funding_store import decode

    return {"workspace": decode(result.get("workspace"))}


@router.put("/{portfolio_id}/charts/workspace")
async def save_workspace(
    portfolio_id: str, req: ChartWorkspace, user: str = Depends(get_desktop_user_id)
):
    row = store.owned(user, portfolio_id)
    from app.services.desktop_persistence_service import _table, _dynamodb_safe

    key = (
        f"swing-ui:{req.surface}:{row['mode']}:{row.get('execution_broker') or 'paper'}"
    )
    if req.workspace_id:
        key += f":{portfolio_id}:{req.workspace_id}"
    for pane in req.panes:
        from app.services.swing_charts import instrument

        instrument(
            pane.symbol, pane.instrument_type, pane.right, pane.strike, pane.expiry
        )
    await asyncio.to_thread(
        lambda: _table("DesktopChartSettings").put_item(
            Item={
                "user_id": user,
                "record_id": key,
                "workspace": _dynamodb_safe(req.model_dump(mode="json")),
            }
        )
    )
    return {"saved": True}


@router.get('/{portfolio_id}/analytics')
async def swing_analytics(
    portfolio_id: str,
    start_date: calendar_date | None = None,
    end_date: calendar_date | None = None,
    history: bool = True,
    user: str = Depends(get_desktop_user_id),
):
    from app.services.swing_analytics import report

    return await asyncio.to_thread(
        report,
        user,
        portfolio_id,
        start_date.isoformat() if start_date else None,
        end_date.isoformat() if end_date else None,
        history,
    )


@router.get('/{portfolio_id}/execution-history')
async def execution_history(portfolio_id:str,user:str=Depends(get_desktop_user_id)):
    from app.services.swing_analytics import cycles
    from app.services.analysis_service import get_trades_for_session,get_stored_orders
    parent=await asyncio.to_thread(store.owned,user,portfolio_id)
    def read():
        children=[{'session_id':sid,'trades':get_trades_for_session(sid),'orders':get_stored_orders({'session_id':sid,'session_type':parent['mode']})} for sid in parent['contexts'].values()]
        return {'history_warning':parent.get('history_warning'),'cycles':cycles(parent),'contexts':children}
    return await asyncio.to_thread(read)



class SwingLabel(ContractModel):
    session_id:str
    analytics_cycle_id:str
    expected_category:str=''
    expected_strategy:str=''
    actual_category:str=''
    actual_strategy:str=''
    entry_tag:str='AS_PER_PATTERN'
    exit_tag:str='AS_PER_PATTERN'


@router.post('/{portfolio_id}/labels')
async def label_swing_cycle(
    portfolio_id: str, req: SwingLabel, user: str = Depends(get_desktop_user_id)
):
    from app.services.swing_analytics import cycles
    from app.services.trade_label_service import save_labels

    parent = await asyncio.to_thread(store.owned, user, portfolio_id)
    if req.session_id not in parent["contexts"].values():
        raise HTTPException(404, "Trade cycle not found")
    rows = await asyncio.to_thread(cycles, parent, True)
    cycle = next(
        (
            c
            for c in rows
            if c["session_id"] == req.session_id
            and c["cycle_id"] == req.analytics_cycle_id
        ),
        None,
    )
    if not cycle:
        raise HTTPException(409, "Trade cycle changed; refresh before labelling")
    try:
        return await asyncio.to_thread(
            save_labels,
            req.session_id,
            [
                {
                    **req.model_dump(),
                    "round_trip_index": cycle.get("label_index", cycle["index"]),
                }
            ],
            user,
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
