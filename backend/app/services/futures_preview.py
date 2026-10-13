"""Owned preview binding quantity, capital and dated Futures risk evidence."""

import hashlib
import json
import math

from fastapi import HTTPException

from app.services import futures_contracts
from app.services import futures_risk as risk
from app.services.swing_portfolio_store import owned


def fee_hash(profile):
    return hashlib.sha256(
        json.dumps(profile.model_dump(mode="json"), sort_keys=True).encode()
    ).hexdigest()


def preview(user, portfolio_id, req):
    row = owned(user, portfolio_id)
    if (
        req.capital_revision is not None
        and req.capital_revision != row["guardrail_epoch"]
    ):
        raise HTTPException(409, "Portfolio capital changed; review the Futures budget")
    provider = row.get("execution_broker") or row.get("paper_broker") or "kite"
    config = risk.settings()
    try:
        from app.services import swing_portfolio_service as service

        existing = service.runtime(user, portfolio_id).contexts.get(
            f"{req.symbol}:futures:{req.expiry}"
        )
        contract = (
            existing.future_contract
            if existing
            else futures_contracts.resolve_contract(req.symbol, req.expiry, provider)
        )
        profile = config.fees[provider]
        from app.services.swing_market import today

        lot = contract["lot_size"]
        quantity = req.quantity
        side = req.side.value
        budget = (
            row["session_capital"] * req.capital_pct
            if req.capital_pct is not None
            else None
        )
        from app.services import swing_portfolio_service as service
        from app.services import trading

        child = service.runtime(user, portfolio_id).contexts.get(
            f"{req.symbol}:futures:{req.expiry}"
        )
        position = (
            trading.get_position(child.session_id, child.symbol, expiry=child.expiry)
            if child
            else None
        )
        exiting = (
            position is not None
            and req.quantity <= position.quantity
            and (
                (position.side == "LONG" and side == "SELL")
                or (position.side == "SHORT" and side == "BUY")
            )
        )
        if exiting:
            if req.capital_pct is not None:
                raise ValueError("Use explicit quantity for Futures exits")
            charges = risk.fees(
                profile, contract["exchange"], side, req.price, req.quantity
            )
            return {
                "contract": contract,
                "quantity": req.quantity,
                "lot_size": lot,
                "budget": charges["total"],
                "margin": 0,
                "fee_details": charges,
                "fees": charges["total"],
                "required_funds": 0,
                "unused_budget": 0,
                "minimum_funds": 0,
                "capital_revision": row["guardrail_epoch"],
                "fee_hash": fee_hash(profile),
                "fee_profile": profile.model_dump(mode="json"),
                "evidence": {"live": True, "source": "held-position exit"},
                "execution_enabled": True,
                "message": "Exit uses the held position; entry funding restrictions do not block it",
            }
        if profile.effective_from.isoformat() > today():
            raise ValueError("The configured fee profile is not effective yet")
        minimum = risk.margin_preview(
            contract,
            side,
            lot,
            req.price,
            provider,
            allow_estimate=row["mode"] == "paper",
        )
        minimum_fees = risk.fees(profile, contract["exchange"], side, req.price, lot)
        if budget is not None:
            margin_per_lot = minimum["margin"]
            low, high = 0, math.floor(budget / margin_per_lot)
            while low < high:
                middle = (low + high + 1) // 2
                cost = (
                    margin_per_lot * middle
                    + risk.fees(
                        profile, contract["exchange"], side, req.price, middle * lot
                    )["total"]
                )
                if cost <= budget:
                    low = middle
                else:
                    high = middle - 1
            quantity = low * lot
        elif quantity % lot:
            raise ValueError(f"Futures quantity must be complete lots of {lot}")
        evidence = (
            minimum
            if quantity in (0, lot)
            else risk.margin_preview(
                contract,
                side,
                quantity,
                req.price,
                provider,
                allow_estimate=row["mode"] == "paper",
            )
        )
        charges = (
            risk.fees(profile, contract["exchange"], side, req.price, quantity)
            if quantity
            else {"total": 0}
        )
        required = evidence["margin"] + charges["total"] if quantity else 0
        if budget is not None and required > budget:
            raise ValueError(
                "Actual margin exceeds the sizing estimate; reduce the percentage/quantity and review again"
            )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            503, "Broker margin is unavailable; retry or review an Admin Paper estimate"
        ) from exc
    enabled = (
        config.paper_enabled
        if row["mode"] == "paper"
        else getattr(config, f"{provider}_real_enabled")
    )
    return {
        "contract": contract,
        "quantity": quantity,
        "lot_size": lot,
        "budget": round(budget, 2) if budget is not None else required,
        "margin": evidence["margin"] if quantity else 0,
        "fee_details": charges,
        "fees": charges["total"],
        "required_funds": round(required, 2),
        "unused_budget": round(budget - required, 2) if budget is not None else 0,
        "minimum_funds": round(minimum["margin"] + minimum_fees["total"], 2),
        "capital_revision": row["guardrail_epoch"],
        "fee_hash": fee_hash(profile),
        "fee_profile": profile.model_dump(mode="json"),
        "evidence": evidence,
        "execution_enabled": enabled,
        "message": "Offline estimate: intention waits for live price and margin"
        if not evidence["live"]
        else "Broker margin preview; submission revalidates funding and guardrails",
    }
