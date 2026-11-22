"""Writes windowsapp/src/whatIfGolden.json: what the backend computes for sample days, so the TypeScript What If model
(shared/analysis/whatif) is tested against the real FIFO matching and charge formula rather than against itself.

Run from the repository root with the backend virtualenv:  python scripts/generate-whatif-golden.py
Each case: the original fills (charges from compute_commission), the backend's cycles for them, a list of edits, and the
backend's cycles for the edited fills (charges recomputed). Edits keep entry and exit quantities matched, so FIFO and the
What If cash-flow P&L must agree.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.models.schemas import TradeSide  # noqa: E402
from app.services.performance_service import build_cycles  # noqa: E402
from app.services.trading import compute_commission  # noqa: E402

CAPITAL = 100000

CASES = [
    dict(name="options long, averaged, one exit: drop the second entry and exit the rest higher", brokerage=1.0, margin=1.0,
         fills=[("1", "BUY", 75, 120.0, 1000), ("2", "BUY", 75, 110.0, 1100), ("3", "SELL", 150, 125.0, 1600)],
         edits=[("2", 0, None), ("3", 75, 130.0)]),
    dict(name="options short: buy back at a different price", brokerage=1.0, margin=1.0,
         fills=[("1", "SELL", 40, 110.0, 1000), ("2", "BUY", 40, 100.0, 1500)],
         edits=[("2", 40, 105.5)]),
    dict(name="partial exits, second exit later", brokerage=1.0, margin=1.0,
         fills=[("1", "BUY", 100, 50.0, 1000), ("2", "SELL", 40, 55.0, 1200), ("3", "SELL", 60, 52.0, 1400)],
         edits=[("3", 60, 60.0)]),
    dict(name="equity intraday margin 0.2", brokerage=1.0, margin=0.2,
         fills=[("1", "BUY", 100, 2000.0, 1000), ("2", "SELL", 100, 2010.0, 1300)],
         edits=[("1", 100, 1995.0), ("2", 100, 2020.0)]),
    dict(name="higher brokerage, double quantity", brokerage=20.0, margin=1.0,
         fills=[("1", "BUY", 65, 80.0, 1000), ("2", "SELL", 65, 70.0, 1800)],
         edits=[("1", 130, 80.0), ("2", 130, 70.0)]),
    dict(name="no edits", brokerage=1.0, margin=1.0,
         fills=[("1", "BUY", 75, 120.0, 1000), ("2", "SELL", 75, 125.0, 1500)], edits=[]),
]


def fills_for(case, edits=None):
    by_id = {e[0]: e for e in (edits or [])}
    rows = []
    for ident, side, quantity, price, when in case["fills"]:
        if ident in by_id:
            _, quantity, new_price = by_id[ident]
            price = new_price if new_price is not None else price
            if quantity == 0:
                continue
        fee = compute_commission(TradeSide.BUY if side == "BUY" else TradeSide.SELL, price, quantity, case["brokerage"])
        rows.append(dict(trade_id=ident, side=side, quantity=quantity, price=price, timestamp=when, commission=fee,
                         analytics=dict(capital=CAPITAL, margin_rate=case["margin"])))
    return rows


def session():
    return dict(session_id="golden", user_id="u", symbol="TEST", date="2026-11-09", session_capital=CAPITAL, session_type="sim")


def cycle_out(cycle):
    return dict(
        net_pnl=round(cycle["net_pnl"], 6), fees=round(cycle["fees"], 6), pnl_pct=round(cycle["pnl_pct"], 6),
        peak_capital_pct=round(cycle["peak_capital_pct"], 6), state=cycle["state"], capital=cycle["capital"],
        executions=[dict(trade_id=e["trade_id"], role=e["role"], side=e["side"], quantity=e["quantity"], price=e["price"],
                         timestamp=e["timestamp"], commission=round(e["commission"], 6)) for e in cycle["executions"]],
    )


def main():
    out = []
    for case in CASES:
        original = build_cycles(session(), fills_for(case))
        edited = build_cycles(session(), fills_for(case, case["edits"]))
        assert len(original) == 1 and len(edited) <= 1, case["name"]
        out.append(dict(
            name=case["name"], brokerage=case["brokerage"], margin=case["margin"], capital=CAPITAL,
            edits=[dict(id=i, quantity=q, price=p) for i, q, p in case["edits"]],
            original=cycle_out(original[0]),
            edited=cycle_out(edited[0]) if edited else None,
        ))
    target = ROOT / "windowsapp" / "src" / "whatIfGolden.json"
    target.write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {target} ({len(out)} cases)")


main()
