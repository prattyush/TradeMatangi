# Phase 26 — Implementation plan (Patterns Strategy Deep Dive)

Approved 2026-11-16. Source of truth for sprint order; update the status column as sprints merge. Spec: `docs/spec-phase26.md` (owner draft).


## Context

Today the Pattern Library lets the owner mark a strategy (category + strategy) on single-day charts. It says nothing about *how often* a setup behaves a certain way. Phase 26 adds a **Deep Dive** on one strategy at a time so the owner can understand a setup in detail:

1. Pick a category + strategy, then mark on a calendar the days the setup occurred, each as **Buy**, **Sell** or **both** (spec: `docs/spec-phase26.md`, untracked owner draft, never commit it unless asked).
2. Walk the marked days one by one (underlying chart + the matching CE/PE chart), mark the setup on the charts, answer **yes/no questions** ("did the breakout have a second leg?"), and flag the day **success / failed**.
3. Questions grow as the owner goes. Gaps (a question added on the 20th is unanswered on the 11th) must be visible.
4. The answers become **frequency %**, shown (a) in a Deep Dive results view, (b) next to the Expected Pattern selector **during trade labelling, with most value in live sessions** (replay, stepwise, paper, real), and also in post-analysis Label Trades.
5. Patterns view should also use the strategies the owner already labels on trades: show **actual traded Buy/Sell on the 3-min bars** with a clear "traded" differentiator; the owner may edit and **save them as pattern annotations**.
6. Minor: Max Price strike search window 30 → 50 strikes (spec item 2 is blank, treated as a leftover).

### Decisions made with the owner
| # | Decision |
|---|---|
| D1 | Hosts: **Windows desktop (KLine only)** and **website + webapp (Lightweight and KLine, per the existing Analysis chart renderer setting)**. Phone gets only the read-only frequency panel in Label Trades (it shares that form). |
| D2 | Questions are per **category + strategy**, shared by Buy and Sell; each answered day carries its side so stats can be filtered Buy / Sell / All. |
| D3 | **Soft block**: Next/Prev always works; day status, banner and a "Needs answers" panel show every gap. |
| D4 | Frequency % shown in **label forms on all hosts and in live popups** (website `PendingLabelPanel` / `StepwiseLabelPopup`, desktop `DesktopLabelPopup`), auto-filtered by trade side (CE = Buy setup, PE = Sell setup) with an "All" toggle. |
| D5 | Deep-dive marks live in their own record; a **"Save to Pattern Library"** button copies them into `PatternAnnotations` (the spec's Extension). |
| D6 | Symbols and strikes same as Patterns today: Max Price (NIFTY, BSESEN) or OTM at 09:30, strikes saved per setup. |
| D7 | 30 → 50 strikes applies **everywhere** (Patterns, Browse, phone, session start). |
| D8 | Percentages: per question over the days where that question was answered, **n shown**; success rate over days with an outcome; fewer than 5 days shows a "few days" warning. |
| D9 | Deep Dive data is **shared read-only** with the Pattern share list (`pattern_share_emails`), like pattern charts. Writes owner-only. |
| D10 | Pattern view lists strategies coming from **labelled trades** (expected or actual) and draws the **actual Buy/Sell** on the bars, visibly different from marked patterns; editable, then saved as annotations. |

## Existing code to reuse (found in exploration)

- **Strategy registry:** `PatternNames` (`backend/app/services/pattern_logger_service.py` `add_name`, `register_annotation_names`, `_list_names`); UI `shared/analysis/PatternNameSelect.tsx`. Strategies are plain name strings; deep-dive keys use `category::strategy` exactly like `risk_reward_ratios`.
- **Pattern charts:** `PatternAnnotations`, routes in `backend/app/routers/pattern_logger.py`; marker model `PatternAnnotation`, `buildMarkers`, `MARKER_COLORS` in `shared/analysis/patternMarkers.ts`; `toggleAnnotation` / `TOOL_OPTIONS` (six tools).
- **Question model to copy:** `backend/app/services/behavior_service.py` (lazy `ensure_*_table`, archive not delete, case-insensitive unique text, ≤40 active, ≤140 chars) and `shared/analysis/behavior/*` (injectable `BehaviorApi`, `model.ts`, saver classes in `labeling/saver.ts`). Gaps: Behavior stores only "yes" and has no "unanswered", so Deep Dive needs its own answer map.
- **Charts:** desktop KLine `shared/analysis/kline/AnalysisChart.tsx` (props `pickMode`, `onPick`, `annotations`); desktop wrapper `windowsapp/src/tools/PatternLibrary.tsx`, `patternLibraryModel.ts` (`resolveStrikes`, `ExtraPane`), `usePatternsRuntime.ts`; strike rules `frontend/src/patternStrikes.ts` (`patternStrikeRule`, `otmStrikes`, 09:30 Max Price time); website lightweight `ChartPane` inside `frontend/src/pages/PatternLibrary.tsx` (needs extraction); website KLine path `withWebsiteAnalysis` in `frontend/src/services/analysisEnvironment.tsx` + `useAnalysisChartRenderer`.
- **Calendar basis:** `frontend/src/components/browse/BrowseCalendar.tsx` + `monthGrid`, `shiftMonth`, `pickableDay` in `frontend/src/services/browseWorkspace.ts`; trading-day stepping in `shared/browse/browseModel.ts`; backend `app/utils.py:is_trading_day`.
- **Transport:** `backend/app/routers/desktop_patterns.py` auto-mirrors routers under `/api/desktop/v1/patterns/...`; allowlist copies in `windowsapp/src-tauri/src/lib.rs` (`valid_patterns_path`), `windowsapp/src/patternsApi.ts` (`ALLOWED`), parity tests (`patternsApi.test.ts`, cargo `patterns_allowlist_is_exact_and_method_scoped`), `backend/tests/test_desktop_patterns.py`.
- **Labels:** `TradeLabels` (PK `session_id`, SK `round_trip_index`, GSI `UserIdDateIndex`), `trade_label_service.get_stats` (already groups by expected category/strategy), round-trip builder `build_cycles`; label form `shared/analysis/labeling/RoundTripLabelForm.tsx`.
- **Analysis allowlist (3 copies)** for routes the label forms call: `backend/app/routers/desktop_analysis.py`, `windowsapp/src/analysisApi.ts` (`validAnalysisPath`), `lib.rs` (`valid_analysis_path`); the phone imports the same allowlist.

## Data model (new, lazy `ensure_*` + `scripts/setup-dynamodb-tables.py` + `docs/architecture-backend.md`)

**`DeepDiveSetups`** — one item per *symbol + day + side*.
- PK `user_id`, SK `{category}::{strategy}#{date}#{symbol}#{side}` (side `buy|sell`). One query `begins_with` loads a whole dive.
- Attributes: `category`, `strategy`, `symbol`, `date`, `side`, `strike_ce`, `strike_pe`, `strike_mode`, `interval_minutes` (default 3), `annotations` (JSON, same item shape as `PatternAnnotation`), `outcome` (`success|failed|null`), `answers` (map `question_id → bool`; absent = unanswered), `notes`, `created_at`, `updated_at`.
- A day with both sides = two items; order is date ascending, buy before sell.

**`DeepDiveQuestions`** — PK `user_id`, SK `{category}::{strategy}#{question_id}`. Attributes `text` (≤140), `status` (`active|archived`), `sort_order`, `created_at`, `archived_at`. Never hard-deleted (answers survive); archived questions stop counting. Case-insensitive unique among active per dive, ≤40 active.

No separate dive table: a dive exists when it has setups or questions. Sharing reads through `get_accessible_owner_ids`.

## Backend (`backend/app/routers/deep_dive.py`, prefix `/api/deep-dive`; service `deep_dive_service.py`)

| Route | Purpose |
|---|---|
| `GET /dives` | list dives (own + shared) with day counts, question counts, incomplete counts |
| `GET /dive?category&strategy&owner_id?` | setups + active questions + gap matrix |
| `PUT /setup` | upsert a setup (day, side, symbol, strikes, annotations, outcome, notes); validates trading day, symbol, side; removing a side deletes its item |
| `DELETE /setup` | remove a marked day/side (UI confirms; answers go with it) |
| `PUT /setup/answers` | set/clear answers `{question_id: true|false|null}` via `SET answers.#q` (atomic, idempotent) |
| `POST /questions`, `POST /questions/{id}/update|archive|restore` | question CRUD |
| `GET /stats?category&strategy&side?&owner_id?` | frequency stats |
| `GET /stats/all` | stats for every dive, small payload, for the label-form panel |
| `POST /setup/save-to-patterns` | copy marks into `PatternAnnotations` via existing create/update (merge if a chart exists for that symbol/day; returns the chart id) |

**Stats** (pure function `compute_stats`, unit-tested): per active question `yes`, `answered`, `pct`; `success`, `with_outcome`, `success_pct`; `days`, `buy_days`, `sell_days`; `fewDays` flag when `answered < 5` (D8). Filter by side.

**Writes** require `owner == self`; reads accept `owner_id` validated against accessible owners. In label forms: own stats win, else the first sharing owner with data, labelled with the owner.

**Desktop mirror:** add `deep_dive` to the adapt loop in `desktop_patterns.py` → `/api/desktop/v1/patterns/deep-dive/...`; add path shapes to `valid_patterns_path` (Rust) and `ALLOWED` (TS), extend both parity tests and `test_desktop_patterns.py`. For label forms, add read-only `deep-dive/stats/all` to the **analysis** allowlist (3 copies); for the live desktop popup prefer attaching the stats to the existing `trading/trade-labels/metadata` response (fetched when the popup opens) so the trading allowlist and real-trading routes gain no new path. Verify in the sprint; fall back to one read-only trading route if needed.

## Frontend design

### Shared module `shared/deepdive/` (host-agnostic, injectable `DeepDiveApi` like `BehaviorApi`)
- `model.ts` (pure): types, setup ordering, `gapMatrix(setups, questions)`, day completeness, navigation, stats formatting, "n=" labels, few-days warning. Tests go in `windowsapp/src/deepDive.test.ts` (vitest include only covers `windowsapp/src` and `shared/games`).
- Components: `DeepDiveHome`, `DateMarkingStep` + `DiveCalendar`, `InDepthStep` (day strip, questions panel, outcome toggle, gaps panel), `ResultsView`, `StatsPanel` (compact, reused in label forms), `TradedStrip`.
- Hosts inject the chart panes: desktop → KLine `DesktopAnalysisChart`; website → Lightweight pane or KLine per `useAnalysisChartRenderer`.

### UX flow
0. **Home** (new third tab "Deep dive" next to Annotate / Saved charts on desktop and website): list of dives; "Start deep dive" = `PatternNameSelect` (category + strategy, add new) + symbol.
1. **Mark dates**: multi-month calendar (scroll back to a year), weekends/holidays disabled, each day cycles None → Buy → Sell → Both (or a small popover); a side panel with the selected day's **underlying chart preview** (interval selector) so the owner can verify; marked-days list with counts. Autosaves.
2. **In-depth**: header `3 / 12 · 11 Mar · BUY`, Prev/Next, a **day strip** coloured complete / incomplete / "new question". Left: underlying chart + the matching option chart (Buy → CE, Sell → PE; index symbols only, equities get the underlying only), strikes resolved once (Max Price or OTM 09:30 via the existing resolvers) and saved; the six marker tools with the strategy fixed to the dive's. Right: outcome (success / failed), Yes/No/clear per question, "Add question", archive, notes. **Banner** on the current day when unanswered; **"Needs answers" panel** lists every day with the number missing, click to jump. Adding a question shows how many earlier days it leaves unanswered.
3. **Results**: per-question bars with `yes/answered (n)` and few-days warning, success rate, Buy/Sell/All filter, per-day table (date, side, outcome, answer dots); click a row to reopen the day read-only; "Save to Pattern Library".

### Frequency panel in labelling (D4)
- Component `StatsPanel` shown under the Expected Pattern row when a strategy with data is selected: top questions with %, success %, n, side toggle defaulting to the trade side. Silent when no data.
- **Post-analysis:** shared `RoundTripLabelForm` (website, webapp, desktop, phone).
- **Live:** `frontend/src/components/PendingLabelPanel.tsx`, `StepwiseLabelPopup.tsx`, `windowsapp/src/App.tsx` (`DesktopLabelPopup`). Rules (real-trading path, per the manual-override philosophy): purely additive, read-only, fetched once when the popup opens with a short timeout, failure or empty data renders nothing, **never delays or blocks Save**, no change to label payloads.

### Patterns view from labelled trades (D10)
- New backend `traded_patterns_service` + route `GET /api/pattern/traded?category&strategy&from&to`: query `TradeLabels` via `UserIdDateIndex`, keep rows where expected or actual matches, resolve entry/exit time, price, direction, instrument (CE/PE, strike) from the round-trip builder for each session (cached per session). The first sprint step is a feasibility check on cost for many sessions and real-session snapshots.
- Pattern view (Saved charts) gets a "From labelled trades" list. Opening one draws **Buy/Sell markers at the actual entry/exit bars** (hollow or dashed with a "traded" tag and a legend that says it is the actual trade, not an ideal marked pattern), expected vs actual shown. **"Edit & save as pattern"** converts them into `PatternAnnotation` marks (editable) and saves through the normal chart create route. Also shown in Deep Dive day view when the owner traded that day.

## Sprints (each = branch off `origin/dev`, PR into `dev`, merge commit, docs updated inside the PR)

| Sprint | Scope | Tests | Exit |
|---|---|---|---|
| **S0** Docs | `docs/spec-phase26-implementation-plan.md` (from this plan), `docs/phase26-manual-acceptance.md` skeleton, `docs/todo.md`, memory. Spec draft stays untracked unless the owner asks. Docs go straight to `dev`. | n/a | Plan doc on `dev` |
| **S1** Max Price 30 → 50 (**in PR**) | `desktop_preparation.py` (`range(30)`, message "within 30 strikes", docstring), `options_service.py` `_MAX_SCAN_INTERVALS`; update the tests asserting 30 (`test_desktop_preparation.py`, `test_fetch_patterns_script.py`, `test_minute_ohlc.py`, `test_reselect_strike.py`, `pattern-library.spec.ts`, `browseModel.test.ts`, `browse.spec.ts`), the comment and `MAX_PRICE_TIMEOUT_MS` check in `BrowseScreen.tsx`, docs (`live-history-providers.md`, `architecture-phone.md`, `spec-phase24.md`, `phase24-manual-acceptance.md`). `scripts/fetch-patterns-data.py` `MAX_PRICES` are rupee caps, not strike counts: leave. | backend suite | scan stops at the first hit; cold worst case measured and noted |
| **S2** Backend core | tables, service, router, stats, sharing, save-to-patterns, desktop mirror, Rust + TS allowlists and parity tests, setup script, architecture-backend | new `test_deep_dive.py` (moto): CRUD, side validation, answers map, gap matrix, stats incl. few-days, sharing read-only, archive; `test_desktop_patterns.py`; cargo; `patternsApi.test.ts` | routes exposed on both transports |
| **S3** Shared model + API client | `shared/deepdive/model.ts`, `api` type + website client in `services/api.ts`, desktop `patternsClient` methods | `windowsapp/src/deepDive.test.ts` | pure logic fully tested |
| **S4** Desktop: Home + date marking | third tab, calendar, underlying preview, autosave | model tests + SSR render smoke | owner can mark days on desktop (rebuild needed) |
| **S5** Desktop: in-depth analysis | charts, marks, questions, outcome, gaps panel, strikes | model tests + browser script | full walk of a dive |
| **S6** Desktop: results + save to patterns | results view, filters, save-to-pattern | model tests | Deep Dive complete on desktop |
| **S7** Website/webapp: Deep Dive | extract `ChartPane` from the 1629-line page into a reusable file (minimal edit to `PatternLibrary.tsx`), mode `'deepdive'`, home/calendar/analysis/results with Lightweight and KLine | Playwright harness `frontend/tests/phase22`, `webapp/tests`, `tsc --noEmit` | parity with desktop on both renderers |
| **S8** Frequency in post-analysis forms | `stats/all` route on analysis allowlists (3 copies), `StatsPanel` in shared `RoundTripLabelForm`; phone inherits | vitest, `mobile` typecheck/tests | % appear in Label Trades on all hosts |
| **S9** Frequency in live popups | `PendingLabelPanel`, `StepwiseLabelPopup`, `DesktopLabelPopup`; stats in `trade-labels/metadata` on desktop | popup tests, `scripts/website-live-label-check.mjs`, `desktop-live-label-check.mjs`, replay + stepwise runs | panel visible in replay/stepwise/paper/real; save never delayed. **Dev only; never to `preprod` without the owner's real-session try** |
| **S10** Traded patterns in Pattern view | backend route + service, "From labelled trades" list, traded markers, edit and save as annotations; both hosts | backend tests, model tests, browser checks | owner can see/convert actual trades into pattern annotations |
| **S11** Hardening | empty/error states, few-days wording, performance of big dives, accessibility, acceptance doc final, `CLAUDE.md` Phase 26 row, architecture docs, memory | full suites | owner acceptance list ready |

Order rationale: S1 is independent and small; S2 unblocks everything; desktop-first (S4–S6) gives the owner a usable Deep Dive early; website (S7) reuses the shared module; S8–S9 deliver the live value; S10 is the largest independent piece and may slide.

## Risks and real-trading touch points
| File | Change | Risk |
|---|---|---|
| `desktop_preparation.py`, `options_service.py` | scan 30 → 50 | Medium: used by session start (`prepare`) and strike re-select; latency worst case grows |
| `PendingLabelPanel.tsx`, `StepwiseLabelPopup.tsx`, `windowsapp/src/App.tsx` | additive read-only panel | High-care: real-trading screens, three duplicated components |
| `windowsapp/src-tauri/src/lib.rs` | allowlist entries | Medium: needs a desktop rebuild and cargo parity tests |
| `frontend/src/pages/PatternLibrary.tsx` | extract chart pane, new mode | Low-medium: large page, minimal diff |
| `shared/analysis/labeling/RoundTripLabelForm.tsx` | panel slot | Low: shared by all hosts |

Rules observed: no merge of `dev` into `preprod`; no revert of merges; run `bash scripts/check-preprod-synced.sh` before any promotion; PRs into `dev` with merge commits.

## Edge cases to handle
Weekend/holiday days (calendar + server validation); day without data (chart shows "no data", day stays markable); equity symbols without options (underlying only); Both sides on one day (two items, buy first); question added mid-way (gap matrix); question archived (drops from stats, answers kept); un-marking a side (confirm, deletes answers); strike changes (saved per setup, changes only on explicit re-pick); existing pattern chart on save-to-patterns (merge with confirm); shared viewer (read-only UI, no edit controls); label with a strategy that has no dive (panel hidden).

## Verification
- Backend: `cd backend && source ~/venvs/tradematangi/bin/activate && python -m pytest tests/ -v` (moto tables, no DynamoDB Local needed for the new tests; 17 `test_auth.py` tests need it).
- Desktop: `cd windowsapp && npm run build && npm test`; `cd windowsapp/src-tauri && cargo test`; rebuild the desktop app for Rust changes.
- Website: `cd frontend && node node_modules/typescript/bin/tsc --noEmit`; Playwright `npm run test:charts`; `bash scripts/build-frontend-with-webapp.sh` then `cd webapp && npm test`.
- Phone: `cd mobile && npm run typecheck && npm test`.
- End to end by hand (`docs/phase26-manual-acceptance.md`): start the stack (`scripts/start-backend.sh`, `scripts/start-frontend.sh`), mark 4–5 days (one with both sides), answer, add a question on day 3 and confirm earlier days flag, check results %, open Label Trades and a replay/stepwise label popup and see the % for that strategy, check a shared account read-only, check Pattern view traded markers.

## Open points to confirm during build (no action needed now)
1. Whether the owner wants the spec draft committed (untracked now).
2. The 3-min bar interval for traded markers when the owner's pattern chart used another interval (use the pattern's saved `interval_minutes`, else 3).
3. S10 cost on many real-session snapshots; fall back to a stored entry/exit time on labels if the round-trip rebuild is too slow.

## S1 as built (2026-11-16)

- `desktop_preparation.MAX_PRICE_SCAN_STRIKES = 50` drives `find_max_price_strike` (the minute scan behind Patterns, Browse, phone and `prepare-session`); the error text is built from it ("within 50 strikes"). `options_service._MAX_SCAN_INTERVALS = 50` (the legacy second-level scan, which still falls back to ATM on a miss).
- Tests: new `test_scan_reaches_the_fiftieth_strike_and_stops_there`; the call-count test is tied to the constant; message assertions updated in backend, `frontend/tests/phase22`, `mobile` unit and UI tests. Backend suite: 3497 passed (the 17 `test_auth.py` tests need DynamoDB Local).
- `BrowseScreen.tsx` comment updated; `MAX_PRICE_TIMEOUT_MS` (120 s) kept: Browse scans minute candles, and the scan stops at the first qualifying strike, so only a miss pays for all 50. Check a cold-cache miss on the phone during acceptance.
- Docs: `live-history-providers.md`, `architecture-phone.md`, `phase24-manual-acceptance.md`. `spec-phase24.md` describes the earlier state and is left as history.
