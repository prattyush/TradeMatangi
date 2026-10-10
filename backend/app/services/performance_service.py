"""Execution-based performance analysis, independent of labels and order display rows."""

from app.services.broker_reports import order_id as broker_report_id
from collections import defaultdict, deque
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import math
import random
import statistics

VERSION = 1


def number(value, default=0.0):
    result = float(value) if value is not None else default
    if not math.isfinite(result):
        raise ValueError("Nonfinite analytics input")
    return result


def percent(pnl, capital):
    return 100 * pnl / capital if capital and capital > 0 else None


def _identity(session, row):
    # Null model defaults and DynamoDB numeric types must yield the same stable
    # identity as persisted execution rows and JSON snapshots.
    strike = row.get("strike")
    return (
        row.get("symbol") or session.get("symbol"),
        row.get("broker_exchange") or row.get("exchange") or "",
        (row.get("product") or row.get("broker_product") or "MIS").upper(),
        row.get("right"),
        int(strike) if strike is not None else None,
        row.get("expiry"),
    )


def execution_order_key(row):
    identifier = str(row.get("execution_id", row.get("trade_id", "")))
    identity = (0, int(identifier)) if identifier.isdigit() else (1, identifier)
    return (
        int(row.get("execution_sort_time") or int(row["timestamp"]) * 1_000_000),
        identity,
    )


def build_cycles(session, executions):
    """Consume fills once; crossing flat splits a reversal and its commissions."""
    books, cycles, seen = {}, [], {}
    rows = sorted(executions, key=execution_order_key)
    for row in rows:
        quantity = int(row.get("quantity", 0))
        price = number(row.get("price"))
        side = row.get("side")
        if quantity <= 0 or price <= 0 or side not in ("BUY", "SELL"):
            raise ValueError("Invalid analytics execution")
        key = _identity(session, row)
        identifier = str(row.get("execution_id", row.get("trade_id", "")))
        identity = (key, (row.get("broker_order_id") or row.get("kotak_order_id")), identifier)
        fingerprint = (
            side,
            quantity,
            price,
            int(row["timestamp"]),
            execution_order_key(row)[0],
        )
        if identity in seen:
            if seen[identity] != fingerprint:
                raise ValueError("Conflicting duplicate analytics execution")
            continue
        seen[identity] = fingerprint
        sign = 1 if side == "BUY" else -1
        from app.services.execution_analytics import normalize_metadata

        meta = normalize_metadata(row.get("analytics") or {})
        capital = number(meta.get("capital", session.get("session_capital")))
        action = str(
            meta.get("action_id")
            or (row.get("broker_order_id") or row.get("kotak_order_id"))
            or row.get("trade_id")
            or identifier
        )
        fee_unit = number(row.get("commission")) / quantity
        remaining = quantity
        while remaining:
            state = books.get(key)
            if state is None:
                scope = session.get("broker_projection_id") or session.get(
                    "session_id", ""
                )
                cycle_id = hashlib.sha256(
                    repr((scope, key, identifier)).encode()
                ).hexdigest()[:24]
                state = dict(
                    cycle_id=cycle_id,
                    session_id=session.get("session_id"),
                    user_id=session.get("user_id"),
                    index=len(cycles),
                    symbol=key[0],
                    exchange=key[1],
                    product=key[2],
                    right=key[3],
                    strike=key[4],
                    expiry=key[5],
                    instrument_type=session.get("instrument_type", "equity"),
                    mode=session.get("session_type", "sim"),
                    execution_broker=row.get("execution_broker") or (session.get("execution_broker") if session.get("session_type") == "real" else None),
                    broker_account_id=row.get("broker_account_id") or session.get("broker_account_id"),
                    date=session.get("date", ""),
                    book_id=session.get("broker_projection_id")
                    or session.get("wallet_ledger_id")
                    or session.get("session_id"),
                    direction="LONG" if sign > 0 else "SHORT",
                    capital=capital,
                    entry_time=int(row["timestamp"]),
                    exit_time=None,
                    state="open",
                    net_pnl=0.0,
                    gross_pnl=0.0,
                    fees=0.0,
                    open_quantity=0,
                    open_entry_fees=0.0,
                    entries=[],
                    exits=[],
                    matches=[],
                    executions=[],
                    label=None,
                    chronology_quality=(
                        "executions"
                        if row.get("execution_id") or row.get("execution_sort_time")
                        else "order_rows"
                    ),
                    _lots=deque(),
                    _sign=sign,
                )
                books[key] = state
                cycles.append(state)
            if sign == state["_sign"]:
                entry_id = action
                entry = next(
                    (e for e in state["entries"] if e["entry_id"] == entry_id), None
                )
                if entry is None:
                    entry = dict(
                        entry_id=entry_id,
                        entry_method=meta.get("entry_method", "UNKNOWN"),
                        client=meta.get("client")
                        or (
                            "desktop"
                            if str(row.get("source", "")).startswith("desktop_")
                            else "unknown"
                        ),
                        timestamp=int(row["timestamp"]),
                        first_price=price,
                        addition_context=(
                            (
                                "adding while losing"
                                if state["_sign"]
                                * sum(
                                    (price - l["price"]) * l["quantity"]
                                    for l in state["_lots"]
                                )
                                < 0
                                else "adding while profitable/flat"
                            )
                            if state["_lots"]
                            else None
                        ),
                        quantity=0,
                        value=0.0,
                        matched_quantity=0,
                        gross_pnl=0.0,
                        net_pnl=0.0,
                        fees=0.0,
                        capital=capital,
                        sizing_method=meta.get("sizing_method", "UNKNOWN"),
                        requested_pct=meta.get("requested_pct"),
                        analytics=meta,
                        initial_risk=(
                            0.0 if meta.get("initial_risk") is not None else None
                        ),
                    )
                    state["entries"].append(entry)
                entry["quantity"] += remaining
                entry["value"] += price * remaining
                if meta.get("initial_risk") is None:
                    entry["initial_risk"] = None
                if entry["initial_risk"] is not None:
                    entry["initial_risk"] += (
                        number(meta.get("initial_risk")) * remaining / quantity
                    )
                lot = dict(
                    row=row,
                    meta=meta,
                    quantity=remaining,
                    price=price,
                    fee_unit=fee_unit,
                    entry=entry,
                    identifier=identifier,
                )
                state["_lots"].append(lot)
                state["executions"].append(
                    {
                        **row,
                        "quantity": remaining,
                        "commission": fee_unit * remaining,
                        "role": "entry",
                    }
                )
                remaining = 0
            else:
                exit_action = str(meta.get("exit_action_id") or action)
                closing = min(remaining, sum(l["quantity"] for l in state["_lots"]))
                state["executions"].append(
                    {
                        **row,
                        "quantity": closing,
                        "commission": fee_unit * closing,
                        "role": "exit",
                    }
                )
                state["exits"].append(
                    dict(
                        exit_id=exit_action,
                        exit_method=meta.get("exit_method", "UNKNOWN"),
                        timestamp=int(row["timestamp"]),
                        quantity=closing,
                        price=price,
                        analytics=meta,
                    )
                )
                to_close = closing
                while to_close:
                    lot = state["_lots"][0]
                    q = min(to_close, lot["quantity"])
                    gross = state["_sign"] * q * (price - lot["price"])
                    fees = q * (lot["fee_unit"] + fee_unit)
                    net = gross - fees
                    entry = lot["entry"]
                    risk = (
                        number(lot["meta"].get("initial_risk"))
                        * q
                        / int(lot["row"]["quantity"])
                        if lot["meta"].get("initial_risk") is not None
                        else None
                    )
                    match = dict(
                        entry_id=entry["entry_id"],
                        exit_id=exit_action,
                        entry_execution_id=lot["identifier"],
                        exit_execution_id=identifier,
                        quantity=q,
                        entry_price=lot["price"],
                        exit_price=price,
                        entry_time=int(lot["row"]["timestamp"]),
                        exit_time=int(row["timestamp"]),
                        entry_method=entry["entry_method"],
                        exit_method=meta.get("exit_method", "UNKNOWN"),
                        sizing_method=entry["sizing_method"],
                        requested_pct=entry["requested_pct"],
                        gross_pnl=gross,
                        fees=fees,
                        net_pnl=net,
                        capital=entry["capital"],
                        pnl_pct=percent(net, entry["capital"]),
                        initial_risk=risk,
                        r_multiple=net / risk if risk and risk > 0 else None,
                        requested_size=meta.get("requested_size"),
                        excursion=None,
                    )
                    state["matches"].append(match)
                    for name, value in (
                        ("gross_pnl", gross),
                        ("net_pnl", net),
                        ("fees", fees),
                    ):
                        state[name] += value
                        entry[name] += value
                    entry["matched_quantity"] += q
                    lot["quantity"] -= q
                    to_close -= q
                    if lot["quantity"] == 0:
                        state["_lots"].popleft()
                remaining -= closing
                if not state["_lots"]:
                    state["state"] = "closed"
                    state["exit_time"] = int(row["timestamp"])
                    books.pop(key)
    for state in cycles:
        state["open_quantity"] = sum(l["quantity"] for l in state["_lots"])
        state["open_entry_fees"] = sum(
            l["quantity"] * l["fee_unit"] for l in state["_lots"]
        )
        state["pnl_pct"] = percent(state["net_pnl"], state["capital"])
        state["entry_count"] = len(state["entries"])
        state["exit_count"] = len({e["exit_id"] for e in state["exits"]})
        state["holding_seconds"] = (
            state["exit_time"] - state["entry_time"] if state["exit_time"] else None
        )
        for entry in state["entries"]:
            entry["average_price"] = entry["value"] / entry["quantity"]
            from app.services.execution_analytics import filled

            entry["analytics"] = (
                filled(entry["analytics"], entry["average_price"], entry["quantity"])
                or {}
            )
            entry["analytics"]["initial_risk"] = entry["initial_risk"]
            entry["analytics"]["effective_risk_pct"] = (
                percent(entry["initial_risk"], entry["capital"])
                if entry["initial_risk"] is not None
                else None
            )
            entry["open_quantity"] = entry["quantity"] - entry["matched_quantity"]
            entry["pnl_pct"] = percent(entry["net_pnl"], entry["capital"])
            entry["r_multiple"] = (
                entry["net_pnl"] / entry["initial_risk"]
                if entry["initial_risk"] and not entry["open_quantity"]
                else None
            )
        del state["_lots"], state["_sign"]
    return cycles


def outcome_stats(items):
    pnls = [number(i["net_pnl"]) for i in items]
    pcts = [i["pnl_pct"] for i in items if i.get("pnl_pct") is not None]
    rs = [number(i["r_multiple"]) for i in items if i.get("r_multiple") is not None]
    positive = [p for p in pnls if p > 0.005]
    negative = [p for p in pnls if p < -0.005]
    return dict(
        count=len(items),
        mean_r=statistics.mean(rs) if rs else None,
        median_r=statistics.median(rs) if rs else None,
        r_count=len(rs),
        net_pnl=sum(pnls),
        wins=len(positive),
        losses=len(negative),
        breakeven=len(pnls) - len(positive) - len(negative),
        win_pct=100 * len(positive) / len(pnls) if pnls else None,
        expectancy=statistics.mean(pnls) if pnls else None,
        median_pnl=statistics.median(pnls) if pnls else None,
        mean_pnl_pct=statistics.mean(pcts) if pcts else None,
        median_pnl_pct=statistics.median(pcts) if pcts else None,
        profit_factor=sum(positive) / -sum(negative) if negative else None,
        average_win=statistics.mean(positive) if positive else None,
        average_loss=statistics.mean(negative) if negative else None,
        fees=sum(number(i.get("fees")) for i in items),
        quantity=sum(int(i.get("quantity", 0)) for i in items),
    )


def mean_interval(cycles):
    by_date = defaultdict(list)
    for c in cycles:
        by_date[c["date"]].append(c["net_pnl"])
    if len(cycles) < 30 or len(by_date) < 20:
        return None
    days = sorted(by_date)
    rng = random.Random(20)
    means = []
    for _ in range(1000):
        sample = [p for d in rng.choices(days, k=len(days)) for p in by_date[d]]
        means.append(statistics.mean(sample))
    means.sort()
    return [means[24], means[974]]


def groups(cycles, dimension, level="entry"):
    grouped = defaultdict(list)
    related = defaultdict(dict)
    for cycle in cycles:
        rows = cycle["entries"] if level == "entry" else cycle["matches"]
        for row in rows:
            key = str(
                row.get(dimension) if row.get(dimension) is not None else "UNKNOWN"
            )
            if dimension == "requested_pct" and row.get(dimension) is not None:
                key = format(float(row[dimension]), ".12g")
            grouped[key].append({**row, "_cycle_id": cycle["cycle_id"]})
            related[key][cycle["cycle_id"]] = cycle
    result = []
    for key, rows in sorted(grouped.items()):
        if level == "match":
            exits = {}
            for row in rows:
                identity = (row["_cycle_id"], row["exit_id"])
                item = exits.setdefault(
                    identity,
                    dict(
                        net_pnl=0.0,
                        fees=0.0,
                        quantity=0,
                        capital=row["capital"],
                        exit_id=row["exit_id"],
                        initial_risk=0.0,
                        risk_known=True,
                    ),
                )
                if row.get("initial_risk") is None:
                    item["risk_known"] = False
                else:
                    item["initial_risk"] += row["initial_risk"]
                for field in ("net_pnl", "fees", "quantity"):
                    item[field] += row[field]
            rows = [
                {
                    **r,
                    "pnl_pct": percent(r["net_pnl"], r["capital"]),
                    "r_multiple": (
                        r["net_pnl"] / r["initial_risk"]
                        if r["risk_known"] and r["initial_risk"] > 0
                        else None
                    ),
                }
                for r in exits.values()
            ]
        closed = [r for r in rows if not r.get("open_quantity", 0)]
        associated = [c for c in related[key].values() if c["state"] == "closed"]
        result.append(
            dict(
                key=key,
                **outcome_stats(closed),
                realized_pnl=sum(r["net_pnl"] for r in rows),
                actions=len(
                    {
                        r.get("entry_id") if level == "entry" else r.get("exit_id")
                        for r in rows
                    }
                ),
                days=len({c["date"] for c in associated}),
                cycle_count=len(associated),
                associated=outcome_stats(associated),
                mean_interval=mean_interval(associated),
                exploratory=len(associated) < 30
                or len({c["date"] for c in associated}) < 20,
            )
        )
    return result


def behavior_groups(cycles):
    sequence = defaultdict(int)
    grouped = defaultdict(list)
    history = {}
    for c in sorted(cycles, key=lambda c: (c["entry_time"], c["cycle_id"])):
        bucket = lambda n: str(n) if n < 4 else "4+"
        daily_key = (c.get("user_id"), c["mode"], c["date"], c.get("book_id"))
        sequence[daily_key] += 1
        ordinal = sequence[daily_key]
        tags = [
            ("entry_count", bucket(c["entry_count"])),
            ("exit_count", bucket(c["exit_count"])),
            (
                "daily_sequence",
                (
                    "1–3"
                    if ordinal <= 3
                    else "4–6" if ordinal <= 6 else "7–10" if ordinal <= 10 else "11+"
                ),
            ),
        ]
        if c["holding_seconds"] is not None:
            duration = c["holding_seconds"]
            tags.append(
                (
                    "holding_duration",
                    (
                        "<1 minute"
                        if duration < 60
                        else (
                            "1–5 minutes"
                            if duration < 300
                            else "5–15 minutes" if duration < 900 else "15+ minutes"
                        )
                    ),
                )
            )
        dt = datetime.fromtimestamp(c["entry_time"], timezone.utc)
        tags += [
            ("time_of_day", f"{dt.hour:02}:{(dt.minute // 30)*30:02}"),
            ("weekday", dt.strftime("%A")),
        ]
        entries = sorted(c["entries"], key=lambda e: e["timestamp"])
        gaps = []
        for prev, entry in zip(entries, entries[1:]):
            interval = int(entry["analytics"].get("strategy_interval_seconds") or 0)
            prev_interval = int(prev["analytics"].get("strategy_interval_seconds") or 0)
            if not interval or interval != prev_interval:
                continue
            gap = entry["timestamp"] - prev["timestamp"]
            key = (
                "same bar"
                if entry["timestamp"] // interval == prev["timestamp"] // interval
                else (
                    "<1 interval"
                    if gap < interval
                    else (
                        "1–2 intervals"
                        if gap < 2 * interval
                        else "2–5 intervals" if gap < 5 * interval else "5+ intervals"
                    )
                )
            )
            gaps.append(key)
            if entry.get("addition_context"):
                tags.append(("addition_context", entry["addition_context"]))
            tags.append(
                (
                    "addition_size",
                    (
                        "<50%"
                        if entry["quantity"] < prev["quantity"] * 0.5
                        else (
                            "50–100%"
                            if entry["quantity"] <= prev["quantity"]
                            else ">100%"
                        )
                    ),
                )
            )
        tags += [("entry_spacing", g) for g in set(gaps)]
        book = (
            c.get("user_id"),
            c["mode"],
            c["date"],
            c.get("book_id"),
            c["symbol"],
            c["exchange"],
            c["product"],
        )
        prior = history.get(book)
        if prior and prior["exit_time"] and prior["exit_time"] <= c["entry_time"]:
            interval = int(
                entries[0]["analytics"].get("strategy_interval_seconds") or 0
            )
            if interval and c["entry_time"] - prior["exit_time"] < interval:
                tags.append(
                    (
                        "rapid_reentry",
                        (
                            "after loss"
                            if prior["net_pnl"] < 0
                            else "after profit/breakeven"
                        ),
                    )
                )
            if prior["net_pnl"] < 0:
                tags.append(
                    (
                        "size_after_loss",
                        (
                            "increased"
                            if entries[0]["quantity"] > prior["entries"][0]["quantity"]
                            else "same/smaller"
                        ),
                    )
                )
        history[book] = c
        c["behavior"] = [{"dimension": d, "key": k} for d, k in sorted(set(tags))]
        if c["state"] == "closed":
            for d, k in set(tags):
                grouped[(d, k)].append(c)
    return [
        dict(
            dimension=d,
            key=k,
            **outcome_stats(rows),
            days=len({c["date"] for c in rows}),
            exploratory=len(rows) < 30 or len({c["date"] for c in rows}) < 20,
        )
        for (d, k), rows in sorted(grouped.items())
    ]


def report(cycles):
    closed = [c for c in cycles if c["state"] == "closed"]
    behavior = behavior_groups(cycles)
    peak = balance = drawdown = 0.0
    curve = []
    daily = defaultdict(lambda: dict(net_pnl=0.0, fees=0.0, cycles=0))
    for c in sorted(closed, key=lambda c: (c["exit_time"], c["cycle_id"])):
        balance += c["net_pnl"]
        peak = max(peak, balance)
        drawdown = max(drawdown, peak - balance)
        curve.append(
            dict(
                time=c["exit_time"],
                pnl=balance,
                drawdown=peak - balance,
                cycle_id=c["cycle_id"],
            )
        )
        day = daily[c["date"]]
        day["net_pnl"] += c["net_pnl"]
        day["fees"] += c["fees"]
        day["cycles"] += 1
    comparisons = dict(
        entries=groups(cycles, "entry_method"),
        exits=groups(cycles, "exit_method", "match"),
        sizing=groups(cycles, "sizing_method"),
        percentages=groups(cycles, "requested_pct"),
        clients=groups(cycles, "client"),
        exit_sizes=groups(cycles, "requested_size", "match"),
    )
    for dimension in ("entry_tag", "exit_tag", "expected_strategy", "actual_strategy"):
        labeled = defaultdict(list)
        for c in closed:
            labeled[(c.get("label") or {}).get(dimension) or "Unlabeled"].append(c)
        comparisons[dimension] = [
            dict(key=k, **outcome_stats(v)) for k, v in sorted(labeled.items())
        ]
    modes = defaultdict(list)
    for c in closed:
        modes[c["mode"]].append(c)
    comparisons["modes"] = [
        dict(key=k, **outcome_stats(v)) for k, v in sorted(modes.items())
    ]
    accounts = defaultdict(list)
    for c in closed:
        accounts[c.get('owner_email') or c.get('user_id') if c.get('shared') else 'Own account'].append(c)
    comparisons['accounts'] = [dict(key=key,**outcome_stats(rows),exploratory=len(rows)<30 or len({c['date'] for c in rows})<20) for key,rows in sorted(accounts.items())]
    matrix = defaultdict(list)
    for c in cycles:
        for m in c["matches"]:
            matrix[(m["entry_method"], m["exit_method"])].append(m)
    known = sum(
        1 for c in cycles for e in c["entries"] if e["entry_method"] != "UNKNOWN"
    )
    count = sum(len(c["entries"]) for c in cycles)
    insights = []
    for row in behavior:
        if (
            not row["exploratory"]
            and row["expectancy"] is not None
            and row["expectancy"] < 0
        ):
            insights.append(
                dict(
                    dimension=row["dimension"],
                    key=row["key"],
                    text=f"{row['key']}: average net outcome ₹{row['expectancy']:.2f} across {row['count']} cycles / {row['days']} market dates. Observed association; inspect the underlying trades.",
                )
            )
    return dict(
        version=VERSION,
        summary={
            **outcome_stats(closed),
            "realized_pnl": sum(c["net_pnl"] for c in cycles),
            "open_cycles": len(cycles) - len(closed),
            "open_entry_fees": sum(c["open_entry_fees"] for c in cycles),
            "drawdown": drawdown,
            "days": len(daily),
            "mean_interval": mean_interval(closed),
        },
        comparisons=comparisons,
        behavior=behavior,
        curve=curve,
        daily=[dict(date=d, **v) for d, v in sorted(daily.items())],
        matrix=[
            dict(entry=a, exit=b, **outcome_stats(v))
            for (a, b), v in sorted(matrix.items())
        ],
        coverage=dict(
            entries=count,
            known_entries=known,
            labeled_cycles=sum(bool(c.get("label")) for c in cycles),
            order_level_cycles=sum(
                c["chronology_quality"] == "order_rows" for c in cycles
            ),
        ),
        insights=insights[:5],
        distributions=[
            dict(
                cycle_id=c["cycle_id"],
                pnl=c["net_pnl"],
                pnl_pct=c["pnl_pct"],
                date=c["date"],
                mode=c["mode"],
            )
            for c in closed
        ],
    )


def query_all(table, **params):
    items = []
    while True:
        response = table.query(**params)
        items.extend(response.get("Items", []))
        if not response.get("LastEvaluatedKey"):
            return items
        params["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def load_session_cycles(session, include_labels=True):
    """Read one committed book. Never call a broker or use in-memory pending state."""
    from app.services.db import get_dynamodb_resource
    from app.services.real_broker_state import link_for
    from boto3.dynamodb.conditions import Key

    db = get_dynamodb_resource()
    sid = session["session_id"]
    partition = sid
    link = link_for(sid) if session.get("session_type") == "real" else None
    manifest = None
    if link:
        manifest = (
            db.Table("Sessions")
            .get_item(Key={"session_id": link["projection_id"]}, ConsistentRead=True)
            .get("Item", {})
        )
        partition = manifest.get("active_partition", sid)
    trades = query_all(
        db.Table("Trades"),
        KeyConditionExpression=Key("session_id").eq(partition),
        ConsistentRead=True,
    )
    order_rows = query_all(
        db.Table("Orders"),
        KeyConditionExpression=Key("session_id").eq(partition),
        ConsistentRead=True,
    )
    orders = {}
    for order_row in order_rows:
        if "order_type" not in order_row:
            continue
        orders[
            (
                order_row.get("broker_exchange") or order_row.get("exchange") or "",
                str((order_row.get("broker_order_id") or order_row.get("kotak_order_id")) or order_row.get("order_id")),
            )
        ] = order_row
    executions = [
        dict(r["broker_execution"]) for r in order_rows if "broker_execution" in r
    ]
    if executions:
        # Trade projection has one fee per broker order. Allocate its variable
        # fees by value and its flat fee by quantity, matching Phase 19 FIFO.
        totals = defaultdict(lambda: [0, 0.0])
        for r in executions:
            totals[(r.get("exchange"), broker_report_id(r))][0] += int(r["quantity"])
            totals[(r.get("exchange"), broker_report_id(r))][1] += int(
                r["quantity"]
            ) * number(r["price"])
        trade_map = {
            (
                t.get("broker_exchange") or t.get("exchange") or "",
                str(broker_report_id(t)),
            ): t
            for t in trades
            if (t.get("broker_order_id") or t.get("kotak_order_id"))
        }
        if set(trade_map) != {
            (exchange or "", str(order_id)) for exchange, order_id in totals
        }:
            raise RuntimeError(
                "Execution membership changed during analytics read; retry"
            )
        for r in executions:
            t = trade_map.get((r.get("exchange") or "", str(broker_report_id(r))), {})
            q, v = totals[(r.get("exchange"), broker_report_id(r))]
            if (
                not t
                or int(t["quantity"]) != q
                or abs(number(t["price"]) * q - v) > 0.0001
            ):
                raise RuntimeError(
                    "Executions and order totals changed during analytics read; retry"
                )
            from app.services.trading import compute_commission
            from app.models.schemas import TradeSide

            flat = max(
                0.0,
                number(t.get("commission"))
                - compute_commission(TradeSide(r["side"]), v / q, q, 0),
            )
            r["commission"] = (number(t.get("commission")) - flat) * int(
                r["quantity"]
            ) * number(r["price"]) / v + flat * int(r["quantity"]) / q
            r["trade_id"] = t.get("trade_id", str(broker_report_id(r)))
            r["symbol"] = session["symbol"]
            r["broker_exchange"] = r.get("exchange")
            if not r.get("analytics"):
                order = orders.get(
                    (r.get("exchange") or "", str(broker_report_id(r))), {}
                )
                from app.services.execution_analytics import normalize_metadata
                meta = normalize_metadata(order.get("analytics") or t.get("analytics") or {})
                events = [
                    e
                    for e in meta.get("controller_history", [])
                    if int(e["timestamp"]) <= int(r["timestamp"])
                ]
                if meta.get("controller_history"):
                    # Do not attribute an earlier fill to a later controller.
                    meta["exit_method"] = "UNKNOWN"
                    if events:
                        meta.update(events[-1])
                from app.services.execution_analytics import filled

                r["analytics"] = filled(meta, number(r["price"]), int(r["quantity"]))
        rows = executions
    else:
        rows = []
        for t in trades:
            r = dict(t)
            order = orders.get(
                (
                    t.get("broker_exchange") or t.get("exchange") or "",
                    str((t.get("broker_order_id") or t.get("kotak_order_id")) or t.get("trade_id")),
                ),
                {},
            )
            r["analytics"] = t.get("analytics") or order.get("analytics")
            rows.append(r)
    if manifest is not None:
        current = (
            db.Table("Sessions")
            .get_item(Key={"session_id": link["projection_id"]}, ConsistentRead=True)
            .get("Item", {})
        )
        if current.get("revision") != manifest.get("revision"):
            raise RuntimeError("Broker revision changed during analytics read; retry")
    cycles = build_cycles(session, rows)
    if not include_labels:
        return cycles
    from app.services.trade_label_service import get_labels_for_session

    labels = get_labels_for_session(sid)
    # Never attach an index-based label to a different rebuilt cycle. Compare
    # entry/exit order memberships and quantities against the legacy view.
    from app.services.trade_label_service import legacy_round_trip_state

    completed, opened = legacy_round_trip_state(trades)

    def signature(entry_rows, exit_rows):
        return (
            tuple(
                sorted(
                    (str((r.get("broker_order_id") or r.get("kotak_order_id")) or r["trade_id"]), int(r["quantity"]))
                    for r in entry_rows
                )
            ),
            tuple(
                sorted(
                    (str((r.get("broker_order_id") or r.get("kotak_order_id")) or r["trade_id"]), int(r["quantity"]))
                    for r in exit_rows
                )
            ),
        )

    old_signatures = {}
    original_ids = {
        str(t["trade_id"]): str((t.get("broker_order_id") or t.get("kotak_order_id")) or t["trade_id"])
        for t in trades
    }
    for rt in completed + opened:
        es = [
            {**r, "trade_id": original_ids.get(str(r["trade_id"]), str(r["trade_id"]))}
            for r in rt["entry_trades"]
        ]
        xs = [
            {**r, "trade_id": original_ids.get(str(r["trade_id"]), str(r["trade_id"]))}
            for r in rt["exit_trades"]
        ]
        old_signatures.setdefault(signature(es, xs), []).append(rt["index"])
    for c in cycles:
        stable_label = next(
            (l for l in labels if l.get("analytics_cycle_id") == c["cycle_id"]), None
        )
        if stable_label is not None:
            c["label"] = stable_label
            c["label_index"] = int(stable_label["round_trip_index"])
            continue
        quantities = defaultdict(int)
        for r in c["executions"]:
            quantities[
                (r["role"], str((r.get("broker_order_id") or r.get("kotak_order_id")) or r.get("trade_id")))
            ] += int(r["quantity"])
        es = [
            dict(trade_id=k[1], quantity=q)
            for k, q in quantities.items()
            if k[0] == "entry"
        ]
        xs = [
            dict(trade_id=k[1], quantity=q)
            for k, q in quantities.items()
            if k[0] == "exit"
        ]
        indexes = old_signatures.get(signature(es, xs), [])
        if len(indexes) == 1:
            c["label_index"] = indexes[0]
            c["label"] = next(
                (l for l in labels if int(l["round_trip_index"]) == indexes[0]), None
            )
    return cycles


def load_cycles(user_id, **filters):
    from app.services.db import get_dynamodb_resource
    from boto3.dynamodb.conditions import Key

    if filters.get('include_shared'):
        from app.services.analysis_sharing import visible_sessions
        sessions = visible_sessions(user_id)
    else:
        sessions = query_all(
            get_dynamodb_resource().Table("Sessions"),
            IndexName="UserIdIndex",
            KeyConditionExpression=Key("user_id").eq(user_id),
        )
    result = []
    owners = set()
    for session in sessions:
        if (
            (session.get("user_id") != user_id and not session.get("shared"))
            or session.get("broker_projection_owner", session["session_id"])
            != session["session_id"]
        ):
            continue
        if ":archive:" in session["session_id"]:
            continue
        if any(
            filters.get(k)
            and session.get(k, "sim" if k == "session_type" else None) != filters[k]
            for k in ("symbol", "instrument_type", "session_type")
        ):
            continue
        date = session.get("date", "")
        if filters.get("start_date") and date < filters["start_date"]:
            continue
        if filters.get("end_date") and date > filters["end_date"]:
            continue
        owner = session.get("broker_projection_id") or session["session_id"]
        if owner in owners:
            continue
        owners.add(owner)
        for c in load_session_cycles(session):
            c.update(shared=session.get("shared",False),owner_email=session.get("owner_email"))
            if filters.get("client") and not any(
                e["client"] == filters["client"] for e in c["entries"]
            ):
                continue
            if filters.get("direction") and c["direction"] != filters["direction"]:
                continue
            if filters.get("entry_method") and not any(
                e["entry_method"] == filters["entry_method"] for e in c["entries"]
            ):
                continue
            if filters.get("exit_method") and not any(
                e["exit_method"] == filters["exit_method"] for e in c["exits"]
            ):
                continue
            if filters.get("sizing_method") and not any(
                e["sizing_method"] == filters["sizing_method"] for e in c["entries"]
            ):
                continue
            if filters.get("requested_pct") is not None and not any(
                e.get("requested_pct") is not None
                and abs(float(e["requested_pct"]) - float(filters["requested_pct"]))
                < 0.0001
                for e in c["entries"]
            ):
                continue
            if any(
                filters.get(k) and (c.get("label") or {}).get(k) != filters[k]
                for k in (
                    "entry_tag",
                    "exit_tag",
                    "expected_strategy",
                    "actual_strategy",
                )
            ):
                continue
            if filters.get("data_quality") == "known" and any(
                e["entry_method"] == "UNKNOWN" or e["sizing_method"] == "UNKNOWN"
                for e in c["entries"]
            ):
                continue
            if (
                filters.get("data_quality") == "executions"
                and c["chronology_quality"] != "executions"
            ):
                continue
            result.append(c)
    result = sorted(result, key=lambda c: (c["entry_time"], c["cycle_id"]))
    behavior_groups(result)
    return result


from collections import OrderedDict
import json
import threading

_report_cache = OrderedDict()
_cache_lock = threading.Lock()


def cached_report(cycles):
    key = hashlib.sha256(
        json.dumps(cycles, sort_keys=True, default=str).encode()
    ).hexdigest()
    with _cache_lock:
        value = _report_cache.get(key)
        if value is not None:
            _report_cache.move_to_end(key)
            return deepcopy(value)
    value = report(cycles)
    with _cache_lock:
        _report_cache[key] = deepcopy(value)
        while len(_report_cache) > 8:
            _report_cache.popitem(last=False)
    return value
