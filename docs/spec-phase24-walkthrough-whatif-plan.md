# Phase 24 — Trade Walkthrough and What If — sprint plan

Requirements: `docs/spec-phase24.md` ("TRADE WALKTHROUGH", "WHAT IF", with the decisions recorded under each). Branches: `feat/trade-walkthrough` (pull request 1) then `feat/what-if` (pull request 2), each off `dev`, merged with a merge commit. Every sprint updates this file, the acceptance checklist (`docs/walkthrough-whatif-manual-acceptance.md`) and the tests in the same commit.

## Scope and decisions (2026-11-10)
- Hosts: website (Lightweight and KLine renderers), desktop, webapp, phone app. Session types: real, paper, replay (sim), stepwise. Intraday only (as Label Trades).
- One shared implementation in `shared/analysis/` reaches website, desktop and webapp through the single `GroupCard` tab bar in `shared/analysis/TradeAnalysis.tsx`; the phone app has its own layout (menu entries in `mobile/src/screens/sessions/SessionDetail.tsx`).
- Walkthrough is read-only and walks the trades by **first entry time** (overlapping trades in the order they opened); the day's P&L before and after counts realised trades in the order they closed, so with overlapping trades one trade's "before" can differ from the previous trade's "after" (the panel says so). What If never sends an order and changes nothing but its own saved scenarios.
- What If: edit existing legs only (quantity 0 removes one); chart click-to-pick and hypothetical markers on KLine only; saved **per day**, named, several per day, compared across days.
- P&L in What If is cash flow (sells minus buys minus charges, by direction) with a visible warning when entry and exit quantities do not match. Real-session charges are an estimate.

## Status
| Sprint | Scope | Status |
|---|---|---|
| W0 | Docs: spec decisions, this plan, acceptance checklist, phase 2 TODO, `CLAUDE.md` row | Done (this commit) |
| W1 | Shared pieces taken out of `TradeLabeling` without touching its saving code: `useRoundTripView` (marker text, focus time, chart trades), `useMaximized`, `RoundTripSplitLayout` (charts left, panel right, desktop/maximized wrappers); `OneByOneLabeling` gains an optional `status` override; TS cycle type gains `peak_capital_pct`, `label_index`, `holding_seconds` | Done: windowsapp 502, webapp 23, phone labeling and sessions UI 50 all pass unchanged |
| W2 | Pure model: `shared/analysis/walkthrough/walkthroughModel.ts`, `exitMethods.ts`, before/after P&L from `sessionJourney`; cycle join by `cycle_id`; graceful fallback for older servers | Done: 15 model tests (windowsapp 517) |
| W3 | Shared `WalkthroughPanel` + `TradeWalkthrough` and the `Walkthrough` tab in `GroupCard` (website, desktop, webapp) | Done: webapp Playwright 26 (3 new); desktop gets it from the same `GroupCard`; not yet seen in the Windows app |
| W4 | Phone Walkthrough overlay (`Walkthrough` in the view menu, reusing Label trades' landscape layout and chart; P&L figures and facts first, entry and exit rows with colour-coded codes, ▸ more info) | Done: 11 landscape UI tests (4 sizes); phone suite 152 pass; APK to be tried on a phone |
| F0 | Backend `WhatIfScenarios` table with the `UserIdDateIndex` GSI, `whatif_service.py`, `routers/whatif.py` (`/api/whatif`, `/api/whatif/range`), session cleanup, backup list, setup script; transport allowlists (Python `desktop_analysis`, TypeScript `validAnalysisPath`, Rust `valid_analysis_path`); optional `whatIf` source on `AnalysisEnvironment` wired in website, desktop and phone | Done: 40 backend tests (`test_whatif.py`), Rust and TypeScript allowlist tests |
| F1 | Pure model `shared/analysis/whatif/`: `fees.ts` (formula port + brokerage inference), `whatIfModel.ts` (fills as the editable legs, cash-flow P&L, capital %, peak capital, day result, warnings, saved-edit conversion); golden tests against the backend's FIFO and charges (`scripts/generate-whatif-golden.py` -> `windowsapp/src/whatIfGolden.json`) | Done: 34 tests (windowsapp 554) |
| F2 | KLine analysis chart: `pickMode` / `onPick` / `onPickCancel` (click or tap reports time and price, Escape cancels) and the `analysisWhatIf` overlay (hollow rings for the edited legs, drawn only on the chart that matches the contract); passed through `AnalysisPanels`, `LabelChartPanes`, the phone chart and `RoundTripSplitLayout` (`chartExtras`) | Done, covered by the website KLine test |
| F3 | Shared `TradeWhatIf` + `WhatIfPanel` + `CompareDays`; scenario bar (choose, name, Save, Revert day, Delete, Compare days); the `What If` tab in `GroupCard` (website, desktop, webapp); the latest saved what-if opens by itself so a refresh loses nothing; dirty guard when leaving the tab | Done: webapp Playwright 37 (11 new); windowsapp 554; phone suite 153 |
| F4 | Phone What If overlay | Not started |
| F5 | Session-type matrix, hardening, docs, pull request | Not started |

## Data and formulas (verified in the code, 2026-11-10)
- **Round trip = `PerformanceCycle`** (`backend/app/services/performance_service.py:build_cycles`, delivered as `SessionDetail.cycles`): `entries[]` (time, quantity, average price, `analytics.effective_allocation_pct`, `effective_risk_pct`, `sizing_method`, `requested_pct`), `exits[]` (`exit_method`, quantity, price, time), `matches[]`, `executions[].commission`, `peak_capital_pct`, `label_index`, `fee_source`. `getRoundTrips` is thinner; join to cycles by `cycle_id`.
- **Exit methods:** STOPLOSS, LIMIT, TARGET (orders); TargetProfit, UnderlyingTargetProfit, AggressiveStoploss, UnderlyingStoploss, BreakEven, LockProfit (strategies); MARKET, SESSION_CLOSE, EOD_CLOSE, UNKNOWN. Real sessions take the method from the stored controller history at the fill time.
- **P&L story:** `shared/analysis/dayJourney.ts` `sessionJourney(cycles, capitals)`: closed cycles by exit time, same-second exits batched, running balance net of charges. Before = the previous point's cumulative P&L; after = the trade's point. Realised only; overlapping trades are not modelled by the journey, so the panel says so.
- **Known drift, not changed here:** the older TypeScript copies of the charge formula (`frontend/src/services/positionAccounting.ts`, `windowsapp/src/paperTradingState.ts`, used for the trading screens' projected P&L) use 0.03563 and omit SEBI. What If uses the exact formula in `shared/analysis/whatif/fees.ts`; fixing the trading-screen copies is a separate, real-trading-screen change.
- **Charges** (`backend/app/services/trading.py:compute_commission`): brokerage + 0.03553% exchange + 0.0001% SEBI + 18% GST on those + stamp 0.003% on buys / STT 0.15% on sells, per order, `brokerage_per_order` per session (default 1.0). The TypeScript copies in `frontend/src/services/positionAccounting.ts` and `windowsapp/src/paperTradingState.ts` use 0.03563 and omit SEBI; the new shared `fees.ts` replaces them.
- **Capital:** `effective_allocation_pct = 100 * price * quantity * margin_rate / capital` (margin 0.20 for equity MIS, 1.0 for options, futures and swing); `peak_capital_pct` is the peak over fills of the open lots' value over capital; `pnl_pct = 100 * net / capital`.
- **Brokerage is not stored with the session** (only the live session object holds `brokerage_per_order`), so What If does not need a backend field: it infers the flat per-order brokerage from the charges recorded on the day's own fills (the formula is exactly invertible for paper, replay and stepwise) and falls back to 1.0.
- **Real sessions:** charges may be "allocated actual" (a day total split across orders); What If shows an estimate and says so.

## Saved what-ifs (F0)
`WhatIfScenarios`: PK `session_id`, SK `scenario_id` (slug of the name). Attributes `user_id`, `date`, `symbol`, `name`, `edits` (round trip, leg id, role, price, quantity), `summary` (actual, what-if, delta, delta %, trades edited, warnings), `version`, `updated_at`. GSI `UserIdDateIndex` (user, date) for the Compare days range query. Routes `/api/whatif`: day list, range summaries, upsert, delete. Owner only (not for shared history). Removed with the session (`session_cleanup_service`). Desktop and phone reach it through the analysis allowlists in three places (`desktop_analysis.py`, `windowsapp/src/analysisApi.ts`, `windowsapp/src-tauri/src/lib.rs`); the phone shares the TypeScript one.

## Risks and mitigations
- Refactoring `TradeLabeling` (shared by every host, and by real-trading days' labeling): no behaviour change, protected by the existing windowsapp, webapp and phone labeling tests; done in its own sprint.
- Fee drift between TypeScript and Python: one shared TypeScript formula, golden tests against `build_cycles` output.
- Real-session charges: labelled estimates.
- Overlapping trades and edits that cross other trades: allowed (playground); the day result is computed per trade, and the panel states the assumption.
- Website Lightweight charts get no click-to-pick: typed values work, with a note.
- Larger payload for Analysis (peak capital, label index): fields already serialized by the server; additive.

## Phone app phase 2 (TODO, next after Walkthrough and What If)
- **S2** Google sign-in (native Credential Manager with the existing Web client ID) with optional app lock; needs an Android OAuth client in Google Cloud for package `in.co.tradematangi.phone` and the SHA-1 of the debug (later release) key, plus test users.
- **S8** Read-only Positions for swing and day (decide between the existing positions endpoints and a passive read endpoint).
- Then alerts and swing actions. Details: `docs/spec-phase24-android-plan.md`.
