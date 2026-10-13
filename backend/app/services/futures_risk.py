"""Dated Futures margin/fee evidence. Margin reads never submit broker orders."""

import logging
import math
import time
from datetime import date
from typing import Literal

from botocore.exceptions import ClientError
from fastapi import HTTPException
from pydantic import Field

from app.models.schemas import ContractModel
from app.services import swing_funding_store as storage

logger = logging.getLogger(__name__)


class FeeProfile(ContractModel):
    effective_from: date = date(2026, 4, 1)
    brokerage_cap: float = Field(default=20, ge=0, allow_inf_nan=False)
    brokerage_rate: float = Field(default=0.0003, ge=0, le=1, allow_inf_nan=False)
    nfo_rate: float = Field(default=0.0000183, ge=0, le=1, allow_inf_nan=False)
    bfo_rate: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    sebi_rate: float = Field(default=0.000001, ge=0, le=1, allow_inf_nan=False)
    ipft_rate: float = Field(default=0.000000001, ge=0, le=1, allow_inf_nan=False)
    stt_sell_rate: float = Field(default=0.0005, ge=0, le=1, allow_inf_nan=False)
    stamp_buy_rate: float = Field(default=0.00002, ge=0, le=1, allow_inf_nan=False)
    gst_rate: float = Field(default=0.18, ge=0, le=1, allow_inf_nan=False)


class MarginEstimate(ContractModel):
    provider: Literal["kite", "kotak"]
    symbol: str
    expiry: date
    side: Literal["BUY", "SELL"]
    quantity: int = Field(gt=0)
    reference_price: float = Field(gt=0, allow_inf_nan=False)
    margin: float = Field(gt=0, allow_inf_nan=False)
    as_of: date
    source: str = Field(default="Admin estimate", min_length=1, max_length=300)


class RiskSettings(ContractModel):
    version: int = Field(default=0, ge=0)
    paper_enabled: bool = True
    kite_real_enabled: bool = False
    kotak_real_enabled: bool = False
    refresh_offhours: bool = True
    fees: dict[Literal["kite", "kotak"], FeeProfile] = Field(
        default_factory=lambda: {
            "kite": FeeProfile(),
            "kotak": FeeProfile(brokerage_cap=0, brokerage_rate=0),
        }
    )
    estimates: list[MarginEstimate] = Field(default_factory=list, max_length=2000)


KEY = {"user_id": "__futures_admin__", "ledger_id": "risk-settings"}


def settings():
    row = storage._table().get_item(Key=KEY, ConsistentRead=True).get("Item")
    if row:
        return RiskSettings.model_validate(storage.decode(row["settings"]))
    # Published dated observation, not an execution quote or a universal margin rate.
    estimates = [
        MarginEstimate(
            provider="kite",
            symbol="NIFTY",
            expiry=date(2026, 10, 27),
            side=side,
            quantity=65,
            reference_price=22386.5,
            margin=165107,
            as_of=date(2026, 10, 13),
            source="https://zerodha.com/margin-calculator/Futures/",
        )
        for side in ("BUY", "SELL")
    ]
    return RiskSettings(estimates=estimates)


def save(value):
    from app.config import SUPPORTED_SYMBOLS

    value = RiskSettings.model_validate(value)
    if set(value.fees) != {"kite", "kotak"}:
        raise ValueError("Both broker fee profiles are required")
    keys = set()
    for row in value.estimates:
        if row.symbol not in SUPPORTED_SYMBOLS:
            raise ValueError("Unsupported margin-estimate symbol")
        identity = (row.provider, row.symbol, row.expiry, row.side)
        if identity in keys:
            raise ValueError("Duplicate margin estimate")
        keys.add(identity)
    result = value.model_copy(update={"version": value.version + 1})
    try:
        storage._table().put_item(
            Item=storage.encode(
                {
                    **KEY,
                    "version": result.version,
                    "settings": result.model_dump(mode="json"),
                }
            ),
            ConditionExpression="attribute_not_exists(ledger_id)"
            if value.version == 0
            else "#v = :old",
            **(
                {}
                if value.version == 0
                else {
                    "ExpressionAttributeNames": {"#v": "version"},
                    "ExpressionAttributeValues": {":old": value.version},
                }
            ),
        )
    except ClientError as exc:
        if (
            exc.response.get("Error", {}).get("Code")
            == "ConditionalCheckFailedException"
        ):
            raise HTTPException(
                409, "Futures settings changed; reload before saving"
            ) from exc
        raise
    return result


def fees(profile, exchange, side, price, quantity):
    profile = FeeProfile.model_validate(profile)
    notional = price * quantity
    if not math.isfinite(notional) or notional <= 0:
        raise ValueError("Fees require positive price and quantity")
    brokerage = min(profile.brokerage_cap, notional * profile.brokerage_rate)
    transaction = notional * (
        profile.bfo_rate if exchange == "BFO" else profile.nfo_rate
    )
    sebi, ipft = notional * profile.sebi_rate, notional * profile.ipft_rate
    stt = notional * profile.stt_sell_rate if side == "SELL" else 0
    stamp = notional * profile.stamp_buy_rate if side == "BUY" else 0
    gst = (brokerage + transaction + sebi + ipft) * profile.gst_rate
    return {
        "brokerage": round(brokerage, 4),
        "transaction": round(transaction, 4),
        "sebi": round(sebi, 4),
        "ipft": round(ipft, 4),
        "stt": round(stt, 4),
        "stamp": round(stamp, 4),
        "gst": round(gst, 4),
        "total": round(brokerage + transaction + sebi + ipft + stt + stamp + gst, 2),
    }


def live_margin(contract, side, quantity, price, provider, *, broker=None):
    if (
        quantity <= 0
        or quantity % contract["lot_size"]
        or not math.isfinite(price)
        or price <= 0
    ):
        raise ValueError("Margin quote requires listed lots and a positive price")
    if broker is None:
        from app.services.execution_broker import get_service

        broker = get_service(provider)
    if provider == "kite":
        payload = [
            {
                "exchange": contract["exchange"],
                "tradingsymbol": contract["trading_symbol"],
                "transaction_type": side,
                "variety": "regular",
                "product": "NRML",
                "order_type": "LIMIT",
                "quantity": quantity,
                "price": price,
                "trigger_price": 0,
            }
        ]
        response = broker._read(
            "basket_order_margins", params=payload, consider_positions=False
        )
        initial = response.get("initial") if isinstance(response, dict) else None
        margin = initial.get("total") if isinstance(initial, dict) else None
    else:
        response = broker._get_client().margin_required(
            exchange_segment="bse_fo" if contract["exchange"] == "BFO" else "nse_fo",
            price=str(price),
            order_type="L",
            product="NRML",
            quantity=str(quantity),
            instrument_token=contract["instrument_token"],
            transaction_type="B" if side == "BUY" else "S",
        )
        if (
            not isinstance(response, dict)
            or response.get("stat") not in ("Ok", "OK", "ok")
            or response.get("Error")
            or response.get("Error Message")
        ):
            raise ValueError("Kotak did not return a usable margin quote")
        # reqdMrgn may be a zero shortfall; ordMrgn is the new order's requirement.
        margin = response.get("ordMrgn")
    try:
        margin = float(margin)
    except (TypeError, ValueError) as exc:
        raise ValueError("Broker margin requirement is missing") from exc
    if not math.isfinite(margin) or margin <= 0:
        raise ValueError(
            "Broker margin is zero/invalid; a usable positive requirement is needed"
        )
    return {
        "margin": round(margin, 2),
        "quantity": quantity,
        "reference_price": price,
        "source": f"{provider} margin API",
        "quoted_at": time.time(),
        "live": True,
    }


def margin_preview(contract, side, quantity, price, provider, *, allow_estimate):
    try:
        result = live_margin(contract, side, quantity, price, provider)
        cache_margin(contract, side, provider, result)
        return result
    except Exception:
        if not allow_estimate:
            raise
    config = settings()
    matching = next(
        (
            row
            for row in config.estimates
            if row.provider == provider
            and row.symbol == contract["symbol"]
            and row.expiry.isoformat() == contract["expiry"]
            and row.side == side
        ),
        None,
    )
    if matching is None:
        raise ValueError(
            "No margin estimate is available; wait for a broker quote or ask Admin to add one"
        )
    return {
        "margin": round(
            matching.margin
            * quantity
            / matching.quantity
            * price
            / matching.reference_price,
            2,
        ),
        "quantity": quantity,
        "reference_price": price,
        "source": matching.source,
        "as_of": matching.as_of.isoformat(),
        "live": False,
        "quoted_at": None,
    }


def cache_margin(contract, side, provider, evidence):
    from app.services.swing_market import today

    try:
        config = settings()
        row = MarginEstimate(
            provider=provider,
            symbol=contract["symbol"],
            expiry=contract["expiry"],
            side=side,
            quantity=evidence["quantity"],
            reference_price=evidence["reference_price"],
            margin=evidence["margin"],
            as_of=today(),
            source=evidence["source"],
        )
        config.estimates = [
            r
            for r in config.estimates
            if (r.provider, r.symbol, r.expiry, r.side)
            != (row.provider, row.symbol, row.expiry, row.side)
        ] + [row]
        save(config)
    except Exception as exc:  # noqa: BLE001 — optional cache must not discard a fresh margin quote
        logger.debug("Futures margin cache unavailable: %s", type(exc).__name__)


async def refresh_offhours():
    """Refresh only known estimates, off the order path, once per market date."""
    import asyncio

    from app.services import futures_contracts, swing_market

    completed = None
    while True:
        try:
            config = await asyncio.to_thread(settings)
            day = swing_market.today()
            if (
                config.refresh_offhours
                and not swing_market.window(swing_market.now())
                and completed != day
            ):
                for estimate in config.estimates:
                    if estimate.expiry.isoformat() < day:
                        continue
                    try:
                        contract = await asyncio.to_thread(
                            futures_contracts.resolve_contract,
                            estimate.symbol,
                            estimate.expiry.isoformat(),
                            estimate.provider,
                        )
                        evidence = await asyncio.to_thread(
                            live_margin,
                            contract,
                            estimate.side,
                            estimate.quantity,
                            estimate.reference_price,
                            estimate.provider,
                        )
                        await asyncio.to_thread(
                            cache_margin,
                            contract,
                            estimate.side,
                            estimate.provider,
                            evidence,
                        )
                    except Exception as exc:  # noqa: BLE001 — retain dated estimates on provider failure
                        logger.debug(
                            "Futures estimate refresh unavailable: %s",
                            type(exc).__name__,
                        )
                    await asyncio.sleep(1)
                completed = day
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — retry the background worker after provider/storage failure
            logger.warning("Futures risk refresh failed: %s", type(exc).__name__)
        await asyncio.sleep(60)
