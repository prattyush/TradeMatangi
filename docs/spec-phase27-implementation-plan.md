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
| S4 | B2. Compare tab | no | built, in PR (see "S4 as built") |
| S5 | B5. Notes and TODOs | no | built, in PR (see "S5 as built") |
| S6 | B4. Day score backend and the guardrail snapshot | snapshot: yes (dev only) | planned |
| S7 | B4. Score UI, system habits, Stats trend | no | built, in PR (see "S7 as built") |

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

## S4 as built (2026-11-20): Compare tab

- **Screens:** new `shared/deepdive/ui/Compare.tsx` (`Compare({ host })`, the panes, per-pane Maximize through the existing `ChartFrame`), `compareModel.ts` (pure: comparable dives, days newest first, legs, labels), `useViewStrikes.ts` (saved strikes, else the Mark days preview pick; never saves), CSS in `deepdive.css`. Hosts: desktop `tools/PatternLibrary.tsx` (a **Compare** tab on the same `deepDiveHost`), website `pages/PatternLibrary.tsx` (a `compare` mode) with `WebsiteCompare` in `components/deepdive/WebsiteDeepDive.tsx` (same renderer choice, KLine or Lightweight, as Deep dive).
- **Decision, changed from the plan:** the plan added an optional `intervalMinutes` prop to `DiveChartProps`, honoured by both chart components. Every Analysis chart already reads the interval from the environment, so instead a new `AnalysisIntervalScope` (`shared/analysis/environment.tsx`) gives a pane its own interval state (starting at the day's saved interval): no chart code changed, KLine and Lightweight both follow. `DayIntervalBridge` is not mounted in Compare, so nothing is saved.
- **No backend, allowlist or Rust change:** Compare reads `deep-dive/dives` and `deep-dive/dive`, which the Deep dive already uses on both transports.
- **Tests:** `windowsapp/src/deepDive.test.ts` (4 model tests), website Playwright `deep-dive-compare.spec.ts` (stub host: days, legs, saved or preview strikes, per-pane interval, Maximize, no writes, empty state; and the real Lightweight and KLine charts through the Pattern Library page). Website suite 106 passed, desktop vitest 1838, `tsc` clean for the website, desktop and phone.
- **Not covered:** `scripts/desktop-deepdive-check.mjs` (cannot run here), the Windows app and the webapp's own suite. By hand: section D of `docs/phase27-manual-acceptance.md`.

## S5 as built (2026-11-20): Notes and TODOs

- **Backend:** `day_notes_service.py` (tables `DayNotes` PK `user_id` SK `date`; `DayTodos` PK `user_id` SK `todo_id`; lazy `_ensure`), `routers/day_notes.py`, registered in `main.py`; also in `scripts/setup-dynamodb-tables.py`. Owner only; not part of the session delete cascade. Routes and the carry-over rule: `docs/architecture-backend.md` "Day notes and TODOs".
- **Decision, changed from the plan:** the plan had `POST /api/day-notes/todos/{id}/status`. The routes are exact paths with the id in the body or query (`.../todos/status`, `DELETE .../todos?todo_id=`), so the Rust and TS allowlists stay exact-match like What If's and need no path-parameter rule.
- **Decision:** a TODO's status is stored as history entries `{date, status, at}` (one per market date). The day view uses the status on that date, so an older day shows a TODO as it stood then and the "improving or not" review is possible. The review (weekly table, totals) is computed on the client from the full list (`weeklyReview`).
- **Allowlists** (backend `desktop_analysis.py`, `analysisApi.ts`, `lib.rs`) with tests in all three; desktop rebuild needed.
- **Screens:** `shared/analysis/notes/*`, the Notes tab in `GroupCard`, `OpenTodosBanner` in `TradeLabeling`; hosts: website `analysisEnvironment.tsx` and desktop `DesktopAnalysis.tsx` provide the `dayNotes` source. **Phone: no Notes tab** (not built; its Label trades, Walkthrough and What If are overlays without a day card). Left for a later step if wanted.
- **Tests:** backend `test_day_notes.py` (18); `windowsapp/src/dayNotes.test.ts` (6) and the allowlist tests (TS and Rust `day_notes_allow_the_exact_paths_with_post_for_every_write`); website Playwright `analysis-notes.spec.ts` (both renderers). Website 108 passed, desktop vitest 1844, phone 121, cargo 78, backend desktop / day notes / what-if / behavior subset 486; `tsc` clean for website, desktop and phone.
- **Not covered:** the Windows app and the webapp's own suite; real DynamoDB (the tests use moto). By hand: section E of `docs/phase27-manual-acceptance.md`.

## S6 as built (2026-11-21): day score backend and the guardrail snapshot

- **Score service:** `backend/app/services/day_score_service.py`: `CONFIG` (every number), the rules as pure functions over the cycles (`repeat_entry_events`, `add_to_loser_events`, `clean_day`, `big_loss_events`, `system_flags` for S7's `sys:*` habits), `worst_total` (rule 1), `score_day`, `compute_day`, `get_day_score` (stored in `DayScores`, recomputed when the fingerprint of trades, labels, limits and `CONFIG` changes), `list_scores`, `scores_in_range`. Routes `routers/day_score.py` (`/api/analysis/day-score`, `/day-scores`), owner only; on the desktop allowlists (backend, TS, Rust) with tests; table `DayScores` also in `scripts/setup-dynamodb-tables.py`.
- **Rule 1 method:** the cached candles come from `excursion_service.load_contract_frame` (extracted from `enrich_cycle`, same logic, no behaviour change). Each contract's observed bars are reduced to one-minute lows and highs; a long lot is marked at the low and a short lot at the high, prices carried forward, realised P&L of closed matches added, all on one minute grid across the day's cycles. The closed trades alone give a lower bound with no candles (`partial`).
- **Decisions:** the day's capital is the largest session capital of the date; two sessions use the strictest saved limit (`estimated` when any session has none); the limit applies whether or not the ban guardrail was switched on (the owner asked for the ban value); only labelled days are scored (`pending_labels` until every closed trade has a label); Strategy Practice and swing sessions are left out; the route stores the first computed score.
- **Guardrail snapshot (real-trading path):** `SimulationSession.guardrail_limit_snapshot` `{ban_capital_pct, ban_enabled}`, set once in `create_session` before the first write (`guardrail_service.guardrail_limit_snapshot`, never raises), written by `_upsert_session_to_db` only when present, read back by `rebuild_session_from_db` (`limit_snapshot_from_record`) so a resume keeps writing the old value although `initialize_guardrails` re-reads today's setting. A session without one writes nothing new. No order, fill, guardrail check or wallet code changed.
- **Tests:** backend `test_day_score.py` (39: each rule by hand, drawdown from synthetic candles and its steps, limits, statuses, storing and recomputing, the range, the routes, the snapshot written, read back and kept); TS and Rust allowlist tests. Full backend suite, the desktop vitest and cargo suites were run (see the PR).
- **Not covered:** a real Day (replay, paper, real) session creating and resuming with the snapshot, and real cached candles (the tests use synthetic ones); real DynamoDB (moto only). By hand: section F of `docs/phase27-manual-acceptance.md`. The score has no screen yet (S7).

## S7 as built (2026-11-21): score screens, system habits, Stats trend

- **Shared screens** `shared/analysis/dayScore/`: `types.ts`, `source.ts` (`createDayScoreSource(request)` over the same request as the notes: `day-score`, `day-scores`), `model.ts` (bands, wording, trend helper), `useDayScore.ts` (reads a date, again when `refresh` changes), `DayScoreBadge.tsx`, `DayScoreBreakdown.tsx`, `dayScore.css`. `environment.dayScore` is the optional source; hosts: website `analysisEnvironment.tsx` (**the website request prefixes `analysis/`: the routes are `/api/analysis/day-score`, unlike the notes at `/api/day-notes`; the desktop's transport adds its own prefix**) and desktop `DesktopAnalysis.tsx`.
- **Day card:** `GroupCard` shows `DayScoreBadge`: the stored score from the list (`TradeAnalysis` reads `day-scores` once per search, no compute) until the open card has read the full score (`useDayScore`, re-read on a tab change or data revision); `DayNotes` shows `DayScoreBreakdown` first. Not for swing or shared days.
- **System habits:** `day_score_service.SYSTEM_QUESTIONS` (kind `system`, `system: true`) are appended to the ledger's questions by `habit_ledger_service.build_ledger`, and each closed trade's `habits` gets its `sys:*` ids from `day_score_service.system_flags` computed per market date over the cycles in scope. The ledger response model (`routers/behavior.py` `LedgerQuestion`) allows kind `system`. The Habits screens: `HabitKind`, `LedgerQuestion`, `kindLabel` in `habits/types.ts`; a **System** type filter in `HabitsView`; the labels in the scorecard, deep dive and compare. The question manager reads the user's own questions only, so a system habit can never be archived or edited there. `system_flags` never raises on a malformed cycle (that rule gives no flags, logged).
- **Stats trend:** `DayPathBehavior` gets the **Day score (0 to 100)** metric when the host has a score source: it calls `day-scores?compute=true` over the paths' date range up to four rounds (31 new days each), plots the scored days, gaps for the rest, a fixed 0 to 100 axis.
- **Decision:** the table of day paths has no score column (the trend and the chip carry it). A score for a collapsed card comes only from storage: a day that was never opened shows no chip until it is scored by an open card or the trend.
- **Not built:** the phone has no day card, so no chip or breakdown there (it does get the System habits in Habits); OR for Group; a date-range history of past BAN % values (offered, not asked for).
- **Tests:** backend `test_habit_ledger.py` (system questions, flags next to marks, per date across sessions, malformed cycle; the existing question assertions look at the user's own questions) and `test_day_score.py` (unchanged); `windowsapp/src/dayScore.test.ts` (model, source, the System kind through `summarize`); website Playwright `analysis-notes.spec.ts` (chip from storage, full score, breakdown order and wording, tab-change refresh, estimated and partial notes, pending labels) and `day-score-trend.spec.ts` (metric reads on choice only, gaps, rounds, failure, no source). The browser test found a real defect: the website requested `/api/day-score` instead of `/api/analysis/day-score`. Suites: backend 3709, desktop vitest 1854, website 113, phone 121; `tsc` clean for website, desktop and phone.
- **Not covered:** the Windows app and the webapp's own suite; real days (the weights are a first guess). By hand: section F of `docs/phase27-manual-acceptance.md`.

