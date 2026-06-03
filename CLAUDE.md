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
| Phase XI — AI Helper | 🔨 In Progress (Steps 1–19 done, ExitEntryTemplates PR #160 + CrossSymbolMonitoring PR #162 + BAN min-trades PR #163 merged; OtherFeatures items 1, 2, 4 pending) | 531 backend / 228 aihelper | `docs/spec-phase11.md`, `docs/architecture-aihelper.md` |

Full status, bugs fixed, and lessons learned for each phase are in the respective phase spec docs.
