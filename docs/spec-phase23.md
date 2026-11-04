# Phase 23 — Label Trades one-by-one + Manual Behavioral Analysis

**Status: Complete on `dev`** (Sprints 0–8 delivered; manual acceptance on live sessions and the Windows build pending — [phase23-manual-acceptance.md](phase23-manual-acceptance.md)). Implementation plan and sprint table: [spec-phase23-implementation-plan.md](spec-phase23-implementation-plan.md).

Applies to all three clients: website (`frontend/`), webapp (`webapp/`, which renders the same website code) and desktop (`windowsapp/`). All work lands on `dev` first; nothing here is ported to `preprod`/`main` until reviewed (see `CLAUDE.md` branch strategy).

## 1. Requirements (clarified)

### 1.1 Analysis → Label Trades, one round trip at a time

Today the Label Trades tab lists every round trip in a scrolling right panel, each with its own category/strategy/tag fields, and a chart on the left. Redesign:

1. Right panel shows **one round trip at a time** with category, strategy and tag fields for that trade only; the left panel keeps the chart with buy/sell markers.
2. **Prev / Next** buttons move between round trips. The user keeps pressing Next and entering information.
3. When a trade is viewed, **its markers appear on every chart that shows it**: the Underlying chart and the option-strike (CE/PE) chart of that trade.
4. A setting in **Settings → Analytics** chooses **One at a time** (default) or **All together** (today's list), shared across website, webapp and desktop.
5. Applies to all session types that Label Trades covers today (replay, paper, real, stepwise).
6. Saving is automatic when the user leaves a trade (Next/Prev/close) in one-by-one mode.

### 1.2 Manual Behavioral Analysis

The user labels how many times a behavior was demonstrated in a trading day, e.g. "trade went into profit, stayed in profit for 1 bar, then exited at a loss". Three parts:

1. **Behavior questions** — user writes questions; each has a type, **Entry** (asked when the entry strategy is labeled) or **Exit** (asked when the exit/actual strategy is labeled). Questions can be added, edited, **archived** and **unarchived**. Archived questions stay for history: past marks still show in Stats, but they are no longer asked. Only active questions can be newly marked.
2. **Labeling a trade** — for each round trip the user answers **yes / no** per question ("this trade showed this behavior"). Two places:
   - **During trading** (replay, paper, real; stepwise optional): added to the existing entry-label and exit-label popups/panels (website right panel, desktop left tool panel).
   - **In Analysis → Label Trades**, in the trade's form (entry questions next to the entry fields, exit questions next to the exit fields).
3. **Stats** — a new **Habits** view in the Stats dashboard. It started as a per-day count chart and was **expanded after Sprint 6** into a performance analysis of each habit — which habit is most destructive and which is rewarding, and whether each is improving across days (profit %, loss %, entries/exits, capital %, holding bars, comparisons between periods, a single-habit deep dive). Full definition in §10.

### 1.3 Decisions and assumptions

| Topic | Decision |
|---|---|
| Answer type | Yes/No per trade (not a counter). Daily count = number of trades marked yes. |
| Entry vs exit | Entry questions in the entry-label step, exit questions in the exit-label step. |
| Desktop real sessions | Desktop gets labeling for real sessions too (backend returned 409 before). |
| Label Trades default | One at a time + auto-save; setting `analysis_label_view` (`one_by_one` \| `all`). |
| Storage | Behavior marks in their own table (see §3) so existing full-overwrite label writes and the real-session label projection cannot clobber them. |
| Swing | Out of scope for v1 (swing has its own label flow in `SwingHistory`). |
| Stats tab name | "Habits" (a "Behavior" tab for automatic metrics already exists). |
| Habit price-path stats | **Not** in Sprint 7: time in profit, best price reached/give-back and automatic "profit then loss" detection need each trade's price path (cached history, per trade, slow and partial). That habit is tracked by manual marking; the existing cycle drawer's "Analyze cached price path" remains available per trade. |
| Habits delivery | Sprint 7 is split into four PRs, 7a–7d (§10.6). |
| Sharing | Marks are per user; shared real-session history is read-only for viewers. |
| Process | Every sprint updates this document on `dev`. |

## 2. Where things live (existing code, discovered during planning)

- Analysis Label Trades: `shared/analysis/TradeLabeling.tsx` (394 lines; website wrapper `frontend/src/components/TradeLabeling.tsx`; desktop imports the shared file via `GroupCard`). Today save is one bulk "Save Labels" over all trades. Desktop charts use `LabelCharts` = `shared/analysis/kline/AnalysisPanels.tsx`; website shows one chart with pills.
- In-session labeling: website/webapp `frontend/src/components/PendingLabelPanel.tsx` (`LabelPopup`) and `StepwiseLabelPopup.tsx`; desktop `windowsapp/src/App.tsx` (`DesktopLabelPanel`, `DesktopLabelPopup`).
- Stats: `shared/analysis/PerformanceDashboard.tsx` (hand-rolled SVG).
- Desktop analysis transport allowlist exists in three copies: `backend/app/routers/desktop_analysis.py`, `windowsapp/src/analysisApi.ts`, `windowsapp/src-tauri/src/lib.rs`. The desktop app must be rebuilt for Rust-side changes.

## 3. Design

### 3.1 Data model (new DynamoDB tables)

- `BehaviorQuestions`: PK `user_id`, SK `question_id`. Attributes `kind` (`entry`|`exit`), `text` (≤140), `status` (`active`|`archived`), `sort_order`, `created_at`, `archived_at`. Never hard-deleted. The **type is fixed for the life of a question** (decided in Sprint 1, simpler and stricter than "locked once marks exist"): to change a type, archive the question and add a new one; text can be edited.
- `BehaviorMarks`: PK `session_id`, SK `"{round_trip_index:05d}#{question_id}"`; attributes `user_id`, `date`, `symbol`, `session_type`, `round_trip_index`, `question_id`, `kind`, `marked_at`; GSI `UserIdDateIndex` (`user_id`, `date`). Only "yes" is stored; "no" deletes the row.

### 3.2 API (`/api/behavior`)

`GET questions?include_archived=` · `POST questions` · `POST questions/{id}/update` · `POST questions/{id}/archive` · `POST questions/{id}/restore` · `GET marks?session_id=` · `POST marks` · `GET stats` · `GET marks/by-question`. Desktop reaches the same service through the analysis proxy (analysis screens) and `/api/desktop/v1/trading/...` (in-session).

Rules: text trimmed and unique (case-insensitive) among active questions of the same type; kind cannot be changed; at most 40 active questions; only active questions can be newly marked (an archived question's existing marks can be kept or cleared); writes are owner-only, reads follow shared-history access. `POST marks` takes `answers: {question_id: bool}`: true sets, false clears, both idempotent. `GET stats` returns only days that have at least one mark; the client zero-fills trading days. Validation errors are HTTP 400, unknown question/session 404.

Settings: `analysis_label_view` (`one_by_one` default | `all`) in `UserSettings`, shared by all clients.

Known v1 limits: marks of two linked real sessions for the same day are counted separately (labels de-duplicate those through the canonical session; revisit if linked real screens show doubled counts); `get_stats` is a GSI query, not a pre-aggregated table.

### 3.3 UI

- **Behavior Questions manager** (one shared component): Entry and Exit sections of active questions, collapsible Archived list. Add (text + type), edit text, **Archive**, **Unarchive**. Reachable from Settings → Analytics (permanent home), Stats → Habits ("Manage questions"), Label Trades header, and the live labeling popups (add only).
- **Label Trades one-by-one**: sticky header "Trade n of N · contract · P&L", Prev/Next (keyboard ←/→), a strip of per-trade dots (P&L colour, ✓ when labeled), form, save status. Phone layout: chart on top, form below, sticky bottom Prev/Next.
- **Live labeling**: entry checklist in the entry-label step, exit checklist in the exit-label step, in the website popup and the desktop popup.
- **Habits**: scorecard, trends across days, period comparison and single-habit deep dive — see §10 (the original per-day count chart is one of its trend metrics).

## 4. Implementation status

| Sprint | Scope | Status |
|---|---|---|
| 0 | Docs and scaffolding | PR #751 |
| 1 | Backend foundation | Merged (PR #752): tables, service, router, setting, cleanup/maintenance/setup script, 27 new tests; full backend suite 2830 passed, 3 failed (the same 3 swing tests fail on unchanged `origin/dev`: `test_swing_api::test_exact_contract_lot_validation_and_invalid_master_do_not_create_context`, `test_swing_paper_runtime::test_expiry_quote_closes_paper_option_without_closing_equity_context`, `test_swing_stream_valuation::test_last_known_paper_valuation_survives_restart_without_executing_orders[True]`) |
| 2 | Desktop transport and real labels | Merged (PR #753) — see §5 |
| 3 | Analysis one-by-one core | Merged (PR #754) — see §6 |
| 4 | Charts, responsive and webapp | Merged (PR #755) — see §7 |
| 5 | Behavior questions manager + Analysis marks | Merged (PR #756) — see §8 |
| 6 | Live labeling | Merged (PR #757) — see §9 |
| 7a | Habits: ledger backend + transports | Merged (PR #758) — §10.7 |
| 7b | Habits: stats engine + scorecard | Merged (PR #759) — §10.8 |
| 7c | Habits: trends across days + period comparison | Merged (PR #760) — §10.9 |
| 7d | Habits: single-habit deep dive + polish | Merged (PR #761) — §10.10, glossary §10.11 |
| 8 | Hardening and close-out | Implemented (this PR) — §11 |

Details, acceptance criteria and the verification matrix are in [spec-phase23-implementation-plan.md](spec-phase23-implementation-plan.md).

## 5. Desktop transport and real labels (Sprint 2)

- **Analysis screens** (Label Trades, Habits) reach behavior data through the desktop analysis proxy: `GET|POST behavior/questions`, `POST behavior/questions/{id}/update|archive|restore`, `GET|POST behavior/marks`, `GET behavior/marks/by-question`, `GET behavior/stats`. They are listed in all three allowlists — `backend/app/routers/desktop_analysis.py`, `windowsapp/src/analysisApi.ts` (`validAnalysisPath`) and `windowsapp/src-tauri/src/lib.rs` (`valid_analysis_path`) — with tests in each. All are GET/POST because the native analysis command supports nothing else. **The desktop app must be rebuilt for the Rust change** (browser dev mode only needs the TS and backend changes).
- **In-session and Settings** use `/api/desktop/v1/trading/...` (no allowlist): `GET|POST behavior/questions`, `POST behavior/questions/{id}/update|archive|restore`, `GET|POST {session_id}/behavior-marks` (body `{round_trip_index, answers}`). Marks require the session to be the caller's own, of type stepwise/sim/paper/real (else 409).
- **Capability flag** `behavior-labels` is advertised in `trading_capabilities`.
- **Real sessions on desktop:** `GET {session_id}/trade-labels` no longer returns 409 for `real`. Slots come from the committed broker book — `trade_label_service.real_round_trip_state` (`load_session_cycles` + `cycle_round_trips`), the same source Analysis and `save_labels` use for real sessions, so the indices labeled in-session equal the indices Analysis shows later (covered by a test). A transient read race returns 503 so the desktop's existing 3x retry applies. The desktop UI itself is unchanged in this sprint; its label panel will simply start loading state for real sessions (UI work for behavior is Sprint 6).
- Still to verify manually (cannot be automated here): a live linked real session on desktop — that the open/closed slots appear as soon as a fill is committed, and that indices match the website for the same session.

## 6. Label Trades one at a time (Sprint 3)

`shared/analysis/TradeLabeling.tsx` (used by website, webapp and desktop) is now an orchestrator over `shared/analysis/labeling/`:

- `model.ts` — pure helpers: `finalizeLabel` (same defaults as the old Save: actual←expected, tags `AS_PER_PATTERN`), `isLabeled`, `tradesForRoundTrip` (executions of one round trip, matched by `trade_id`/`execution_id`/`stored_trade_id` inside the same session), `roundTripMarkerText` (`#3 BUY`, `#2/#3 SELL`), `contractName`, ordering.
- `saver.ts` — `LabelSaver`, the auto-save engine: debounce (600 ms), sends **only edited trades**, never overlaps saves (an edit made during a save goes out in the next pass), keeps unsaved edits and reports the error on failure, `flush()` for Prev/Next/unmount.
- `RoundTripLabelForm.tsx` — category/strategy (expected + actual) and tag fields, shared by both modes (Sprint 5 adds the behavior checklists here).
- `OneByOneLabeling.tsx` — header "Trade n of N" with **◀ Prev / Next ▶** (also ←/→ when not typing in a field), round-trip strip (colour = P&L sign, dot = already labeled, click to jump), trade summary, save status ("Saving…", "Saved ✓", error + Retry save). Read-only shared history navigates but cannot edit.
- `labeling.css` — `tl-` classes with CSS variables (website dark palette by default; desktop palette under `.desktop-label-workflow`).

Behaviour:
- **Default is one at a time**, chosen by the user setting `analysis_label_view` (`one_by_one` | `all`). A segmented control in the panel header switches views and persists the setting; Settings → Analytics (website/webapp) and Settings → Analytics (desktop) also expose it. **All together** keeps the previous list with the explicit **Save Labels** button; switching away from it is disabled while it has unsaved edits.
- **Prev/Next/jump/close/tab change flush the pending save first.** If the save fails the user stays on the trade with a Retry button; Next is blocked while saving. Leaving Label Trades (unmount) flushes and then notifies Stats (`onDataChanged`) once.
- **Chart markers:** only the viewed trade's executions are passed to the charts (`tradesForRoundTrip`, falling back to all trades if none match); an **All markers** checkbox restores every trade. Markers carry the round-trip number on the Underlying chart; the website's chart pills show the Underlying and only the viewed trade's strike. Desktop's `AnalysisPanels` follow the filtered trades automatically. Stacked panes, recentring the chart on the trade and numbering on strike charts are Sprint 4.
- **Setting plumbing:** `AnalysisEnvironment.labelView` / `onLabelViewChange`. Website: `useAnalysisLabelView` (cached value, server wins once `getUserSettings` publishes it; writes via `updateUserSettings`). Desktop: `DesktopAnalysis` reads `trading/settings/current` whenever Analysis becomes active and writes with `PUT trading/settings/current`.

Verification:
- `windowsapp/src/labeling.test.ts` (11 tests: model helpers, saver debounce, only-edited, failure/retry, no overlap, reset); vitest total 323.
- `scripts/website-label-trades-check.mjs` (new, StrictMode): Prev/Next, only the edited trade saved before navigating, untouched trades never written, debounced auto-save, per-trade chart pills, All markers, All-together switch persists the setting.
- `scripts/desktop-analysis-workflows.mjs` extended with the one-at-a-time scenario (mode switch, Prev/Next, ←, strip jump, auto-save, setting PUT). Two **pre-existing, unrelated** problems in that script: it needs `nodePaths` for `klinecharts` (added) and its `snapshotTimes.every(t<captured.bar_time)` assertion fails on unmodified `dev` too, and its final Settings step still looks for the old "History sharing" tab (renamed "Sharing"); the label scenarios before them pass.
- All three TypeScript checks pass.
- Not yet done (later sprints): phone layout / sticky bottom bar (Sprint 4); behavior checklists (Sprint 5).

## 7. Charts, responsive layout and webapp (Sprint 4)

**Charts (website/webapp)** — `shared/analysis/labeling/LabelChartPanes.tsx` replaces the single chart with pills. For the viewed trade it stacks the **Underlying chart and the trade's strike chart** (both Lightweight and KLine renderers), each showing that trade's markers numbered `#idx B/S`. Several contracts (only when "All markers" is on) get a contract switcher above the strike pane. Equity trades show just the Underlying pane. Desktop keeps `AnalysisPanels` (side-by-side panes) and receives the same `focusTime` / `labelContractMarkers` props.

**New chart props** (`shared/analysis/chartProps.ts`, additive and optional):
- `focusTime` — epoch seconds to centre on; the entry of the viewed round trip. KLine keeps the zoom and scrolls the bar to the middle on load and whenever it changes; Lightweight sets the visible range to ±45 bars once the candles of the current interval are drawn.
- `fill` — Lightweight charts fill their parent's height instead of `width × 0.6` (Label Trades panes).
- `labelContractMarkers` / option-chart `getMarkerText` — numbering on strike-chart markers is **opt-in**: option-contract markers remain unlabeled everywhere else (an existing test and decision), so Pattern-vs-Trade comparison and the normal Analysis panels are unchanged. `analysisMarkers(..., labelContract)`; coincident fills merge their texts.

**Responsive layout** (`labeling.css`, `tl-layout`): ≤900 px is one column. The chart panes show one at a time behind **Underlying / strike tabs**; the header's Prev/Next buttons are replaced by a **bottom bar fixed to the bottom of the screen** (44 px targets, right padding so the floating AI button stays reachable, safe-area aware, content gets bottom padding) with the counter (`n / N`). The compact "Trade n of N" counter stays in the header. Wider windows keep two columns.

Decision notes:
- The phone bar is `position: fixed`, not `sticky`: inside the Analysis modal the nearest scroll containers are padded/clipped and sticky did not engage at rest. As part of this, the Analysis **session group card uses `overflow: clip`** instead of `hidden` (same rounded-corner clipping, but it is no longer a scroll container).
- Trade selection state: the strike pane follows the viewed trade's contract automatically; a manual switch applies only while several contracts are shown.

Verification:
- `windowsapp/src/analysisMarkers.test.ts` (+1: opt-in strike labels, merge); vitest 324.
- `scripts/website-label-trades-check.mjs`, run with **both renderers** (`ANALYSIS_RENDERER=lightweight|kline`): stacked panes with usable height, strike pane only for option trades, "All markers", KLine centring on the entry (and recentring on Prev/Next), plus the **390 px phone checks** (no horizontal scroll, fixed bottom bar, pane tabs, bar reachable after scrolling). Screenshots in `.cache/desktop-analysis-validation/`.
- `webapp/tests/label-trades.spec.ts` (new): the real Analysis modal at 390×844 — Label Trades, bottom bar pinned at the screen bottom, only-edited-trade auto-save, pane tabs, no sideways scroll. The whole webapp suite passes (22). Running it requires `bash scripts/build-frontend-with-webapp.sh` first (the tests serve `frontend/dist`).
- Not verified here: native touch behaviour on a real phone and the Windows desktop build (manual).

### 7.1 Follow-up: one chart with a switcher, split when maximized

The always-stacked (website) and side-by-side (desktop) Underlying + strike charts left each chart small. Now:

- **Not maximized:** one chart at a time. Website/webapp: a switcher **below** the chart lists `Underlying` and each CE/PE strike of the viewed trade (`LabelChartPanes`, `nav[aria-label="Chart pane"]`); desktop: the existing `Underlying | Option` switcher (with the contract tabs inside the Option pane) at any window width (`AnalysisPanels` `layout="single"`, class `is-single`). The chart uses the full column, and on desktop the window height (`max(450px, 100vh - 300px)`).
- **Maximized** (Label Trades' `⤢ Maximize` / `⤡ Restore`, Esc restores): Underlying and strike charts shown together — stacked on the website, side by side on desktop — with the label form in a 360–460 px column so the charts get the rest.
- **Phones:** always the switcher.
- `TradeLabeling` passes `maximized` to `LabelChartPanes` and `layout` to the desktop `LabelCharts`. The Maximize button now has a text label and `aria-label`.
- Tests: `website-label-trades-check.mjs` (single chart, switcher below, maximize/restore, both renderers), `desktop-analysis-workflows.mjs` (single/Option switch, maximize shows both, size assertions), webapp phone spec unchanged.

### 7.2 Follow-up: P&L % and peak capital % in the Label Trades panel

- **P&L follows the P&L display setting** (`desktop_pnl_display_mode`, Settings → P&L display): in percent mode the trade's P&L is shown as % of the session capital (`+0.70%`), otherwise as money (`+₹700.00`). The tooltip shows both. If the % is unknown (no capital) the money is shown. Applies to the one-at-a-time header and chips and the all-together list.
- **Peak capital** is shown beside it as `Peak 3.00% of capital`: the most capital the round trip had in use at any one moment. Example: three entries of 10 lots at 100, one exit, one more entry, then exit all - the peak is the 30 lots held at once (3,000 of 100,000 = 3.00%), not the 40 lots bought. Computed in `performance_service.build_cycles` as the maximum, after each entry fill, of the open lots at cost times their margin rate (the same margin adjustment as an entry's `effective_allocation_pct`), over the session capital; exposed per cycle as `peak_capital_pct`.
- **API:** `round-trips` items (`trade_label_service.cycle_round_trips`) gain `pnl_pct` and `max_capital_pct` (both null when the capital is unknown).
- **Plumbing:** `AnalysisEnvironment.pnlDisplayMode` - website via `useAnalysisPnlMode` (published from the user settings in `api.ts`, first paint from the Settings browser mirror), desktop from `trading/settings/current`.
- Not changed: the in-session label popups, and the Habits "capital %" (sum of entry allocations, a different measure).
- Tests: `test_trade_label_service.py` (peak/P&L % example, no-capital case), `website-label-trades-check.mjs` and `desktop-analysis-workflows.mjs`.

## 8. Behavior questions manager and Analysis marks (Sprint 5)

**Where the manager lives** — one shared component, `shared/analysis/behavior/BehaviorQuestionsManager.tsx`, with the API injected (`BehaviorApi`):
1. **Settings → Analytics → Behavior questions** on the website/webapp (`SettingsModal.tsx`) and on desktop (`DesktopSettingsModal.tsx`, using `createDesktopBehaviorApi` over the desktop trading routes). Permanent home.
2. **Analysis → Label Trades → "Manage questions"** (modal, both views, all clients); closing or changing it reloads the checklists.
3. (Sprint 6) the live labeling popups; (Sprint 7b) Stats → Habits ("Manage questions").

**Manager behaviour:** add form (text + Entry/Exit radio; client-side validation mirrors the backend: empty, >140 characters, duplicate among active questions of the same type, 40 active max), Entry and Exit sections of active questions with counts, inline **Edit** (text only — the type is fixed), **Archive** with an inline confirmation that says past marks stay in Stats, a collapsible **Archived (n)** list (greyed, archive date, **Unarchive**), server validation errors shown inline (the website API surfaces `detail`; desktop transports are parsed by `readableError`). Questions are never deleted.

**Checklists** (`BehaviorChecklist`): yes/no switches, entry questions under the Entry Tag field and exit questions under the Exit Tag field of the label form (`RoundTripLabelForm`), so they sit beside the entry/exit fields in both views. A type with nothing to show renders nothing. An **archived question appears on a trade only if that trade is already marked with it** — muted, tagged "archived", and it can be cleared but never set again.

**Saving:** toggles are optimistic and saved by `MarkSaver` (debounce 400 ms; toggles on the same trade made before a save are combined into one `POST behavior/marks`; saves never overlap). Prev/Next/jump, switching view and leaving Label Trades flush the label saver **and** the mark saver; the status line combines both (`combineSaverStates`). Marks save automatically even in **All together** mode (they are toggles, independent of the Save Labels button; a failure shows an inline Retry). Read-only shared history cannot mark. If behavior data fails to load, labeling still works and a note says "Behavior questions unavailable: …".

**Transports** — website: `/api/behavior/*` (`api.ts`: `getBehaviorQuestions`, `addBehaviorQuestion`, `updateBehaviorQuestion`, `archiveBehaviorQuestion`, `restoreBehaviorQuestion`, `getBehaviorMarks`, `saveBehaviorMarks`; errors surface `detail`). Desktop Analysis: `createAnalysisApi` over the allowlisted proxy routes (no cache invalidation, so chart loads are not aborted). Desktop Settings/in-session: `windowsapp/src/behaviorApi.ts` over `trading/behavior/*` and `trading/{sid}/behavior-marks`.

Code: `shared/analysis/behavior/{model,types}.ts`, `BehaviorChecklist.tsx`, `BehaviorQuestionsManager.tsx`; `labeling/saver.ts` is now a generic `AutoSaver<T>` with `LabelSaver` and `MarkSaver`.

Verification:
- `windowsapp/src/behavior.test.ts` (9 tests: grouping, which questions a trade shows, validation, mark indexing, readable errors, `MarkSaver` combining, both desktop transports); vitest 333 pass; all three TypeScript checks pass.
- `scripts/website-label-trades-check.mjs` (both renderers): checklists per trade (active + archived-marked only), auto-saved marks, flush on Prev, add/duplicate/edit/archive/confirm/unarchive in the modal, form picks up the new question.
- `scripts/desktop-analysis-workflows.mjs`: marks over the Analysis proxy flushed on Prev, the manager modal, and the Settings → Analytics manager. This sprint also repaired the script's stale final step (the "History sharing" tab is now "Sharing"); it passes end to end except its pre-existing, unrelated snapshot-time assertion.
- `webapp/tests/label-trades.spec.ts` (+1): Settings → Analytics add/edit/archive/unarchive on the website; whole webapp suite 23 pass.
- Not covered here: archived-question history in Stats (Sprint 7) and live-trading popups (Sprint 6).

## 9. Live labeling (Sprint 6)

Behavior questions now appear in the labels you fill in **while trading**: replay, paper and real sessions on the website/webapp and on the desktop; stepwise on the website.

| Where | Entry questions | Exit questions |
|---|---|---|
| Website/webapp `PendingLabelPanel` (all session types, incl. real) | "Label Entry" popup (open trade) | "Label Exit" popup (pending exit) |
| Website stepwise popup (`StepwiseLabelPopup`) | per round trip, under Entry Tag | per round trip, under Exit Tag |
| Desktop left panel (`DesktopLabelPanel`) — replay, stepwise, paper and **real** | "Expected Pattern" popup | "Actual Pattern" popup |

**Behaviour**
- A popup asks only the questions of its type and pre-fills the trade's saved answers (an archived question appears only if the trade already has its mark; it can be cleared, not set).
- **Save order:** the label first, then the behavior answers — and only the answers that changed (`diffAnswers`), so an untouched checklist sends nothing. If the behavior save fails the popup stays open with the choice intact (website: notification; desktop: inline message) and Save retries (the label is re-sent, which is idempotent).
- **Empty state:** with no questions of that type the popup says so and offers **Add questions**, opening the manager above the popup; the checklist updates in place without resetting the toggles already made. Behavior data failing to load never blocks labeling ("Behavior questions unavailable: …").
- Stepwise popup: marks are saved after the labels for every round trip in one pass.
- Limits: once an entry label is saved its button leaves the panel, so entry behaviors for that trade are edited afterwards in **Analysis → Label Trades**.

**Round-trip numbering bug fixed (website).** Labels and marks are keyed by `(session_id, round_trip_index)`. The backend numbers a round trip when it **opens** (`build_cycles`: `index = len(cycles)`), but the website numbered it when it **closed**, with one counter shared by every open leg. With CE and PE open together and the second-opened leg closing first, both entry labels collided on one number and the exit numbers were swapped relative to the backend — so labels, and now marks, landed on the wrong trade. `frontend/src/hooks/roundTripIndexer.ts` (`stepLeg`, `openIndex`) now assigns the number at open and keeps it until that leg closes (at the three detection sites in `useSimulation.ts`); a leg already open when tracking began takes the next free number on close. Known remaining limit: the website still tracks one leg per instrument right (equity/CE/PE), so two different CE strikes open at once share one leg — the same as before; the desktop takes its slots from the server and is not affected.

**Desktop real sessions** use the server slots added in Sprint 2 (committed broker book), so the popup indices equal the ones Analysis shows later. `DesktopLabelPanel` is exported for testing; its popup now stays mounted until closed (a saved label no longer removes it mid-retry).

**Code:** shared `behavior/{useBehaviorData,BehaviorPicker,BehaviorManagerModal}`; `PendingLabelPanel.tsx`, `StepwiseLabelPopup.tsx`, desktop `App.tsx` (`DesktopLabelPanel`, `DesktopLabelPopup`, async `saveTradeLabel`); `TradeLabeling` reuses `BehaviorManagerModal`.

**Verification**
- `windowsapp/src/roundTripIndexer.test.ts` (7: sequential, concurrent CE+PE out of order, stable open numbers, partial fills, resumed position, reopen) and `behavior.test.ts` +1 (`diffAnswers`); vitest 341.
- `scripts/website-live-label-check.mjs` (new): entry popup → label then mark; exit popup pre-filled incl. archived-marked; failed behavior save keeps the popup and choice and retries; unchanged → no request; empty state + manager above the popup + in-place refresh; "unavailable" note; stepwise popup with two round trips.
- `scripts/desktop-live-label-check.mjs` (new): real-session slots (open CE #3, closed PE #2), entry/exit popups, retry with a readable server error, empty state + manager.
- Regression: Label Trades website check (both renderers), `desktop-analysis-workflows.mjs` (apart from its pre-existing snapshot-time assertion), whole webapp suite 23; all three TypeScript checks.
- Not covered here (manual): a live replay/paper/real session end to end on the website and desktop, in particular two legs open at once on the website.

## 10. Habits stats (Sprint 7 — expanded design)

**Goal.** Let the user see *which habit is most destructive and which is rewarding* and *whether each habit is improving across days* — including cases such as "I still took the bad habit but with a smaller capital %" or "I exited at a loss, but within the same bar".

### 10.1 Data: a trade ledger from the backend, statistics in TypeScript
- `GET /api/behavior/habit-ledger` takes the same filter query as `/api/analysis/performance` (the `performance.filters()` dependency: dates, symbol, instrument/session type, client, direction, methods, tags…). It loads the user's cycles with `performance_service.load_cycles` (so every filter, real-day alias de-duplication and sharing rules match the Stats overview), keeps **own, closed, intraday** cycles, joins the user's marks and returns **one compact row per closed trade** plus the questions (incl. archived) and coverage counts:
  - Row: `cycle_id, session_id, date, entry_time, symbol, right, strike, direction, net_pnl, pnl_pct, capital_pct, risk_pct, entries, exits, holding_seconds, bars, r_multiple, habits:[question_id…]`.
  - Coverage: `closed_trades, marked_trades, marks, unmatched_marks, open_marked_trades, trades_without_capital, trades_without_bars, truncated` (row cap 20,000).
- All statistics (summaries, baseline, per-day series, buckets, period comparison, verdicts) are computed client-side by one pure module, `shared/analysis/habits/habitStats.ts`, so any slice (two periods, kind filter, mean vs median) needs no extra request and every number reconciles with the same rows.
- **Join.** A mark is `(session_id, round_trip_index)`. For sim/paper/stepwise/real intraday sessions `round_trip_index == cycle["index"]` (`build_cycles` numbers a cycle when it opens — the same number labels use and the website now assigns). Swing (keyed by `label_index`) is out of scope. Linked real-day aliases: a mark's session is mapped to its book (`broker_projection_id or session_id`) and joined on `(book_id, index)`; duplicate marks on aliases collapse to one `(book, round_trip_index, question_id)`; marks whose trade cannot be found are **reported as unmatched**, never dropped silently. Marks are not remapped by the real-book restage, so they can drift after a re-sync — unmatched counts make that visible. Only the user's own sessions are used (a viewer has none of the owner's marks). Open cycles are excluded from P&L statistics and counted in coverage.

### 10.2 Definitions
| Term | Definition |
|---|---|
| Trade | One closed cycle (round trip). A trade can carry several habits (entry and exit habits are independent). |
| P&L % | `pnl_pct` = net P&L ÷ the session capital (already normalised for real days). "Profit %" / "Loss %" of a habit = sum of its winning / losing trades' P&L %, i.e. percent-of-capital points. **Net %** = their sum. ₹ values are shown alongside (toggle). |
| Capital % | Total capital deployed on the trade = **sum of its entries'** `effective_allocation_pct`; unavailable (null, counted in coverage) when an entry has no analytics (older or broker-imported rows). Risk % likewise from `effective_risk_pct`. |
| Bars held | Candles touched = `exit_time // interval − entry_time // interval + 1`, so the **same candle = 1 bar**; interval = the entry's `strategy_interval_seconds`, else 180 s (the cycle does not carry the session, so there is no session fallback). It is the strategy candle size, not necessarily the chart interval. |
| Entries / exits | `entry_count` / `exit_count` of the trade (scale-ins and partial exits). |
| Baseline | The user's other trades in the same scope (those **without** that habit). |
| Low sample | A habit with fewer than 10 trades in scope. |

### 10.3 Scorecard (answers "destructive vs rewarding")
One row per habit (kind badge, archived muted), sortable, default worst net % first: trades; days with the habit; **net %, profit %, loss %**; win %, average win/loss %, payoff ratio, profit factor, largest loss %; **vs without the habit** (Δ average % vs baseline) and **"if skipped"** (net % saved or lost); share of all losses / all profits attributable to the habit; **entries and exits per trade** (mean and median); **capital %** (mean, median, max) and risk %; **holding** (median/mean bars and time, share exited within 1 and within 2 bars, share of losers closed within 1 bar). A **verdict** chip with an explanation: *Costly* (net < 0 and below the baseline), *Rewarding* (net > 0 and above it), *Mixed*, *Low sample*. Global **Mean | Median** and **% | ₹** toggles; a diverging bar chart of net % per habit sits above the table.

### 10.4 Across days
- **Trends:** per-day, per-habit metric — occurrences, net %, loss %, profit %, average capital %, median bars held, share exited within 1 bar, entries/exits per trade. Counts and sums plot 0 on trading days without the habit; averages leave a **gap**. Legend toggles, readout on hover/focus, optional 5-day rolling mean; clicking a point lists that day's trades for the habit and opens the cycle drawer.
- **Compare periods:** last *N* trading days vs the *N* before (5/10/20) or two custom ranges; per habit: occurrences per day, net %, loss %, capital %, median bars, ≤1-bar share, entries/exits as A | B | Δ. Colour shows favourable/unfavourable (smaller loss %, higher net % are favourable; fewer occurrences of a *Costly* habit is favourable; capital % and bars show a neutral arrow). A per-habit flag **improving / same / worse** combines loss % and capital % ("still taking it, but smaller").
- **Days with vs without** the habit: average day net %.

### 10.5 Single-habit deep dive
Stat tiles; buckets (count, net %, win %) by **bars held** (1, 2, 3–5, 6–10, >10), **capital %** (terciles of the user's trades in scope), **time of day** and weekday; a **scatter** of capital % vs P&L % (colour = recency); the habit's **trade list** (sortable) opening the existing cycle drawer; coverage line (matched/unmatched marks, trades missing capital % or bars).

### 10.6 Delivery
| PR | Scope |
|---|---|
| 7a | `habit_ledger_service.py` + `GET /api/behavior/habit-ledger`; website `getHabitLedger`; desktop adapter and the three allowlists (`desktop_analysis.py`, `analysisApi.ts`, `lib.rs`) — desktop rebuild required |
| 7b | `habitStats.ts` + Habits tab shell, controls, scorecard, diverging chart, verdicts, coverage line, "Manage questions" |
| 7c | Trend chart + metric selector, period comparison, days with/without |
| 7d | Deep dive (buckets, scatter, trade list → cycle drawer), accessibility and phone polish |

Verification includes a backend test that **ledger totals reconcile with the Stats report summary** for the same filters, vitest on hand-computed fixtures for every metric, and browser checks on a shared multi-day synthetic ledger (website with both chart renderers, desktop, webapp phone).

### 10.7 Sprint 7a — ledger backend and transports (implemented)
- `backend/app/services/habit_ledger_service.py`: pure `interval_seconds`, `bars_held`, `capital_pct`, `risk_pct`, `trade_row`, `owner_session_id`, `build_ledger`; `load_ledger(user_id, criteria)` does the I/O (`performance_service.load_cycles` with `include_shared=False`, marks from `behavior_service._user_marks` pre-filtered by date/symbol/session/instrument type, the mark sessions' rows for the alias → owner mapping, all questions incl. archived).
- `GET /api/behavior/habit-ledger` (`routers/behavior.py`) takes the `performance.filters()` query (422 for an inverted date range or an invalid mode) and returns `{questions, trades, coverage}`. Row order is chronological; the cap is 20,000 rows and keeps the most recent (`coverage.truncated`).
- **`unmatched_marks` means "a mark in this date/symbol/mode scope that no trade in the loaded scope matches"**: the trade is missing (the broker book was restaged), or it is excluded by a trade-level filter (direction, entry method, tags…). Marks of other symbols/modes/dates are out of scope and not counted.
- Not in the ledger by design: swing portfolios, other users' shared cycles, open trades (counted in `open_marked_trades`).
- Cost: one `load_cycles` pass — the same cost as opening the Stats overview — plus one `get_item` per distinct session that has marks. Sprint 8 measures it on a large history and adds a cache if needed.
- Transports: website `getHabitLedger` in `frontend/src/services/performanceApi.ts` (added to `AnalysisEnvironment.performance`, optional); desktop adapter in `windowsapp/src/analysisApi.ts`; `behavior/habit-ledger` GET added to all three allowlists (`desktop_analysis.py`, `analysisApi.ts`, `lib.rs`) — **the desktop app must be rebuilt**. Shared types: `shared/analysis/habits/types.ts` (`LedgerTrade`, `LedgerCoverage`, `HabitLedger`).
- Tests: `backend/tests/test_habit_ledger.py` (16: bars/interval/capital/risk derivation and fallbacks, join on the cycle index, open/shared/swing exclusion, alias de-duplication, unmatched marks, row cap and ordering, filters scoping trades and marks, other users isolated, archived questions kept, **ledger totals reconcile with `report()["summary"]` (count, net P&L, P&L %)**, endpoint validation, desktop proxy read-only); vitest (allowlist, adapter call shape); `cargo test` (allowlist); totals: vitest 343, `cargo test` 23, full backend suite 2856 passed with only the same 3 swing tests failing as on unchanged `dev`.

### 10.8 Sprint 7b — stats engine and scorecard (implemented)
**Where:** a new **Habits** tab in the Stats dashboard (`shared/analysis/PerformanceDashboard.tsx`, after Behavior; not shown for swing). The tab replaces the overview KPI tiles with its own content and fetches `getHabitLedger` lazily with the dashboard's current filters (re-fetched on Refresh, filter change, data revision and after the question manager changes something). Website, webapp and desktop use the same component.

**Engine** — `shared/analysis/habits/habitStats.ts` (pure, no React):
- `totals(trades)` → trades, trades with a P&L %, days, wins/losses/break-even (net ₹ beyond ±0.005), win %, net/profit/loss in ₹ and in %, mean and median of ₹ and %, average win/loss %, payoff ratio, profit factor, largest loss.
- `profile(trades)` → entries/exits per trade, capital % (mean, median, max), risk %, bars held, holding time (mean/median each), share closed within 1 and 2 bars, share of **losers** closed within 1 bar.
- `summarize(questions, trades, {kind, includeArchived})` → per habit: its totals, the **baseline** (all other trades in scope), profile, **if skipped** (−net), **share of all losses / profits**, trades per trading day, and the **verdict**; plus the scope totals and the **idle** habits (active, no trade in scope). Archived habits appear only when they have trades.
- `verdictFor`: *Low sample* below 10 trades; else *Costly* (net < 0 and mean below the baseline mean), *Rewarding* (net > 0 and above it), *Mixed* otherwise. It uses % of capital and means, falling back to ₹ when no trade has a P&L %; the reason text states the numbers and is shown as the chip's tooltip.
- A % total over trades that have no P&L % is **unavailable (shown "—"), not 0**; such habits sort last in either direction.
- `metric`/`sortHabits`/`worstFirst`: one place that decides what each column shows for the selected unit (% or ₹) and statistic (mean or median).

**UI**
- Controls: type (All/Entry/Exit), **Mean | Median**, **% of capital | ₹**, columns **Results | Size & timing**, **Include archived**, **Manage questions** (the shared modal; a change reloads the ledger).
- **Diverging bar chart** (`DivergingBars`): losses left (red), profits right (green), ◆ at the net, most destructive habit first; each row is focusable with an `aria-label` carrying its numbers.
- **Scorecard** (`HabitScorecard`): one row per habit with Entry/Exit badge, archived tag and Verdict chip. *Results*: trades, days, net, profit, loss, win %, average per trade, vs without, if skipped, share of losses and of profits, profit factor, payoff, worst loss. *Size & timing*: trades, entries, exits, capital % (average and max), risk %, bars held, time held, ≤1 bar, ≤2 bars, losers ≤1 bar. Sortable headings (`aria-sort`), the habit column stays in view while the table scrolls on a phone, default order = most destructive first.
- Coverage line (closed trades, marks on trades, marks not matched, marked open trades, trades without capital % / bars), truncation note, idle habits, a "How these numbers are calculated" panel, and empty states ("Start with a habit to track" → opens the manager; "No habit marks in this selection").

**Verification**
- `windowsapp/src/habitStats.test.ts` (15): mean/median/stat, win/loss/break-even split, profit/loss % sums, mean and median per habit, baseline and "if skipped", shares, size/timing profile and the 1/2-bar shares, missing-% habits, idle/kind/archived filters, verdict boundaries and ₹ fallback, sort order with unavailable values last, unit and mean/median switching — all against numbers worked out by hand. vitest total 357.
- `scripts/habits-browser-check.mjs` (new) on a deterministic 10-day ledger (`scripts/habits-ledger-fixture.mjs`; expectations computed by independent plain loops): row order, net/loss/profit %, trades and verdicts per habit, chart rows, coverage, idle habits, every control (unit, mean/median, type, archived, columns, sorting), the manager, empty states, and the 390 px phone layout (no sideways page scroll, table scrolls inside, habit column pinned). Screenshots in `.cache/habits-validation/`.
- `scripts/desktop-analysis-workflows.mjs`: Habits through the desktop Analysis proxy (scorecard order, ledger GET). `phase20-browser-check.mjs` still passes (its missing `nodePaths` was added). Whole webapp suite 23; all three TypeScript checks pass.
- Not in this PR: trends across days, period comparison (7c); the single-habit deep dive (7d).

### 10.9 Sprint 7c — trends across days and period comparison (implemented)
The Habits tab now has three sections (**Scorecard | Trends across days | Compare periods**); the type, Mean/Median, %/₹ and archived controls apply to all of them.

**Engine** — `shared/analysis/habits/habitSeries.ts` (pure):
- `tradingDays` (the chart axis: every day with a closed trade in the filters), `lastPeriods(days, n)` (the last *n* trading days vs the *n* before; the earlier period may be shorter; null when nothing precedes), `customPeriods` (two inclusive ranges that each contain trading days).
- `daySeries(trades, days, habit, metric, unit, mode)`: metrics **occurrences, net, loss, profit, capital %, bars held, closed within 1 bar, entries per trade, exits per trade**. Counts and sums are **0** on a day without the habit; averages and shares are **gaps (null), never 0**. `rollingMean` (5 days) ignores gaps.
- `compareHabit(trades, habit, before, recent, unit, mode, verdict)` → for **trades per day, net, loss, capital %, bars, ≤1 bar, entries, exits**: `before`, `recent`, `delta` and a `tone`; plus the **flag**.
- `toneFor`: green/red only for results (net up, loss closer to 0) and, for a habit whose verdict is Costly or Rewarding, how often it happens (fewer is good for a Costly habit, more for a Rewarding one); capital, bars, ≤1 bar and entries/exits stay neutral (shown with the arrow).
- **Flag** = three components, each +1 better / −1 worse / 0 (a change of at least 10%): (1) **loss per trading day**, (2) **frequency** (trades per day), (3) **capital %**. For a Costly habit less is better, for a Rewarding habit more is better, for a Mixed habit (2) and (3) are not judged. **Improving**: total ≥ +1 and loss not worse; **Worse**: total ≤ −1 and loss not better; **Mixed**: signals disagree (e.g. "losses shrank but you now size it bigger"); **Same**: nothing moved; **Too few trades**: fewer than 3 in either period. The chip's tooltip lists the three components in words, so "still taking it, but with less capital" is visible as *Improving* with the capital arrow.
- `daysWithWithout`: the average **day** net (all that day's trades) on days the habit occurred vs the other days, and the difference.

**UI**
- **Trends:** metric selector (help text states how empty days are shown), legend chips (up to the 4 most frequent habits are on by default), optional **5-day average**, a multi-series line chart (`MultiLineChart`: gridlines with 0 emphasised, date axis, a gap breaks the line). Hover or ←/→/Home/End pick a day, with a live readout of every shown habit's value for that day; click or Enter **selects the day** and lists the shown habits' trades that day (time, instrument, habits, P&L, capital %, bars) with **Open**, which opens the dashboard's cycle drawer. The chart's `aria-label` states metric, unit and habits.
- **Compare:** presets **Last 5 / 10 / 20 days vs before** or **Custom** (four date pickers), the two ranges with their trading-day counts, then a table per habit: Trend flag, trades, per day, net, loss, capital %, bars held, ≤1 bar, entries, exits, each as *before → recent* with a coloured delta; a footnote spells out the rules; below it the **days with vs without** table.
- Both charts draw in **real pixels** (`useWidth`): text stays readable on a phone, and the scorecard's diverging chart switches to a compact layout (habit name above its bar) under 640 px. A pressed segmented button keeps its highlight while hovered.

**Verification**
- `windowsapp/src/habitSeries.test.ts` (12, hand-computed): trading days, period splitting and custom ranges, every series metric incl. zero-fill vs gaps and rupee/% handling, rolling mean with gaps, flags (improving, worse, mixed, same, too few, rewarding, mixed habit), tones, days with/without. vitest total 369.
- `scripts/habits-browser-check.mjs` extended (fixture expectations by independent loops): chips and metric switching, capital % readout per day via keyboard (first/last day), archived habit gap (—) vs occurrence 0, legend toggling, 5-day average and ₹ in the chart description, day selection → trade list → cycle drawer request (session and cycle id), compare presets (10-vs-10 impossible message, 5 vs before), flags per habit (Improving / Same / Same / Too few), per-day and capital cells, days with/without, custom ranges, and phone layout for both new sections (no sideways page scroll, table scrolls inside, chart scales). Desktop workflow script and `phase20-browser-check.mjs` still pass; whole webapp suite 23; all three TypeScript checks pass.
- Not in this PR: the single-habit deep dive (buckets, scatter, trade list) — 7d.

### 10.10 Sprint 7d — single-habit deep dive and polish (implemented)
**Opening it:** the **Deep dive** section, or click a habit's name in the scorecard (its name is a button, "Deep dive: <habit>"). A selector switches habit (archived ones are labelled); it defaults to the most destructive one.

**Contents** (`HabitDeepDive.tsx`, logic in `deepDiveStats.ts` — named to avoid a case-insensitive file-name clash with the component on Windows):
- **Tiles:** trades, days, net, profit, loss, win %, average per trade, vs without, if skipped, average capital %, average bars, ≤1 bar, losers ≤1 bar — the same values and tooltips as the scorecard, plus the verdict and its reasoning.
- **Losses closed within one bar:** "X of Y losing trades (Z%) were closed inside the candle they were entered in, accounting for W% of this habit's total loss (−n%)" — losers without a bar count are left out of Y and said so.
- **Four breakdowns** (trades, net, win %, average per trade, with a small net bar): **by bars held** (1, 2, 3–5, 6–10, over 10, unknown), **by capital used** (thirds of *all* the user's trades in the current filters — edges are shown in the group labels, an edge value belongs to the lower group, and the split is skipped with an explanation below 6 trades or without spread), **by time of day** (half-hour of the entry, IST; empty half-hours omitted) and **by weekday**.
- **Size against result** (`ScatterPlot`): one dot per trade with a capital % and a result; dim = older, bright = recent, so a habit "still taken but smaller" shows as recent dots drifting left. Dots are keyboard-focusable and Enter or a click opens the trade in the cycle drawer.
- **Trades with this habit:** sortable (date, result, capital %, risk %, bars, held, entries, exits; missing values always last), 25 at a time with "Show more", the habit's co-occurring habits, and **Open** per row. A footnote counts trades without capital % or bars.

**Polish:** every table has a caption and column scopes, every button an accessible name (an automatic check runs in four sections of the browser test), sortable headings expose `aria-sort`, charts have descriptive labels and keyboard operation, tiles use two columns on a phone, bucket cards stack, and charts draw at their real width.

**Verification**
- `windowsapp/src/deepDiveStats.test.ts` (11, hand-computed): bar-bucket boundaries and per-bucket results incl. a bucket with no P&L %, interpolated quantiles, capital thirds with inclusive edges and the too-few/no-spread cases, half-hour and weekday buckets, quick-loss counts and share (unknown-bar losers excluded), scatter points and recency, sorting with missing values last. vitest total 380.
- `scripts/habits-browser-check.mjs` extended with independent expectations: opening from the scorecard link, tiles, the bars/capital/time/weekday tables (counts, edge labels), the quick-loss sentence, scatter dot count, Enter on a dot → cycle drawer request, trade list order and sorting, Open, switching to the archived habit, the accessibility floor in four sections, and the 390 px phone layout. Desktop workflow script, `phase20-browser-check.mjs` and the whole webapp suite (23) still pass; all three TypeScript checks pass.

### 10.11 Glossary of Habits statistics
| Term | Meaning |
|---|---|
| Habit | A behavior question you mark yes/no on a trade (Entry or Exit type). |
| Trade | One closed round trip. A trade can carry several habits. |
| P&L % | Net result ÷ the session's capital. Profit %, loss % and net % add these over trades. |
| Net / Profit / Loss | Sum of all / of winning / of losing trades of the habit. A win or loss is a net result beyond ±₹0.005. |
| Average per trade | Mean or median (header switch) result of a habit trade. |
| vs without | Typical habit trade minus typical trade without the habit, same period and filters. |
| If skipped | −Net: what you would have gained (positive) or given up by not taking the habit's trades. |
| Share of losses / profits | Part of all losing / winning % in scope from the habit's trades; habits overlap, so shares can exceed 100% in total. |
| Capital % | Capital deployed on the trade (all entries together) as % of session capital; unavailable for older/imported fills. |
| Risk % | Capital at risk at entry (distance to stoploss), same basis. |
| Bars held | Candles the trade touched (3-minute strategy candles unless the entry recorded another size); entering and exiting inside one candle is 1 bar. |
| ≤1 / ≤2 bars | Share of the habit's trades closed within one / two candles. |
| Losers ≤1 bar | Share of losing trades closed within one candle. |
| Verdict | Costly (net < 0 and a worse average than the other trades), Rewarding (net > 0 and a better average), Mixed, Low sample (< 10 trades). Means, % of capital (₹ if no trade has a P&L %). |
| Trend flag | Improving / Worse / Mixed / Same / Too few trades from loss per day, frequency and capital % between two periods (§10.9). |
| Idle habit | An active habit with no trade in the current filters. |
| Unmatched marks | Marks in the date/symbol scope that no loaded trade matches (filtered out by a trade-level filter, or the broker day was re-synced). |

## 11. Hardening and close-out (Sprint 8)

### 11.1 Results

| Suite | Result |
|---|---|
| Backend `pytest tests/` | 2840 passed, 3 failed — the same 3 swing tests that fail on unchanged `origin/dev` (listed in §4) |
| `windowsapp` vitest | 384 passed (52 files) |
| `cargo test --lib` | 23 passed |
| `tsc --noEmit` | frontend, windowsapp, webapp clean |
| Browser scripts | `habits-browser-check`, `website-label-trades-check` (both renderers), `website-live-label-check`, `desktop-live-label-check`, `phase20-browser-check` pass; `desktop-analysis-workflows` passes except its snapshot-time assertion, which already fails on unmodified `dev` |
| webapp Playwright suite | 23 passed (after `scripts/build-frontend-with-webapp.sh`) |

### 11.2 Code-review fixes made in this sprint

- **Label tracking was reset on every pause/resume (website, pre-existing).** `App.tsx` called `resetLabelTracking()` whenever the session state became `running`, so resuming a paused replay cleared pending exit labels and restarted round-trip numbering at 0; later trades then overwrote earlier labels and behavior marks. It now resets only when a different `sessionId` becomes active (`shouldResetLabelTracking`).
- **Reloaded/resumed sessions keep their numbers.** On activation, `useSimulation` seeds the indexer from the session's existing trades (`seedFromTrades`), so an open leg keeps the number the backend gave it and new trips continue from the right counter.
- **Reversal through zero** (long to short in one fill) closes the old trip and opens a new one in the indexer, matching `build_cycles`, which splits such a cycle.
- **Ledger:** session records are fetched with chunked `batch_get_item` (100 keys, `UnprocessedKeys` retried, then an error rather than a silent gap); swing scope returns an empty ledger; the cycle load is forced to own intraday sessions.
- **Marks API:** `answers` is bounded to 100 entries.
- **Ledger response** is gzipped when larger than 64 KiB and the client accepts it.

### 11.3 Habits reconciliation and performance

- Automated: for 12 filter combinations, ledger totals (trades, net P&L, wins/losses) equal `GET /api/analysis/performance` summary values, and the ledger rows equal the cycles list for the same filters.
- Benchmark (`scripts/habit-ledger-benchmark.py`, moto, 250 sessions / 5,000 trades / 769 marks): Stats overview read 10.1 s, Habit ledger 10.5 s, building the ledger without I/O 1.4 s; the ledger adds essentially nothing to the cost of the existing Stats overview because both use `load_cycles`. Response 1 MiB for 2,500 rows (418 B/row), which gzip shrinks substantially. **No cache was added**: the dominant cost is the shared `load_cycles` path (about 750 DynamoDB requests on moto), not the habit join; caching belongs to that path if Stats itself becomes slow on real history.

### 11.4 Known limitations

- Marks are keyed `(session_id, round_trip_index)`; if a real broker book is re-synced and trips renumber, existing marks can point at a different trade. Habits reports these as unmatched marks where the trade no longer exists but cannot detect a shifted match.
- Website in-session numbering tracks one open trip per leg (equity, CE, PE). Two open strikes of the same right share one leg.
- Swing portfolios are out of scope (labels there use `label_index`).
- `GET /api/behavior/stats` and `/marks/by-question` remain available but are not used by the UI (Habits uses the ledger).
- No price-path statistics (time in profit, best price reached); that behavior is tracked by manual marking.

### 11.5 Porting to preprod / main

Strategy (per `CLAUDE.md`): `dev` gets the new features; `preprod` is where everything, real trading included, is known to work and where bug fixes are made; once tested there it goes to `main`. Working `dev` changes are merged into `preprod` with a merge commit, and in the worst case only up to an earlier `dev` commit (`git merge <sha>`), never by squashing or piecemeal cherry-picks.

Phase 23 landed on `dev` as one merge commit per sprint, so there are natural cut points: the merges of PRs #752–#761 (Sprints 1–7d) and #762 (Sprint 8). Merge up to the last sprint that passes your acceptance run; later sprints stay on `dev`. Before each merge run `bash scripts/check-preprod-synced.sh`. Phase 23 touches shared settings files and the dev-only KLine Analysis charts, and `dev` currently has the unexplained chart-stops-updating issue noted in `CLAUDE.md`, so choose the cut point deliberately and test live labeling in a real session on `preprod` before it reaches `main`.

Real-trading-relevant items to test there: desktop real-session label state, real-day alias handling in the Habits ledger, and the live-labeling popups.

**Bug fix for `preprod`:** the pause/resume label-tracking reset (§11.2) also exists on `preprod` (`App.tsx` resets on every `running`). By the branch rules it should be fixed on `preprod` first and synced into `dev`; it is currently only fixed on `dev`.

### 11.6 Manual acceptance

See [phase23-manual-acceptance.md](phase23-manual-acceptance.md).

## Appendix — original requirement text (free hand, as written)

> ## Analysis Label Trade
> Want to reformat the look of Label Trades section in the Analysis in both desktop and website and webapp. Instead of showing all of the trades one by one. Right panel will have the trades and place to enter strategy and category and left panel would have the chart to show the buy and sell points like it has now.
>
> Only difference is we will have a next and prev button. Which is markers will appear on left panel for each round trip trade and right panel would have category and strategy options to fill same it has now, but only for the trade in question. User keeps on pressing next and next and enters the information. When a particular trade is viewed, its markers would be present in all the charts, all option strike prices and Underlying.
>
> If needed we can have a setting in Analytics tab whether to see all trades together or one by one for labelling.
>
> ## Manual Behaviorial Analysis
> This requirement, is for user to specifically rank or label a day's trading session, as to how many times a particular behavior was demonstrated. So, lets say the behavior is, :- Trade went into profit stayed in profit for 1 bar and then exited at a loss. After trading is done, user can manually label how mnay times or for how many trades he did this. This information is recorded and showed in stats, a line graph against days for the number of times value per day.
>
> This requirement will have 3 sections:-
> 1. A place where user writes their behavior questions. These questions would be showed back to the user per trade and user can increase the counter for it or not. As we go along more questions can be added or archived. Archived questions for historical storage purposes. User only labels or increases counter for active questions.
> 2. User labeling or increasing counter for the active question per trade. User can increase this counter during live trading just as user can label category and strategy during trade. So, 2 places, option to label trades would be present. a) During live trading, b) In Analysis Tab. Now, if the next and previous round trip trade view and label is chosen, when user chooses a round trip they enter cateory and strategy and then choose the active question or all active questions are listed and then user just presses a button to signify this trade displayed this behavior. At the end the total count of trades where a particular behavior is recorded may be also at trade level is recorded and showed in stats. If next and previous is not there, then right panel will have 2 tabs, category and strategy labeling and behavior labeling, with same info of trade round trip at top and then choosing question and whether to label this trade followed it or not.
> 3. Stats:- Once these behavior labels are recorded, stats can show them in behavior tab or a seperate tab, but main point for user is improve is the count increase or decreases per trading day to ascertain that behavior has changed. So, a line chart with time x axis is preferencial or may be you can use some other better way to plot.
>
> For user labeling behavior during live trading session, just add a drop down menu of active question and ability to select this trade demonstracted or not, to the actual category and strategy recording popup, that is when the trade is finished. User can better label after round trip is finished.
>
> Or better yet, user can have 2 separate type of behavior questions, entry and exit questions. Entry question are asked when expected strategy is entered, and exit questions are displayed when expected strategy is entered during trading popups, when the trade is selecte don right panel in website and left panel in desktop.
>
> Follow-up from the user: behavior labeling during trading must cover replay, paper and real (stepwise optional); Analysis Label Trades applies to all trade types.
