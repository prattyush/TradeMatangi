"""Account-wide Kotak cash snapshots and a persistent IST-day capital baseline."""
from __future__ import annotations

import asyncio
import math
from datetime import datetime, timezone

from app.services import broker_reports as reports


def required_number(value, name):
    if value in (None, "", "NA", "-", "--") or isinstance(value, bool):
        raise ValueError(f"Kotak accounting is missing {name}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"Kotak accounting has invalid {name}")
    return number


def price_factor(raw):
    """Convert quoted price units to account cash units; quantities stay in shares."""
    factor = 1.0
    for name in ("multiplier", "genNum", "prcNum"):
        factor *= required_number(raw.get(name, 1), name)
    for name in ("genDen", "prcDen"):
        divisor = required_number(raw.get(name, 1), name)
        if divisor <= 0:
            raise ValueError(f"Invalid Kotak {name}")
        factor /= divisor
    if factor <= 0 or not math.isfinite(factor):
        raise ValueError("Invalid Kotak price factor")
    return factor


def contract_key(row):
    return (row["exchange"].strip().lower(), row["symbol"].strip().upper(), row["product"].strip().upper())


def gross_realized_pnl(date, executions, positions):
    """Weighted-average realized cash P&L, including exits from overnight carry.

    Broker reports are account-wide: never filter them by the selected chart.
    Realized P&L excludes commissions and unrealized movements of open positions.
    """
    inventory, factors, position_rows = {}, {}, {}
    for raw in positions:
        row = reports.normalize_order(raw)
        key = contract_key(row)
        if key in position_rows:
            raise ValueError("Duplicate Kotak accounting position")
        position_rows[key] = raw
        factor = price_factor(raw)
        factors[key] = factor
        buy, sell = reports.number(raw.get("cfBuyQty")), reports.number(raw.get("cfSellQty"))
        if buy < 0 or sell < 0 or buy != int(buy) or sell != int(sell):
            raise ValueError("Invalid Kotak carry quantity")
        carry = buy - sell
        if carry:
            amount = (required_number(raw.get("cfBuyAmt"), "cfBuyAmt") if carry > 0
                      else required_number(raw.get("cfSellAmt"), "cfSellAmt"))
            if amount <= 0 or (buy and sell):
                raise ValueError("Invalid Kotak carry cost")
            inventory[key] = (carry, amount / abs(carry) / factor)
    seen, day = {}, []
    for row in executions:
        if datetime.fromtimestamp(row["timestamp"], timezone.utc).date().isoformat() != date:
            continue
        identity = (row["exchange"], row["kotak_order_id"], row["execution_id"])
        if identity in seen:
            if seen[identity] != row:
                raise ValueError("Conflicting duplicate Kotak execution")
            continue
        seen[identity] = row
        day.append(row)
    realized = 0.0
    day_quantities = {}
    for row in sorted(day, key=lambda item: (item["timestamp"], item["kotak_order_id"], item["execution_id"])):
        key = contract_key(row)
        factor = factors.get(key, row.get("price_factor", 1.0))
        factor = required_number(factor, "price_factor")
        if factor <= 0 or ("price_factor" in row and not math.isclose(factor, row["price_factor"])):
            raise ValueError("Inconsistent Kotak execution price factor")
        qty = required_number(row["quantity"], "execution quantity")
        price = required_number(row["price"], "execution price")
        if qty <= 0 or qty != int(qty) or price <= 0 or row["side"] not in ("BUY", "SELL"):
            raise ValueError("Invalid Kotak execution")
        signed = qty if row["side"] == "BUY" else -qty
        day_quantities[(key, row["side"])] = day_quantities.get((key, row["side"]), 0) + qty
        held, average = inventory.get(key, (0, 0.0))
        if held and held * signed < 0:
            closed = min(abs(held), qty)
            realized += closed * (price - average) * (1 if held > 0 else -1) * factor
            remaining = held + signed
            inventory[key] = (remaining, price if remaining * held < 0 else average if remaining else 0.0)
        else:
            remaining = held + signed
            inventory[key] = (remaining, (abs(held) * average + qty * price) / abs(remaining))
    for key, raw in position_rows.items():
        # Check complete reports so a missing fill cannot silently initialize capital.
        for field, side in (("flBuyQty", "BUY"), ("flSellQty", "SELL")):
            if field in raw and required_number(raw[field], field) != day_quantities.get((key, side), 0):
                raise ValueError("Kotak account reports are updating; retry refresh")
        if "netQty" in raw or "net_quantity" in raw:
            net = required_number(raw.get("netQty", raw.get("net_quantity")), "netQty")
            if net != inventory.get(key, (0, 0))[0]:
                raise ValueError("Kotak account position does not match carry and today's fills")
    if not math.isfinite(realized):
        raise ValueError("Invalid Kotak realized P&L")
    return round(realized, 2)


async def refresh(user_id, date, broker, *, reason, executions=None, positions=None):
    """Fetch only on existing explicit refresh/start paths; persist before publishing."""
    from app.services import wallet_service
    from app.services.kotak_service import KotakError
    try:
        limits, account = await asyncio.gather(asyncio.to_thread(broker.get_limits), asyncio.to_thread(broker.account_identity))
        if executions is None or positions is None:
            from app.services import kotak_reports
            bundle = await kotak_reports.fetch(broker, include_orders=False)
            executions = bundle.executions if executions is None else executions
            positions = bundle.positions if positions is None else positions
        net = required_number(limits.get("Net"), "Net")
        # Preserve the broker's signed adjustment, including negative values
        # observed after exits. Finite-value validation still applies; clamping
        # would change the existing capital-recovery calculation.
        committed = required_number(limits.get("MarginUsed"), "MarginUsed")
        realized = gross_realized_pnl(date, executions, positions)
        if not isinstance(account, str) or not account:
            raise ValueError("Kotak account identity is missing")
    except (ValueError, TypeError, KeyError) as exc:
        raise KotakError(str(exc)) from exc
    return await asyncio.to_thread(wallet_service.sync_real_account_funds, user_id, date,
        account, net, realized, committed, reason=reason)


def apply_session_capital(session, capital):
    """Persist corrected legacy capital and update sibling sessions on this account/day."""
    from app.services import simulation
    sessions = {session.session_id: session}
    sessions.update({sid: other for sid, other in simulation._sessions.items()
                     if other.user_id == session.user_id and other.date == session.date
                     and other.session_type == "real"})
    for other in sessions.values():
        if other.session_capital != capital:
            previous = other.session_capital
            other.session_capital = capital
            try:
                simulation._upsert_session_to_db(other, strict=True)
            except Exception:
                other.session_capital = previous
                raise
