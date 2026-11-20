# Phase 27: Implementation plan (Deep Dive upgrades, Analysis upgrades, Lightweight drawings)

Approved 2026-11-20. Source of truth for sprint order; update the status column as sprints merge. Spec: `docs/spec-phase27.md` (the owner's draft, with the decisions and Built notes under each requirement).

## Context
- `docs/spec-phase27.md` asks for: grouped tag results, a Deep Dive comparison, an Analysis maximize, a score of a day (as system habits and in Stats) and improvement notes with carried-over TODOs.
- Found the same day: lines saved in KLine do not show in Lightweight charts in the website **Browse** section (see A). This is a gap of Phase 26's shared drawings and is fixed first.
- Branch rules (`CLAUDE.md`): each sprint is a branch off `origin/dev`, a PR into `dev`, merge commit, docs inside the PR. Anything that touches a real-trading screen or path stays on `dev` until the owner's real-session try (`Chart.tsx`, the guardrail snapshot at session create, the live popup Group view). The Phase 27 sprints stay in the Phase 27 docs.

## Decisions made with the owner (2026-11-20)
| # | Decision |
|---|---|
| D1 | Grouped tags: **two tags**, counted only on days where both are marked (unmarked days are listed as "not counted"). A **Group** tab beside All / Buy / Sell in Results, and in the live label popups. |
| D2 | Comparison: a **new Pattern Library tab "Compare"**. Each side picks its own strategy, a marked day and Underlying / CE / PE. Only strategies with marked days are offered. View only. |
| D3 | Analysis Maximize: **one Maximize on the day card for all four tabs** (Trades, Label Trades, Walkthrough, What If) covering the tab bar; Restore returns to the multi-day view. It replaces the three per-tab buttons. |
| D4 | Score rule 1: save the guardrail limit per session from now on and rebuild the open-position drawdown from cached candles when scoring (stored with a coverage flag). **Older sessions (no saved limit): a fixed 12%** (the owner's earlier setup; owner, 2026-11-20). One config value (`LEGACY_GUARDRAIL_LIMIT_PCT`), so scores of old days never move when the setting changes. |
| D5 | "Same direction" in rules 2 and 3 means **the same contract**. |
| D6 | The score is **0 to 100** per day, shown on the day card and as a trend in Stats > Behavior. Weights live in one config. |
| D7 | Notes: **one note per market date**, a new **Notes** tab on the day card. TODOs stay open until closed (Open, Working, Done / Improved); each change is kept with its date. |
| D8 | The drawings fix covers **all Lightweight charts** (Browse, Day, Swing, live). |

## A. Lightweight drawings: why KLine lines were not in Lightweight
### Cause
- The Browse Lightweight chart is `BrowseChart.tsx` -> `TradingChartHost` -> `Chart.tsx`. `Chart.tsx` saves drawings only in `localStorage` (Browse key `browse-drawings:<symbol>:<kind>:<strike>:<expiry>:<interval>`, so even per candle interval) and never reads the database. The Day and Swing Lightweight charts use `Chart.tsx` too.
- Phase 26's shared drawings wired only the Analysis, Patterns and Deep Dive Lightweight charts (`AnalysisCharts.tsx`, `ComparisonCharts.tsx`, through `useLightweightStore` and `LightweightDrawingController`). `Chart.tsx` was listed as "Not done".
- In KLine mode the same screens use `WebsiteKLineChart` -> `useKLineDrawings`, which saves to the database. So the lines are in the database; Lightweight Browse never asks for them. `Chart.tsx` also has no `AnalysisEnvironment`, so it has no `drawingRequest`.
### Check before the fix
1. Browse in Lightweight: the Network tab shows no `/api/desktop/v1/drawings?instrument=...` request.
2. The same contract in Analysis in Lightweight shows the KLine lines (the deployed shared path works).
3. If 2 fails: compare the `instrument` JSON the KLine chart wrote (`instrument_id` in the drawings table) with what Analysis requests. The backend matches the exact JSON (`canonical_instrument_id`), so a different `expiry` format, a string strike, NFO vs NSE or a Swing `drawing_scope` hides records.
4. Only Horizontal, Trend, Fib Retracement, Rectangle, Text, Buy / Sell marker and Risk Reward are drawn in Lightweight.
### Fix
- Give `Chart.tsx` the same persistence: it builds the drawings store (`{request, instrument, legacyBase}`) and attaches `LightweightDrawingController` / `LightweightChartTools` behind a prop, so a chart without a drawings service keeps today's code. Do not rewrite its tools; do not touch the candle update path.
- Reuse `frontend/src/components/analysis/lightweightDrawings.ts`, `lightweightPersist.ts`, `useLightweightStore.ts`, `frontend/src/services/desktopDrawingRequest.ts`, `shared/charts/drawingIdentity.ts`.
- The instrument identity must be built exactly as `WebsiteKLineChart.tsx` builds it (option, future, underlying; the Swing `drawing_scope` `swing:<prefix>:<workspace>`; NFO / BFO for swing). Extract it into one shared function used by both, with a parity test.
- Old browser-only drawings (`browse-drawings:*`, `swing-drawings:*`, the Day in-memory handoff) are copied up once; the local copy stays.
- Risk: `Chart.tsx` is the real-trading chart. Keep the diff to the drawing tools and the drawing load; dev only until tried in replay, paper, then real.

## B. Items
### B1. Grouped tag results
- `computeGroupStats(setups, tagA, tagB, side)` in `shared/deepdive/model.ts` (same rounding as `computeStats`). Over days where both tags are marked: both valid (AND true), A valid and B not valid, A not valid and B valid, both not valid, and the conditional P(B valid | A valid) and P(B valid | A not valid), each with n and a "few days" note under 5. Days with either tag unmarked are "not counted".
- Results: a **Group** button beside All / Buy / Sell, two tag pickers, a small table and the days of the chosen cell. No backend change (`dive.setups` already has `tag_values`).
- Live popups (`StatsPanel.tsx`): `stats/all` gains an optional compact per-day list per strategy, so the same function runs on the client. Additive, tolerant of absence, capped (for example the latest 400 days); the desktop read keeps its 2 second bound and falls back to `[]`.
### B2. Deep Dive Comparison
- A new top-level **Compare** tab (desktop `PatternLibrary.tsx` `view`, website `pages/PatternLibrary.tsx` mode), screen `shared/deepdive/ui/Compare.tsx` behind `DeepDiveHost`.
- Each pane loads its own dive (`getDive`), picks a marked day and side and a leg tab Underlying / CE / PE (the `MarkView` / `OptionPreview` pattern of `DateMarking.tsx`). Strikes from the day's saved strikes through `useDayStrikes` with `canEdit=false`; marks from `setup.annotations`; its own `ChartFrame` Maximize scope.
- The one shared-chart change: the candle interval is one environment setting (`DayIntervalBridge` pushes a day's saved interval), so two panes would fight. Add an optional per-pane `intervalMinutes` to `DiveChartProps`, honoured by `AnalysisChart.tsx` and `DeepDiveLightChart.tsx`; no bridge in Compare.
### B3. Analysis Maximize
- One `maximized` state in `GroupCard` (`shared/analysis/TradeAnalysis.tsx`). The card (header, tab bar, active tab, videos strip) moves into one fixed container (desktop `inset:42px 0 0` under the nav bar, z-index 2200; website `inset:0`); Esc or the button restores; the day list is not unmounted.
- Replaces the three `useMaximized` buttons (`useRoundTripView.ts`; `TradeLabeling`, `TradeWalkthrough`, `TradeWhatIf`). The Label Trades stacked / split chart layout while maximized is driven by the card state. The Trades tab fills the height. Hidden on the phone (those views are already full-screen overlays).
### B4. Score of a day
- `backend/app/services/day_score_service.py`, table `DayScores` (`user_id`, `date`: score, per-rule points, `guardrail_limit_pct`, `limit_source`, coverage flags, `computed_at`). `GET /api/analysis/day-score?date=`, computed once all the day's trades are labelled, cached, recomputed when labels or fills change. Built on `performance_service.load_session_cycles`.
- Rules (non-linear, weights in one config): (1) drawdown while a position was open touched 50% / 100% of the limit, rebuilt from cached candles with the day's cycles on one time axis; missing candles = "partial"; (2) repeat entry on the same contract within 2 to 3 bars (6 to 9 minutes), same strategy where labelled, giving consecutive losses; (3) adding to a loser where both entries lose; (4) closed-trade running P&L % never negative: large bonus; (5) one bad trade wipes the profit of the previous 3 or more trades.
- Limit per day: the session's saved limit, else the fixed 12% (`LEGACY_GUARDRAIL_LIMIT_PCT`); `limit_source` says which ("estimated" for the 12%).
- Guardrail snapshot: the session's `guardrail_ban_capital_pct` (and whether the ban was on) is written to the `Sessions` row at create, additively (`simulation._upsert_session_to_db`); `initialize_guardrails` on resume must not overwrite it. Real-trading path: dev only.
- System habits: rules 2, 3 and 5 become `sys:repeat_entry`, `sys:add_to_loser`, `sys:big_loss_wipes_gains` in `habit_ledger_service.trade_row` with synthetic questions flagged `system`, so the Habits scorecard, trends and compare work; the question manager must not archive them. Rules 1 and 4 are day-level.
- Shown: a score badge on the day card header, a **Day score** metric in the Stats > Behavior `DayPathBehavior` trend, the breakdown in the day's Notes tab. Read-only GETs on the three analysis allowlists (`backend/app/routers/desktop_analysis.py`, `windowsapp/src/analysisApi.ts`, `windowsapp/src-tauri/src/lib.rs`) with parity tests; desktop rebuild needed.
- Limits: rule 1 is exact only for days whose candles are cached; own intraday only (like the Habits ledger).
### B5. Improvement notes and TODOs
- Tables `DayNotes` (`user_id`, `date`: went well, to improve, specific points, context) and `DayTodos` (`user_id`, `todo_id`: text, created date, status Open / Working / Done / Improved, history of `{date, status}`); lazy `ensure_*`, `scripts/setup-dynamodb-tables.py`, `docs/architecture-backend.md`. Keyed by market date, so outside the session delete cascade. Updates are POST (the native command supports GET, POST and DELETE only); allowlists as above.
- A fifth **Notes** tab on `GroupCard` (shared code: website, webapp, Windows app, phone). Open TODOs from earlier days show at the top of the day's notes (Done / Working / Improved buttons and history) and as a banner in Label Trades; a review list shows TODOs closed per week and each TODO's history.

## Sprints
| Sprint | Scope | Real-trading touch | Status |
|---|---|---|---|
| S0 | Docs (this plan, the spec decisions, acceptance skeleton, CLAUDE.md row, todo, Phase 26 corrections) | no | done (2026-11-20, straight to `dev`) |
| S1 | A. Lightweight drawings on `Chart.tsx` (Browse, Day, Swing, live) | yes (dev only) | built, in PR (see "S1 as built") |
| S2 | B3. Analysis Maximize | no | built, in PR (see "S2 as built") |
| S3 | B1. Group tab in Results, then the live popup | popup: yes (dev only) | built, in PR (see "S3 as built") |
| S4 | B2. Compare tab | no | planned |
| S5 | B5. Notes and TODOs | no | planned |
| S6 | B4. Day score backend and the guardrail snapshot | snapshot: yes (dev only) | planned |
| S7 | B4. Score UI, system habits, Stats trend | no | planned |

Order: S1 first (a visible defect of the last release); S2 to S4 are independent UI work; S5 before S6 because the score breakdown sits in the Notes tab.

## Verification
- Backend: `cd backend && source ~/venvs/tradematangi/bin/activate && python -m pytest tests/ -v` (17 `test_auth.py` tests need DynamoDB Local).
- Desktop: `cd windowsapp && npm run build && npm test`; `cd windowsapp/src-tauri && cargo test`; rebuild the app for allowlist changes.
- Website: `cd frontend && node node_modules/typescript/bin/tsc --noEmit`; Playwright `npm run test:charts`; `bash scripts/build-frontend-with-webapp.sh` then `cd webapp && npm test`. Phone: `cd mobile && npm run typecheck && npm test`.
- By hand: `docs/phase27-manual-acceptance.md`.
- `bash scripts/check-preprod-synced.sh` before any promotion. Nothing from this phase that touches real-trading screens goes to `preprod` without the owner's real-session try.

## S1 as built (2026-11-20): Lightweight trading charts share the database drawings

- **Files:** new `frontend/src/components/chartDrawingInstrument.ts` (the one identity, used by `WebsiteKLineChart.tsx` and the store hook), `useChartDrawingStore.ts`; `TradingChartHost.tsx` passes `persistDrawings` and `drawingStore`; `Chart.tsx` attaches the shared controller when `persistDrawings` (its inline drawing code, `localStorage` save and loader are skipped; the candle update path is untouched); `analysis/LightweightChartTools.tsx` gains `useLightweightDrawing` (split out of `useLightweightTools`) and `LightweightDrawControls`; `lightweightDrawings.ts` / `lightweightPersist.ts`: `legacyScope` on the store and `isLegacyKeyOf` (interval-suffixed old keys).
- **Decisions:** Text and picking a single drawing come with the shared controller (the old inline tools had neither); a Swing chart writes unscoped records (shared with Day and with the KLine swing chart) and still reads its old private-scope records; the old browser-only drawings of every interval of Browse and Swing are copied up once; the Day chart's in-memory handoff is dropped (the database is the handoff). If the symbol's kind cannot be looked up the chart still draws, on the chart only, and shows a notice when a save fails.
- **Tests:** `node --test` (18 in `frontend/src/components`), `windowsapp/src/lightweightDrawingIdentity.test.ts` (3), website Playwright: the cross-renderer test replaced the old "Lightweight drawings stay in the browser" test (which asserted the opposite), the seven per-tool tests wait for the tool click guard, plus two Swing tests; the whole website suite (98) passes; `tsc --noEmit` clean for the website and the desktop app.
- **Not covered:** the webapp's own suite, and a real Browse, Day (replay, paper, real) and Swing session. By hand: `docs/phase27-manual-acceptance.md` section A.

## S2 as built (2026-11-20): one Maximize on the Analysis day card

- **Files:** `shared/analysis/TradeAnalysis.tsx` (`GroupCard` owns `maximized`, the Esc handler and the one button in the tab bar; the detail div becomes the full-window container and provides `CardMaximizeContext`), `shared/analysis/labeling/useRoundTripView.ts` (`CardMaximizeContext`, `useCardMaximized()`; `useMaximized` removed), `TradeLabeling.tsx`, `TradeWalkthrough.tsx`, `TradeWhatIf.tsx` (button removed, they read the card's state and pass it to the split layout), `labeling/RoundTripSplitLayout.tsx` (no own fixed wrapper: it fills the card), new `shared/analysis/maximize.css`, `kline/desktopAnalysis.css` (`.labels-maximized` no longer fixed).
- **Decisions:** the container is fixed at `inset: 0` on the website and webapp and `inset: 42px 0 0` on the Windows app (its navigation bar stays). Esc is a window handler that the KLine per-chart maximize overrides first (it already stops the event). The button keeps the labels "Maximize" and "Restore", so the older scripts that click them keep working. A tab opened without a card (phone overlays) has no button. The day list is not unmounted, so filters and scroll are kept on Restore.
- **Tests:** website Playwright `frontend/tests/phase22/analysis-maximize.spec.ts` (both renderers: one button, the card fills the window on every tab, Esc and Restore return); the whole website suite passes (100). `tsc` clean for the website, desktop and phone.
- **Not covered:** `scripts/desktop-analysis-workflows.mjs` and `scripts/website-label-trades-check.mjs` cannot run in this environment (they fail the same way on unchanged `dev`); the latter was updated to give the tab a stand-in card. The Windows app and the webapp's own suite were not run. By hand: section B of `docs/phase27-manual-acceptance.md`.

## S3 as built (2026-11-20): Group (two tags together)

- **Pure model:** `computeGroupStats(days, tagA, tagB, side)` in `shared/deepdive/model.ts` (types `GroupDay`, `GroupStats`, `GroupShare`, `GroupCell` in `types.ts`; `groupCellLabel`, `shareLine`). It takes any day with `date`, `side` and `tag_values`, so Results (full setups) and the popup (compact days) run the same arithmetic. One-decimal rounding is `roundTenth` (ties to even, like the server).
- **Screens:** new `shared/deepdive/ui/GroupView.tsx` (+ `groupView.css`): pickers, swap, own side switch, the conditional lines, the four-cell table, not-counted days; `compact` drops the day lists and the side switch. `Results.tsx` gets a **Group** button (the summary, tag bars and day table stay below it, unfiltered); `StatsPanel.tsx` gets a Group button when `entry.days` exists and the dive has two tags.
- **Backend:** `deep_dive_service.stats_all` entries gain `days` (`group_days`: `{date, side, tag_values}`, newest first, capped at `GROUP_DAYS_LIMIT = 400`). Additive: an older client ignores it, a newer client with an older server shows no Group button. The 20 second cache and the cache drop on every write are unchanged, and so is the desktop's 2 second bound; no route, allowlist, label payload or save path changed.
- **Tests:** `windowsapp/src/deepDive.test.ts` (8 hand-computed cases: cells, conditional rates, swap, side, rounding, empty), backend `test_deep_dive.py` (days payload, cap), website Playwright `deep-dive-group.spec.ts` (Results and the popup panel, older server). Backend deep dive / desktop trading subset 264 passed; desktop vitest 1834; `tsc` clean for the website, desktop and phone.
- **Not covered:** `scripts/website-live-deepdive-check.mjs` and `scripts/desktop-live-label-check.mjs` (they cannot run in this environment), a real popup in a replay, paper or real session. By hand: section C of `docs/phase27-manual-acceptance.md`.

