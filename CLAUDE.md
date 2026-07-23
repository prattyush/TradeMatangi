# Trade Matangi Project

All development should be done in dev branch and finally merging to main branch will be done manually. When raising a PR please create a new branch and when it is reviewed merge to dev.

@docs/spec.md

## Development Environment

### Running the stack locally (WSL)

```bash
# Terminal 1 — backend at http://localhost:8700
bash scripts/start-backend.sh

# Terminal 2 — frontend at http://localhost:5173
bash scripts/start-frontend.sh
```

### Running backend tests

```bash
cd backend
source ~/venvs/tradematangi/bin/activate
python -m pytest tests/ -v
```

### TypeScript check

```bash
cd frontend
node node_modules/typescript/bin/tsc --noEmit
```

## Key Technical Constraints

Look into backend technical constraints doc when needed which is located at docs/backend-technical-constraints.md

Look into frontend technical constraints doc when needed which is located at docs/frontend-technical-constraints.md


<!-- Shared invariants that span both sides — keep these here so they're always visible -->
- **IST timestamps**: data files (pickle and parquet) have tz-naive IST DatetimeIndex. The backend uses `df.index.tz_localize("UTC")` (NOT `tz_localize("Asia/Kolkata").tz_convert("UTC")`). This makes Unix timestamps encode IST wall-clock values so Lightweight Charts shows 09:15, not 03:45. Do not change this without updating all timestamp comparisons in `data_loader.py` and the frontend `CANDLE_INTERVAL_SECONDS` window math.
- **3-min candle boundaries**: both backend (`pandas resample("3min")`) and frontend (`Math.floor(time / 180) * 180`) must use the same epoch-aligned formula. These are intentionally kept in sync.

## Phase Completion Summary

| Phase | Status | Tests | Details |
|-------|--------|-------|---------|
| Phase III — BetaStage | ✅ Complete | 241 | `docs/spec-phase3.md` |
| Phase IV — BetaMinorUpdates | ✅ Complete | 278 | `docs/spec-phase4.md` |
| Phase V — TradeAnalysis | ✅ Complete | 299 | `docs/spec-phase5.md` |
| Phase VI — Strategies | ✅ Complete | 311 | `docs/spec-phase6.md` |
| Phase VII — PaperTrading | ✅ Complete | 350 | `docs/spec-phase7.md` |
| Phase VIII — Launch | ✅ Complete | 391 | `docs/spec-phase8.md` |
| Phase IX — RealTrading | ✅ Complete | 436 | `docs/spec-phase9.md` |
| Phase X — GuardRails | ✅ Complete | 495 | `docs/spec-phase10.md` |
| Phase XI — AI Helper | ✅ Complete (ExperimentalFeature PR #171 merged to dev) | 577 backend / 285 aihelper | `docs/spec-phase11.md`, `docs/architecture-aihelper.md`, `docs/architecture-backend.md`, `docs/architecture-frontend.md` |
| Phase XII — Trade Practice Tools | ✅ Complete (Stepwise Replayer + Pattern Library + LargeOrders + AIHelper Multi-SL + session resume PR #179 + stepwise add-CE/PE fix PR #181 + AI analysis no-session PR #183 + AI analysis drill-down + panel resize/font PR #185 + AI analysis date+time PR #187 + AI analysis date range fix + Trade Analysis chart enhancements PR #190 + CE/PE marker colors + stale marker fix + marker size PR #192 + EMA 9/21 on CE/PE charts + marker size 0.6 PR #195 + chart height ratio 0.6 PR #197 + Underlying chart CE/PE marker filter PR #199 + Recording Sprint 5 + CE/PE markers on underlying in live trading PR #204 + underlying marker order-fill stamp fix PR #206 + underlying marker preserve-price fix PR #208 + position size display beside avg entry PR #210 + position size tied to fundsRatioMode PR #215 + session resume trade history fix PR #214 + ATM price uses session start time PR #217 + options strike persistence on resume PR #219 + stoploss bulk update fix + P&L chart label PR #221) | 635 backend / 305 aihelper | `docs/spec-phase12.md` |
| Phase XIII — Enhancements | ✅ Complete (Fyers live streaming PR #279 + Chart Structures PRs #282,#284,#286,#288,#290 + Vite HMR disable PR #292 + Advanced Analysis — Trade Labelling + Stats PR #296 + Stepwise session_type persist PR #298 + GuardRails-MaxSize PRs #303,#306 + Top Pattern PRs #309,#311 + Pattern filter fix PR #313 + Structures nav/height + Underlying filter PR #315 + Buy/Sell markers PR #319 + Stepwise labeling + Snapshot fix PR #326) | 627 backend / 305 aihelper | `docs/spec-phase13.md`, `docs/spec-phase13-implementation-plan.md` |

Full status, bugs fixed, and lessons learned for each phase are in the respective phase spec docs.
