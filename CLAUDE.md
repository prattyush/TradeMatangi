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
| Phase X — GuardRails | ✅ Complete | 494 | `docs/spec-phase10.md` |

Full status, bugs fixed, and lessons learned for each phase are in the respective phase spec docs.

### Post-Phase IX features (merged to dev)

| Feature | PR | Status |
|---------|-----|--------|
| Kotak Neo live streaming + Admin Settings tab | #73 (feature/kotak-streaming-admin-tab) | ✅ merged to dev + main |
| Kotak Neo API corrections (scrip_master, token field, modify qty, isIndex) | #75 (fix/kotak-api-corrections) | ✅ merged to dev + main |
| Kotak Neo streaming bugs (wrong index segments, no reconnect on WS drop) | #88 (fix/kotak-streaming-bugs) | ✅ merged to dev + main |
| KiteBroadcaster race condition + Kotak WS auto-reconnect | #90 (fix/kite-broadcaster-race-condition-kotak-reconnect) | ✅ merged to dev + main |
| ST P&L label + P&L % display mode + wallet lock during session | #92 (feature/st-pnl-label-pct-mode-wallet-lock) | ✅ merged to dev + main |
| TargetProfit strategy + Breakeven overhaul + AggressiveStoploss 'only in profit' to Settings | #94 (feature/target-profit-breakeven-overhaul) | ✅ merged to dev + main |
| LTP button in price inputs + global button click animation | #96 (feature/ltp-button-click-animation) | ✅ merged to dev + main |
| Change Password in Settings General tab + remove admin credentials hint from login | #98 (feature/change-password-settings) | ✅ merged to dev + main |
| Drawing tools dropdown (H-Line, Trend, Fib Retracement, Parallel Channel) + LIFO Clear + free crosshair | #100 (feature/drawing-tools-fib-channel) | ✅ merged to dev + main |

### Post-Phase X fixes (merged to dev + main)

| Fix | PR | Status |
|-----|-----|--------|
| GuardRail BLOCK reason: human-readable expiry time ("resumes after 09:35") + separate cooldown block bars (n) setting | #102 (feature/guardrails-phase10) | ✅ merged to dev + main |
| Time picker scroll throttle: 1 step per 180ms, prevents runaway jumps on Start Time input | #104 (fix/time-picker-scroll-throttle) | ✅ merged to dev + main |
| Settings: move Change Password to new Profile tab; TargetProfit chart price-pick (⊕) button; data/ added to .gitignore | #107 (feature/profile-tab-settings) | ✅ merged to dev + main |
| Settings modal: fixed width 440px + tab font 11px so 5 tab labels don't crowd; tab content scrollable | #110 (fix/settings-modal-fixed-width) | ✅ merged to dev + main |
| TargetProfit/BreakEven: emit order_cancelled SSE event when strategy cancels stoploss so UI removes it | #111 (fix/targetprofit-stoploss-cancel-event) | ✅ merged to dev + main |
