import sys
import json
from app.services.performance_service import build_cycles, report
from app.services.execution_analytics import snapshot
from types import SimpleNamespace

cycles = []
for i, mode in enumerate(["paper", "real", "sim", "stepwise"]):
    s = dict(
        session_id=f"demo-{i}",
        user_id="demo",
        symbol="NIFTY",
        date="2026-10-06",
        session_type=mode,
        instrument_type="options",
        session_capital=100000,
    )
    o = SimpleNamespace(
        session_capital=100000,
        session_type=mode,
        strategy_interval_secs=180,
        desktop_origin="desktop_paper" if i % 2 else None,
    )
    meta = snapshot(
        o,
        quantity=65,
        price=100,
        side="BUY",
        risk_fraction=0.02,
        stop=80,
        entry_method="AUTOSTOP" if i % 2 else "MARKET",
    )
    rows = [
        dict(
            trade_id="1",
            timestamp=1791280800 + i * 600,
            side="BUY",
            quantity=65,
            price=100,
            commission=10,
            analytics=meta,
        ),
        dict(
            trade_id="2",
            timestamp=1791281040 + i * 600,
            side="SELL",
            quantity=65,
            price=120 if i % 2 else 90,
            commission=12,
            analytics={
                **meta,
                "exit_method": "TargetProfit" if i % 2 else "STOPLOSS",
                "requested_size": "half",
            },
        ),
    ]
    cycles.extend(build_cycles(s, rows))
r = report(cycles)
with open(
    sys.argv[1] if len(sys.argv) > 1 else "/tmp/tradematangi-phase20-ui-data.json", "w"
) as f:
    json.dump(dict(report=r, cycles=cycles), f)
