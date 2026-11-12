# Trade Matangi Project

## Branch Strategy (since 2026-11-02)

| Branch | Purpose |
|--------|---------|
| `main` | Real trading. Known-good; merged manually from `preprod` after local testing. |
| `preprod` | Staging for `main`. Same code as `main` plus tested real-trading fixes. **Real-trading bugs are fixed here.** |
| `dev` | New features (currently KLine chart + webapp), tested with simulated / replay / stepwise sessions only. Not yet trusted for real trading. |

Rules:
- Always raise a PR from a new feature branch. Bug fixes found in real trading target `preprod`; new features target `dev`.
- Every fix that lands on `preprod` must be synced into `dev` right away (branch off `origin/dev`, `git merge origin/preprod`, PR into `dev`) so `dev` contains all bug fixes plus the new features.
- **Merge PRs between these branches (preprod→dev, dev→preprod, preprod→main) with "Create a merge commit". Never squash or rebase them**, otherwise the histories diverge again and the same fixes conflict next time.
- `bash scripts/check-preprod-synced.sh` fails if `preprod` has commits `dev` lacks, and warns if merging `dev` into `preprod` would conflict. Run it after every merge into `preprod` and before any dev→preprod merge.
- Release flow: build on `dev` and test with simulated / replay / stepwise → merge `dev` into `preprod` and test with real trading → user merges `preprod` into `main`.
- A dev→preprod merge is conflict-free once `preprod` has been synced into `dev` (verified 2026-11-07). Before it, review what the promotion adds (`git diff origin/preprod origin/dev --stat`). For a hotfix that cannot wait for the whole of `dev`, port specific reviewed commits (`git cherry-pick -x`) and sync back into `dev` as above.
- Why: in Oct 2026 `dev` (with KLine/webapp edits to the lightweight chart path: `Chart.tsx`, `App.tsx`, `shared/charts/pendingOrderEdits.ts`) showed a chart that stopped updating and "awaiting broker confirmation" notices during real trading; `main` was unaffected. The chart-update problem was addressed on `dev` by #738 and confirmed on a real session by the user (2026-11-07); the user's multi-day real-trading test on `preprod` remains the gate before `main`.
- **History note (do not repeat):** `dev` was merged into `preprod` (#730) and then reverted (#747). Git treats a reverted merge as already merged, so a later dev→preprod merge would silently skip that work. `dev` repaired this with #748 (preprod merged into `dev`, then the revert reverted). Never revert a merge commit; fix forward, or revert the revert on `dev` first. Chain: aaacb5f (#730) → 2392bb0 (revert) → 2627ab4 (#747) → aff1f05 → 5da97ec (revert of the revert) → 3d80a1b (#748).
- **Promoting `dev` to `preprod`:** first sync `preprod` into `dev` (so `dev` has every real-trading fix), then promote a pinned snapshot branch (`release/dev-into-preprod-<date>`) rather than the moving `dev`, so feature work merged to `dev` meanwhile cannot join the release by accident.

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

### Phone app (Android, branch `feat/android-phone-app`)

```bash
cd mobile && npm install --no-bin-links
npm run dev                      # browser at http://127.0.0.1:5176 (use a 915x412 window)
npm run typecheck && npm test    # unit tests
npm run test:ui                  # landscape UI tests (Playwright, system Chrome)
bash scripts/build-android-phone.sh   # debug APK (needs JDK 21 and ~/Android/Sdk; see mobile/README.md)
```
Docs: `docs/architecture-phone.md`, `docs/spec-phase24-android-plan.md`. The phone app lives on one branch with one PR into `dev`.

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

| Phase XXIII — Label Trades one-by-one + Manual Behavioral Analysis | ✅ Complete on `dev` (Sprints 0–9 merged/under PR: one-at-a-time Label Trades, behavior questions + live and Analysis marks, Habits stats 7a–7d, hardening, Sprint 9 Stats "Run on" filter + Habits session axis (sessions created from 2026-10-01); manual acceptance on live sessions and the Windows build pending — `docs/phase23-manual-acceptance.md`; not yet merged to preprod, see `docs/spec-phase23.md` §11.5) | 2887 backend (the 3 baseline swing failures were test date dependence, fixed in #802) / 389 windowsapp vitest / 23 cargo | `docs/spec-phase23.md`, `docs/spec-phase23-implementation-plan.md` |
| Phase XXIV — Desktop Tools: Trading Video Maker | 🚧 On `dev`: Sprints 0–5 merged (recorder `.rec.json` also on `preprod`; the tool itself stays on `dev` until promoted); YouTube: Connect (#789), recording auto-stop (#790) and upload (#791, with a replay forming-bar fix) merged; saved links merged (#792; server table `VideoLinks`, videos shown in Analysis); Make Unlisted and Add a YouTube link merged (#794; embedded playback confirmed on website and desktop), plus saved videos before a recording (#797) and a compact Videos row (#798); the local player is optional and not started; GuardRails **Max per entry** (reduces an entry to a cap) and **Minimum gap between orders** added on `dev` (see `docs/spec-phase24.md`); 72 more symbols (Midcap 50, Auto, FMCG, IT, Bank, Metal, Oil & Gas constituents; #800) and volume in historical OHLC with a KLine `VOL` indicator (B1, #801) merged to `dev`, live/real-trading volume (B2) gated on a payload probe and not started; Android phone app (landscape, Capacitor, `mobile/`; branch `feat/android-phone-app`, one PR into `dev`): phase 1 built (sign-in, Sessions with Snapshots / Day journey / execution details / Compare, Label trades, Stats and Habits, Videos, Browse; Google sign-in and Positions are phase 2), phone acceptance in `docs/phone-manual-acceptance.md`; phone app merged to `dev` (#803) and accepted on a phone; **Trade Walkthrough** (merged, #808) and **What If** (merged, #809): new Analysis tabs on website, desktop, webapp and phone, all session types; What If is saved per day in the `WhatIfScenarios` table and compared across days, with price picking on KLine charts; the option-chart markers carry no text in both (and in Label trades on the phone); tried on the website and phone, the Windows app is still to be checked — `docs/spec-phase24-walkthrough-whatif-plan.md`; phone Browse has separate CE/PE strikes and a **Max price** (premium cap) strike pick (#811); market holidays can be added at run time with `/api/admin/holidays` and `DATA_DIR/holidays.json` (#810); phone Google sign-in with an optional app lock (#813, own native plugins; tried on a phone) and one fixed debug signing key so APKs install over each other (#812; `mobile/README.md`, `docs/phone-google-signin-setup.md`); Browse (phone and Windows app) reads minute candles instead of Breeze second-level data (#814; `minute_history.py`, `docs/live-history-providers.md`); Windows Analysis: one scroll bar in Walkthrough and What If, winning and losing days coloured (#817); **Browse: a year of history and the website's Browse** (#819 paged route `browse/history`, desktop and phone scroll back to a year; #820 website and webapp open on Browse, a symbol and a day per pane, saved per user; #822 Browse follows the Trading Chart setting, Lightweight or KLine; #823 Browse time axis and a day calendar that waits for a click; `docs/spec-phase24.md`, `docs/live-history-providers.md`, `docs/architecture-frontend.md`); **phone swing trading (S8; Swing tab: positions, orders, shares, options and futures, paper and real; real needs the App lock) is built on `feat/phone-swing` (PR #816), waiting for the user's try on a phone, paper first** (`docs/spec-phase24-phone-swing-plan.md`); two requirements (2026-11-12): the right-click order ticket gets a Qty / Capital % / Risk % switch is built and merged (#824), and a **Milestones** P&L Display Mode (Win/Loss thirds of Max Win and Max Loss) with a setting to hide the position P&L above the bar is built on `feat/pnl-milestones`, waiting for the user's try (`docs/spec-phase24.md`); manual acceptance on Windows and in the browser pending — `docs/phase24-manual-acceptance.md` | 494 windowsapp vitest / 71 cargo (+1 ignored) | `docs/spec-phase24.md`, `docs/spec-phase24-implementation-plan.md`, `docs/spec-phase24-youtube-plan.md`, `docs/spec-phase24-android-plan.md`, `docs/architecture-phone.md` |

Full status, bugs fixed, and lessons learned for each phase are in the respective phase spec docs.
