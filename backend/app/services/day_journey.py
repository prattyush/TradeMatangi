"""Realized Day P&L paths and entry sizing observations; no market-data reads."""
from bisect import bisect_left
from collections import defaultdict
from hashlib import sha256
import math
from statistics import median


def finite(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def pct(value, capital):
    return 100 * value / capital if capital and capital > 0 else None


def journeys(cycles):
    groups = defaultdict(dict)
    for cycle in cycles:
        if cycle.get("trading_style", "intraday") != "intraday":
            continue
        scope = (cycle.get("user_id"), cycle.get("mode"), cycle.get("date"),
                 cycle.get("execution_broker"), cycle.get("broker_account_id"))
        groups[scope].setdefault(cycle["cycle_id"], cycle)
    result = []
    for scope, unique in sorted(groups.items(), key=lambda item: tuple(str(v or "") for v in item[0])):
        rows = list(unique.values())
        sessions = {}
        for c in rows:
            sessions.setdefault(c["session_id"], finite(c.get("starting_capital")))
        valid = all(v is not None and v > 0 for v in sessions.values())
        capital = sum(sessions.values()) / len(sessions) if sessions and valid else None
        closed = sorted((c for c in rows if c["state"] == "closed" and c.get("exit_time") is not None),
                        key=lambda c: (c["exit_time"], c["cycle_id"]))
        balance = peak = max_drawdown = 0.0
        downward = sum(max(0, -float(c["net_pnl"])) for c in closed)
        seconds = defaultdict(list)
        for c in closed:
            seconds[c["exit_time"]].append(c)
        batches = []
        for second, same_second in sorted(seconds.items()):
            precise = [finite(c.get("exit_sort_time")) for c in same_second]
            known = all(v is not None and int(v) // 1_000_000 == second for v in precise) and len(set(precise)) == len(precise)
            if len(same_second) == 1 or known:
                batches.extend([[c] for c in sorted(same_second, key=lambda c: c.get("exit_sort_time") or 0)])
            else:
                batches.append(sorted(same_second, key=lambda c: (c["session_id"], c["cycle_id"])))
        points = []
        for batch in batches:
            members = [dict(cycle_id=c["cycle_id"], session_id=c["session_id"],
                            label=" ".join(str(v) for v in (c.get("symbol"), c.get("right"), c.get("strike")) if v is not None),
                            delta=float(c["net_pnl"]), delta_pct=pct(float(c["net_pnl"]), capital)) for c in batch]
            delta = sum(m["delta"] for m in members)
            balance += delta
            peak = max(peak, balance)
            max_drawdown = max(max_drawdown, peak - balance)
            first = members[0]
            points.append(dict(time=batch[0]["exit_time"], cycle_id=first["cycle_id"], session_id=first["session_id"],
                               label=first["label"] if len(members) == 1 else f"{len(members)} same-second trades",
                               members=members, grouped=len(members)>1,
                               delta=delta, delta_pct=pct(delta, capital), pnl=balance, pnl_pct=pct(balance, capital),
                               drawdown=peak-balance))
        times = [p["time"] for p in points]
        sizing = {state: dict(entries=0, allocation=[], risk=[]) for state in ("down", "up", "flat", "unknown")}
        for c in rows:
            for entry in c.get("entries", []):
                stamp = entry.get("timestamp")
                index = bisect_left(times, stamp) if stamp is not None else 0
                ambiguous = stamp is None or (index < len(times) and times[index] == stamp)
                prior = points[index-1]["pnl"] if index else 0
                state = "unknown" if ambiguous else "down" if prior < -1e-8 else "up" if prior > 1e-8 else "flat"
                bucket = sizing[state]
                bucket["entries"] += 1
                meta = entry.get("analytics") or {}
                for kind, field in (("allocation", "effective_allocation_pct"), ("risk", "effective_risk_pct")):
                    value = finite(meta.get(field))
                    if value is not None and value >= 0:
                        bucket[kind].append(value)
        for bucket in sizing.values():
            for kind in ("allocation", "risk"):
                values = bucket.pop(kind)
                bucket[f"{kind}_count"] = len(values)
                bucket[f"median_{kind}_pct"] = median(values) if values else None
        ratios = {}
        for kind in ("allocation", "risk"):
            down, up = sizing["down"][f"median_{kind}_pct"], sizing["up"][f"median_{kind}_pct"]
            ratios[kind] = down / up if down is not None and up is not None and up > 0 else None
        result.append(dict(id=sha256(repr(scope).encode()).hexdigest()[:20], user_id=scope[0], mode=scope[1], date=scope[2],
                           execution_broker=scope[3], broker_account_id=scope[4], capital=capital,
                           sessions=len(sessions), completed=len(closed), open_cycles=sum(c["state"] != "closed" for c in rows),
                           net_pnl=balance, net_pnl_pct=pct(balance, capital), max_drawdown=max_drawdown,
                           max_drawdown_pct=pct(max_drawdown, capital), downward=downward, downward_pct=pct(downward, capital),
                           giveback=peak-balance, giveback_pct=pct(peak-balance, capital), points=points,
                           sizing=sizing, sizing_ratio=ratios))
    return sorted(result, key=lambda row: (row["date"], row["id"]))
