"""Owned Swing performance: execution cycles, daily valuations and funding evidence."""

import math
import statistics
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from datetime import date as Date

from fastapi import HTTPException

from app.services import performance_service as performance
from app.services import swing_market
from app.services import swing_portfolio_store as portfolios
from app.utils import is_trading_day


def date_of(stamp):
    return datetime.fromtimestamp(int(stamp), UTC).date().isoformat()


def context_rows(parent):
    from app.services.db import get_dynamodb_resource

    table = get_dynamodb_resource().Table("Sessions")
    result = []
    for sid in parent["contexts"].values():
        row = table.get_item(Key={"session_id": sid}, ConsistentRead=True).get("Item")
        if (
            not row
            or row.get("user_id") != parent["user_id"]
            or row.get("portfolio_id") != parent["session_id"]
        ):
            raise HTTPException(
                503, "A portfolio context is unavailable; retry after recovery"
            )
        result.append(row)
    return result


def list_portfolios(user, mode=None, broker=None):
    from boto3.dynamodb.conditions import Key

    from app.services.db import get_dynamodb_resource

    rows = performance.query_all(
        get_dynamodb_resource().Table("Sessions"),
        IndexName="UserIdIndex",
        KeyConditionExpression=Key("user_id").eq(user),
    )
    return [
        {
            "portfolio_id": r["session_id"],
            "mode": r["mode"],
            "broker": r.get("execution_broker"),
            "state": r["state"],
            "date": r["date"],
        }
        for r in sorted(rows, key=lambda row: row.get("created_at", 0), reverse=True)
        if r.get("record_type") == "swing_portfolio"
        and (not mode or r["mode"] == mode)
        and (not broker or r.get("execution_broker") == broker)
    ]


def cycle_inputs(session, rows):
    """Opening basis is internal analytics evidence, never an inserted execution."""
    if session.get("trading_style") != "swing":
        return rows
    product = "NRML" if session.get("instrument_type") == "options" else "CNC"
    result = [
        {
            **r,
            "product": r.get("product") or r.get("broker_product") or product,
            "analytics": {
                **(r.get("analytics") or {}),
                "capital": (r.get("analytics") or {}).get("capital", 0),
            },
        }
        for r in rows
    ]
    captured = int(session.get("opening_inventory_captured_at") or 0)
    for index, holding in enumerate(session.get("opening_positions") or []):
        if not captured:
            raise ValueError("Imported inventory has no capture timestamp")
        result.append(
            {
                **holding,
                "side": "BUY",
                "price": float(holding["avg_entry_price"]),
                "quantity": int(holding["quantity"]),
                "timestamp": captured // 1000 + 19800,
                "trade_id": f"opening:{session.get('opening_inventory_fingerprint')}:{index}",
                "product": product,
                "commission": 0,
                "opening_basis": True,
                "fee_source": "unknown",
                "analytics": {
                    "entry_method": "IMPORTED",
                    "capital": session.get("opening_inventory_capital", 0),
                },
            }
        )
    return result


def cycles(parent, labels=True):
    result = []
    for session in context_rows(parent):
        result.extend(performance.load_session_cycles(session, include_labels=labels))
    return sorted(result, key=lambda c: (c["entry_time"], c["cycle_id"]))


def decorate(cycle):
    cycle.update(
        trading_style="swing",
        entry_date=date_of(cycle["entry_time"]),
        exit_date=date_of(cycle["exit_time"]) if cycle.get("exit_time") else None,
    )
    cycle.setdefault("label_index", int(cycle["cycle_id"][:12], 16))
    cycle["date"] = cycle["exit_date"] or cycle["entry_date"]
    purchased = sum(
        int(r["quantity"]) * float(r["price"])
        for r in cycle["executions"]
        if r["role"] == "entry"
    )
    cycle["return_on_cost_pct"] = (
        cycle["net_pnl"] / purchased * 100
        if purchased > 0 and cycle["state"] == "closed"
        else None
    )
    if any(row.get("opening_basis") for row in cycle["executions"]):
        cycle["imported"] = True
        cycle["acquisition_date"] = None
        cycle["holding_days"] = None
        cycle["holding_trading_days"] = None
    else:
        end = Date.fromisoformat(cycle["exit_date"] or swing_market.today())
        start = Date.fromisoformat(cycle["entry_date"])
        cycle["holding_days"] = (end - start).days
        cycle["holding_trading_days"] = sum(
            is_trading_day(start + timedelta(days=i))
            for i in range(1, (end - start).days + 1)
        )
    return cycle


def trade_stats(all_cycles, start=None, end=None):
    closed = [
        c
        for c in all_cycles
        if c["state"] == "closed"
        and (not start or c["exit_date"] >= start)
        and (not end or c["exit_date"] <= end)
    ]
    closed.sort(key=lambda c: (c["exit_time"], c["cycle_id"]))
    pnl = [c["net_pnl"] for c in closed]
    wins = [v for v in pnl if v > 0]
    losses = [v for v in pnl if v < 0]
    durations = [c["holding_days"] for c in closed if c["holding_days"] is not None]
    average_win = statistics.mean(wins) if wins else None
    average_loss = statistics.mean(losses) if losses else None
    runs = {"winning": 0, "losing": 0}
    current = 0
    previous = 0
    for value in pnl:
        sign = 1 if value > 0 else -1 if value < 0 else 0
        current = current + 1 if sign and sign == previous else 1 if sign else 0
        if sign:
            runs["winning" if sign > 0 else "losing"] = max(
                runs["winning" if sign > 0 else "losing"], current
            )
        previous = sign
    groups = {}
    for name in (
        "symbol",
        "instrument_type",
        "entry_tag",
        "exit_tag",
        "expected_strategy",
        "actual_strategy",
        "expected_category",
        "actual_category",
        "holding_period",
    ):
        rows = defaultdict(list)
        for c in closed:
            days = c["holding_days"]
            key = (
                c.get(name)
                if name in ("symbol", "instrument_type")
                else (
                    "Unknown acquisition date"
                    if days is None
                    else "Same day"
                    if days == 0
                    else "1–3 days"
                    if days <= 3
                    else "4–10 days"
                    if days <= 10
                    else "11–30 days"
                    if days <= 30
                    else "31+ days"
                )
                if name == "holding_period"
                else (c.get("label") or {}).get(name) or "Unlabelled"
            )
            rows[key].append(c["net_pnl"])
        groups[name] = [
            {
                "key": key,
                "count": len(values),
                "net_pnl": round(sum(values), 2),
                "win_pct": sum(v > 0 for v in values) / len(values) * 100,
                "expectancy": statistics.mean(values),
            }
            for key, values in rows.items()
        ]
    r_values = [
        c["net_pnl"] / sum(m["initial_risk"] for m in c["matches"])
        for c in closed
        if c["matches"]
        and all(m.get("initial_risk") is not None for m in c["matches"])
        and sum(m["initial_risk"] for m in c["matches"]) > 0
    ]
    return {
        "count": len(closed),
        "wins": len(wins),
        "losses": len(losses),
        "breakeven": sum(v == 0 for v in pnl),
        "win_pct": len(wins) / len(closed) * 100 if closed else None,
        "net_pnl": round(sum(pnl), 2),
        "average_win": average_win,
        "average_loss": average_loss,
        "payoff_ratio": average_win / abs(average_loss)
        if average_win is not None and average_loss
        else None,
        "profit_factor": sum(wins) / abs(sum(losses)) if losses else None,
        "expectancy": statistics.mean(pnl) if pnl else None,
        "average_return_on_cost_pct": statistics.mean(
            [
                c["return_on_cost_pct"]
                for c in closed
                if c.get("return_on_cost_pct") is not None
            ]
        )
        if any(c.get("return_on_cost_pct") is not None for c in closed)
        else None,
        "holding_count": len(durations),
        "median_holding_days": statistics.median(durations) if durations else None,
        "average_holding_days": statistics.mean(durations) if durations else None,
        "average_trading_days": statistics.mean(
            [
                c["holding_trading_days"]
                for c in closed
                if c["holding_trading_days"] is not None
            ]
        )
        if durations
        else None,
        "best": max(pnl) if pnl else None,
        "worst": min(pnl) if pnl else None,
        "streaks": runs,
        "mean_r": statistics.mean(r_values) if r_values else None,
        "r_count": len(r_values),
        "groups": groups,
    }


def price_history(item, start, end):
    from app.services import swing_charts

    result = {}
    before = None
    while True:
        page = swing_charts.history(item, "1D", end, before, 500)
        for row in page["candles"]:
            day = date_of(row["time"])
            if start <= day <= end:
                result[day] = row["close"]
        if (
            not page["more"]
            or not page["candles"]
            or date_of(page["candles"][0]["time"]) <= start
        ):
            break
        next_before = page["candles"][0]["time"]
        if before is not None and next_before >= before:
            break
        before = next_before
    return result


def funding_flows(parent):
    if parent["mode"] != "real":
        return [], True
    from boto3.dynamodb.conditions import Key

    from app.services import swing_funding_store as funding

    rows = performance.query_all(
        funding._table(),
        KeyConditionExpression=Key("user_id").eq(
            funding.partition(parent["execution_broker"], parent["broker_account_id"])
        )
        & Key("ledger_id").begins_with(
            f"funding-op:{parent.get('real_funding_period') or parent.get('prepared_funding_period')}:"
        ),
        ConsistentRead=True,
    )
    flows = []
    complete = True
    for row in rows:
        if "analytics" not in row:
            # Old execution/entry receipts do not represent external flows.
            if row.get("kind") in (
                "capital",
                "allocation",
                "cash_correction",
                "reset_capital",
                "change_allocation",
                "negative_cash_correction",
                "acknowledged_cash_shortfall",
                "claim",
            ):
                complete = False
            continue
        for event in row["analytics"]:
            if event.get("session_id") == parent["session_id"] and event.get(
                "cash_flow"
            ):
                flows.append(event)
    return sorted(flows, key=lambda r: r["timestamp"]), complete


def valuation_series(parent, all_cycles, start, end, loader=price_history):
    """Daily Modified Dietz returns, geometrically linked; reservations are not expenses."""
    from app.services import swing_charts

    creation = parent["date"]
    end = min(end, swing_market.today())
    if end == swing_market.today() and swing_market.now() < swing_market.closing(end):
        end = (Date.fromisoformat(end) - timedelta(days=1)).isoformat()
    flows, flow_complete = funding_flows(parent)
    baseline_day = Date.fromisoformat(max(start, creation)) - timedelta(days=1)
    while not is_trading_day(baseline_day):
        baseline_day -= timedelta(days=1)
    valuation_start = max(creation, baseline_day.isoformat())
    executions = []
    prices = {}
    missing = []
    for c in all_cycles:
        key = (c["symbol"], c["right"], c["strike"], c["expiry"])
        for r in c["executions"]:
            executions.append({**r, "key": key})
        if key not in prices:
            spans = [
                row
                for row in all_cycles
                if (row["symbol"], row["right"], row["strike"], row["expiry"]) == key
            ]
            held_end = max(row.get("exit_date") or end for row in spans)
            if held_end < valuation_start:
                prices[key] = {}
                continue
            try:
                prices[key] = loader(
                    swing_charts.instrument(
                        c["symbol"],
                        "options" if c["right"] else "equity",
                        c["right"],
                        c["strike"],
                        c["expiry"],
                    ),
                    valuation_start,
                    min(end, held_end),
                )
            except Exception:  # noqa: BLE001 — disclose unavailable provider data as gaps
                prices[key] = {}
    executions.sort(
        key=lambda r: (r["timestamp"], r.get("execution_id") or r.get("trade_id") or "")
    )
    cash = float(parent["starting_capital"])
    holdings = defaultdict(int)
    lots = defaultdict(deque)
    period_flow = 0.0
    period_fees = 0.0
    final_unrealized = None
    rows = []
    execution_index = flow_index = 0
    previous_nav = cash
    wealth = 1.0
    peak = 1.0
    maximum = 0.0
    max_rupees = 0.0
    rupee_peak = None
    period_base = None
    underwater = 0
    longest = 0
    returns = []
    continuous = flow_complete and not parent.get("history_warning")
    months = {}
    first = Date.fromisoformat(creation)
    last = Date.fromisoformat(end)
    for offset in range(max(0, (last - first).days + 1)):
        day = first + timedelta(days=offset)
        if not is_trading_day(day):
            continue
        date = day.isoformat()
        closing = swing_market.closing(date) - 1
        imported_today = False
        unknown_adjustment = False
        day_flows = []
        while flow_index < len(flows) and flows[flow_index]["timestamp"] <= closing:
            event = flows[flow_index]
            if event.get("classification") == "unclassified":
                unknown_adjustment = True
            day_flows.append(event)
            cash += float(event["cash_flow"])
            if start <= date <= end:
                period_flow += float(event["cash_flow"])
            flow_index += 1
        while (
            execution_index < len(executions)
            and executions[execution_index]["timestamp"] <= closing
        ):
            row = executions[execution_index]
            if row.get("opening_basis") and date_of(row["timestamp"]) == date:
                imported_today = True
            quantity = int(row["quantity"])
            value = quantity * float(row["price"])
            buy = row["side"] == "BUY"
            cash += (-value if buy else value) - float(row.get("commission") or 0)
            holdings[row["key"]] += quantity if buy else -quantity
            fee = float(row.get("commission") or 0)
            if start <= date_of(row["timestamp"]) <= end:
                period_fees += fee
            if buy:
                lots[row["key"]].append([quantity, float(row["price"]), fee / quantity])
            else:
                remaining = quantity
                while remaining and lots[row["key"]]:
                    lot = lots[row["key"]][0]
                    matched = min(remaining, lot[0])
                    lot[0] -= matched
                    remaining -= matched
                    if not lot[0]:
                        lots[row["key"]].popleft()
            execution_index += 1
        value = 0
        gap = False
        for key, quantity in holdings.items():
            if not quantity:
                continue
            mark = prices[key].get(date)
            if mark is None or quantity < 0:
                gap = True
                missing.append(
                    {
                        "date": date,
                        "symbol": key[0],
                        "reason": "Held instrument has no valid daily valuation",
                    }
                )
            else:
                value += quantity * mark
        nav = (
            None
            if gap or not flow_complete or parent.get("history_warning")
            else cash + value
        )
        final_unrealized = (
            value
            - sum(
                q * (price + fee)
                for batches in lots.values()
                for q, price, fee in batches
            )
            if nav is not None
            else None
        )
        if nav is None or previous_nav is None:
            daily = None
        else:
            opening = swing_market.closing(date) - 22500
            weighted = sum(
                float(f["cash_flow"])
                * (1 - min(1, max(0, (f["timestamp"] - opening) / 22500)))
                for f in day_flows
            )
            denominator = previous_nav + weighted
            daily = (
                (nav - previous_nav - sum(float(f["cash_flow"]) for f in day_flows))
                / denominator
                if denominator > 0
                else None
            )
        if unknown_adjustment:
            daily = None
            missing.append(
                {
                    "date": date,
                    "symbol": "Funding correction",
                    "reason": "Cash correction is not classified as an external transfer or expense",
                }
            )
        if imported_today:
            daily = None
            missing.append(
                {
                    "date": date,
                    "symbol": "Imported inventory",
                    "reason": "Capture-time market valuation is unknown; opening gain cannot be attributed to this portfolio period",
                }
            )
        in_range = start <= date <= end
        if in_range and daily is None:
            continuous = False
        if in_range:
            if period_base is None and previous_nav is not None:
                period_base = previous_nav
            if daily is not None:
                wealth *= 1 + daily
                returns.append(daily)
                month = date[:7]
                months[month] = months.get(month, 1) * (1 + daily)
                peak = max(peak, wealth)
                drawdown = (1 - wealth / peak) * 100 if peak > 0 else None
                if drawdown and drawdown > 0:
                    underwater += 1
                    longest = max(longest, underwater)
                else:
                    underwater = 0
                maximum = max(maximum, drawdown or 0)
                adjusted_nav = nav - period_flow
                rupee_peak = max(
                    rupee_peak
                    if rupee_peak is not None
                    else period_base or adjusted_nav,
                    adjusted_nav,
                )
                max_rupees = max(max_rupees, rupee_peak - adjusted_nav)
            rows.append(
                {
                    "date": date,
                    "nav": round(nav, 2) if nav is not None else None,
                    "cash": round(cash, 2)
                    if flow_complete and not parent.get("history_warning")
                    else None,
                    "invested_value": round(value, 2) if not gap else None,
                    "return_pct": daily * 100 if daily is not None else None,
                    "growth": wealth if continuous else None,
                    "drawdown_pct": (1 - wealth / peak) * 100 if continuous else None,
                }
            )
        previous_nav = nav
    annual = {key: None for key in ("cagr_pct", "volatility_pct", "sharpe", "sortino")}
    elapsed = (last - Date.fromisoformat(max(start, creation))).days
    if continuous and elapsed >= 365 and len(returns) >= 252:
        deviation = statistics.stdev(returns)
        mean = statistics.mean(returns)
        downside = math.sqrt(sum(min(0, r) ** 2 for r in returns) / len(returns))
        annual.update(
            cagr_pct=(wealth ** (365.25 / max(1, elapsed)) - 1) * 100
            if wealth > 0
            else None,
            volatility_pct=deviation * math.sqrt(252) * 100,
            sharpe=mean / deviation * math.sqrt(252) if deviation else None,
            sortino=mean / downside * math.sqrt(252) if downside else None,
        )
    return {
        "period_pnl": rows[-1]["nav"] - period_base - period_flow
        if rows
        and continuous
        and rows[-1]["nav"] is not None
        and period_base is not None
        else None,
        "known_period_fees": round(period_fees, 2),
        "unrealized_pnl_at_end": round(final_unrealized, 2)
        if final_unrealized is not None
        else None,
        "series": rows,
        "coverage_complete": continuous,
        "missing": [gap for gap in missing if gap["date"] >= valuation_start],
        "flow_history_complete": flow_complete,
        "return_pct": (wealth - 1) * 100 if continuous and rows else None,
        "max_drawdown_pct": maximum if continuous and rows else None,
        "max_drawdown_rupees": max_rupees if continuous and rows else None,
        "drawdown_duration_trading_days": longest if continuous else None,
        "monthly_returns": [
            {
                "month": m,
                "return_pct": (v - 1) * 100 if continuous else None,
                "partial": (
                    m == max(start, creation)[:7] and max(start, creation)[8:] != "01"
                )
                or (
                    m == end[:7]
                    and (Date.fromisoformat(end) + timedelta(days=1)).month
                    == Date.fromisoformat(end).month
                ),
            }
            for m, v in months.items()
        ],
        "annual": annual,
        "return_method": "Daily Modified Dietz, geometrically linked",
        "risk_free_pct": 0,
        "fees": "Known application estimates; imported fees may be unknown",
    }


def report(user, pid, start=None, end=None, include_history=True):
    parent = portfolios.owned(user, pid)
    start = start or parent["date"]
    end = end or swing_market.today()
    Date.fromisoformat(start)
    Date.fromisoformat(end)
    if start > end or end > swing_market.today():
        raise HTTPException(422, "Choose a valid report period ending today or earlier")
    rows = [decorate(c) for c in cycles(parent)]
    closed = trade_stats(rows, start, end)
    realized = sum(
        m["net_pnl"]
        for c in rows
        for m in c["matches"]
        if start <= date_of(m["exit_time"]) <= end
    )
    result = {
        "portfolio": {
            "portfolio_id": pid,
            "mode": parent["mode"],
            "broker": parent.get("execution_broker"),
            "state": parent["state"],
        },
        "start_date": start,
        "end_date": end,
        "closed_trades": closed,
        "period_realized_pnl": round(realized, 2),
        "known_period_fees": round(
            sum(
                float(r.get("commission") or 0)
                for c in rows
                for r in c["executions"]
                if start <= date_of(r["timestamp"]) <= end
            ),
            2,
        ),
        "cycles": rows,
        "history_warning": parent.get("history_warning"),
    }
    from app.services.swing_portfolio_service import _runtimes, snapshot

    if pid in _runtimes:
        current = snapshot(user, pid)
    else:
        positions = []
        for cycle in rows:
            if cycle["state"] != "open":
                continue
            quantity = cycle["open_quantity"]
            entries = [r for r in cycle["executions"] if r["role"] == "entry"]
            basis = (
                sum(int(r["quantity"]) * float(r["price"]) for r in entries)
                - sum(m["quantity"] * m["entry_price"] for m in cycle["matches"])
            ) / quantity
            positions.append(
                {
                    "symbol": cycle["symbol"],
                    "right": cycle["right"],
                    "strike": cycle["strike"],
                    "expiry": cycle["expiry"],
                    "quantity": quantity,
                    "invested_value": quantity * basis,
                    "mark_price": None,
                    "unrealized_pnl": None,
                    "quote_status": "unavailable",
                }
            )
        current = {"positions": positions, "wallet_balance": None}
    positions = current["positions"]
    for position in positions:
        matching = next(
            (
                c
                for c in rows
                if c["state"] == "open"
                and (c["symbol"], c["right"], c["strike"], c["expiry"])
                == (
                    position["symbol"],
                    position.get("right"),
                    position.get("strike"),
                    position.get("expiry"),
                )
            ),
            None,
        )
        position["holding_days"] = matching.get("holding_days") if matching else None
        position["market_value"] = (
            position["quantity"] * position["mark_price"]
            if position.get("mark_price") is not None
            else None
        )
    total = sum(p["invested_value"] for p in positions)
    result["funding_status"] = current.get("funding_status")
    result["exposure"] = {
        "as_of": swing_market.now(),
        "cash": current["wallet_balance"],
        "positions": positions,
        "invested_cost": round(total, 2),
        "largest_position_pct": max(
            (p["invested_value"] / total * 100 for p in positions), default=0
        )
        if total
        else 0,
        "allocation": [
            {
                "kind": kind,
                "cost": sum(
                    p["invested_value"]
                    for p in positions
                    if bool(p.get("right")) == (kind == "options")
                ),
            }
            for kind in ("equity", "options")
        ],
    }
    result["portfolio_performance"] = (
        valuation_series(parent, rows, start, end) if include_history else None
    )
    return result
