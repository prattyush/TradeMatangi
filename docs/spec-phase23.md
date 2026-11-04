# Phase 23 — Label Trades one-by-one + Manual Behavioral Analysis

**Status: In progress** (Sprint 0 — documentation). Implementation plan and sprint table: [spec-phase23-implementation-plan.md](spec-phase23-implementation-plan.md).

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
3. **Stats** — a new **Habits** view in the Stats dashboard: a line chart of the number of trades per trading day that showed each behavior, so the user can see whether a behavior is decreasing. Click-through lists the flagged trades.

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
- **Habits**: multi-series line chart per question over trading days (zero-filled from the dashboard's trading days), legend toggles, summary table with last 7 days vs prior, drill-down list.

## 4. Implementation status

| Sprint | Scope | Status |
|---|---|---|
| 0 | Docs and scaffolding | PR #751 |
| 1 | Backend foundation | Implemented (this PR): tables, service, router, setting, cleanup/maintenance/setup script, 27 new tests; full backend suite 2830 passed, 3 failed (the same 3 swing tests fail on unchanged `origin/dev`: `test_swing_api::test_exact_contract_lot_validation_and_invalid_master_do_not_create_context`, `test_swing_paper_runtime::test_expiry_quote_closes_paper_option_without_closing_equity_context`, `test_swing_stream_valuation::test_last_known_paper_valuation_survives_restart_without_executing_orders[True]`) |
| 2 | Desktop transport and real labels | Merged (PR #753) — see §5 |
| 3 | Analysis one-by-one core | Merged (PR #754) — see §6 |
| 4 | Charts, responsive and webapp | Merged (PR #755) — see §7 |
| 5 | Behavior questions manager + Analysis marks | Implemented (this PR) — see §8 |
| 6 | Live labeling | Not started |
| 7 | Habits stats | Not started |
| 8 | Hardening and close-out | Not started |

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

## 8. Behavior questions manager and Analysis marks (Sprint 5)

**Where the manager lives** — one shared component, `shared/analysis/behavior/BehaviorQuestionsManager.tsx`, with the API injected (`BehaviorApi`):
1. **Settings → Analytics → Behavior questions** on the website/webapp (`SettingsModal.tsx`) and on desktop (`DesktopSettingsModal.tsx`, using `createDesktopBehaviorApi` over the desktop trading routes). Permanent home.
2. **Analysis → Label Trades → "Manage questions"** (modal, both views, all clients); closing or changing it reloads the checklists.
3. (Sprint 6) the live labeling popups; (Sprint 7) Stats → Habits.

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
