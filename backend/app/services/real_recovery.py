"""Read-only broker verification for user-directed recovery; never invent fills."""

import asyncio

from app.services import (
    broker_reports,
    execution_broker,
    kotak_reports,
    real_broker_state,
)

TERMINAL = {"complete", "filled", "cancelled", "canceled", "rejected", "expired"}


async def verify(session):
    broker = execution_broker.get_service(session)
    method = getattr(broker, "get_recovery_reports", None)
    if callable(method):
        from types import SimpleNamespace

        snapshot = await asyncio.to_thread(method)
        if (
            not isinstance(snapshot, dict)
            or not isinstance(snapshot.get("orders"), list)
            or not isinstance(snapshot.get("positions"), list)
        ):
            raise TypeError("Broker current exposure reports are unavailable")
        bundle = SimpleNamespace(**snapshot)
    else:
        bundle = await kotak_reports.fetch(broker, force=True)
    if bundle.orders is None:
        raise ValueError(
            "Broker order report is unavailable; closure cannot be verified"
        )
    orders = [broker_reports.normalize_order(row) for row in bundle.orders]
    facts = orders + [broker_reports.normalize_order(row) for row in bundle.positions]
    if any(not row["symbol"] or row.get("product_known") is False for row in facts):
        raise ValueError(
            "Broker instrument/product identity is unavailable; closure cannot be verified"
        )
    orders = [row for row in orders if broker_reports.in_book(session, row)]
    # Treat unfamiliar statuses as outstanding rather than assuming cancellation.
    pending = [row for row in orders if row["status"] not in TERMINAL]
    nonflat = []
    for raw in bundle.positions:
        if not broker_reports.in_book(session, broker_reports.normalize_order(raw)):
            continue
        direct = next(
            (key for key in ("netQty", "net_quantity", "quantity") if key in raw), None
        )
        keys = (
            [direct] if direct else ["cfBuyQty", "flBuyQty", "cfSellQty", "flSellQty"]
        )
        quantities = {}
        for key in keys:
            value = raw.get(key)
            if value in (None, "", "NA", "-", "--"):
                raise ValueError(
                    "Broker position quantity is unavailable; closure cannot be verified"
                )
            quantity = broker_reports.number(value)
            if quantity != int(quantity):
                raise ValueError(
                    "Broker position quantity is invalid; closure cannot be verified"
                )
            quantities[key] = quantity
        net = (
            quantities[direct]
            if direct
            else quantities["cfBuyQty"]
            + quantities["flBuyQty"]
            - quantities["cfSellQty"]
            - quantities["flSellQty"]
        )
        if net:
            nonflat.append(raw)
    # A verified zero quantity needs no expired contract metadata or historical fills.
    try:
        positions = real_broker_state.normalize_positions(session, nonflat)
    except broker_reports.UnknownContractError:
        from app.services.kotak_service import _get_kotak_instruments

        if execution_broker.name(session) == "kite":
            exchanges = {
                "nse_fo": "NFO",
                "bse_fo": "BFO",
                "nse_cm": "NSE",
                "bse_cm": "BSE",
            }
            master = []
            for raw in nonflat:
                row = broker_reports.normalize_order(raw)
                meta = await asyncio.to_thread(
                    broker._metadata,
                    {
                        "exchange": exchanges.get(
                            row["exchange"], row["exchange"].upper()
                        ),
                        "tradingsymbol": row["symbol"],
                    },
                )
                master.append({"symbol": row["symbol"], "expiry": meta.get("expiry")})
        else:
            master = await asyncio.to_thread(_get_kotak_instruments)
        positions = real_broker_state.normalize_positions(session, nonflat, master)
    if (
        getattr(session, "trading_style", "intraday") == "swing"
        and session.instrument_type == "equity"
    ):
        from app.services.swing_real_journal import holding_positions

        holdings = await asyncio.to_thread(broker.get_holdings)
        positions = holding_positions(session, holdings, positions)
    return {
        "session_id": session.session_id,
        "positions": [row for row in positions if row["quantity"]],
        "pending_orders": pending,
        "verified_flat": not any(row["quantity"] for row in positions) and not pending,
        "history_warning": getattr(session, "real_history_warning", None),
        "message": "Broker reports verify current exposure only; older fills and archived P&L are not reconstructed.",
    }
