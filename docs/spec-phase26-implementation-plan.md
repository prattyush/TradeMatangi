# Phase 26 — Implementation plan (Patterns Strategy Deep Dive)

Approved 2026-11-16. Source of truth for sprint order; update the status column as sprints merge. Spec: `docs/spec-phase26.md` (owner draft).


## Context

Today the Pattern Library lets the owner mark a strategy (category + strategy) on single-day charts. It says nothing about *how often* a setup behaves a certain way. Phase 26 adds a **Deep Dive** on one strategy at a time so the owner can understand a setup in detail:

1. Pick a category + strategy, then mark on a calendar the days the setup occurred, each as **Buy**, **Sell** or **both** (spec: `docs/spec-phase26.md`, the owner's requirement draft; committed to `dev` on 2026-11-17 with the status and what was built under each point).
2. Walk the marked days one by one (underlying chart + the matching CE/PE chart), mark the setup on the charts, mark **tags** valid or not valid ("second leg", "reversed by double top"), and flag the day **success / failed**.
3. Tags grow as the owner goes. Gaps (a tag added on the 20th is unmarked on the 11th) must be visible.
4. The tag marks become **frequency %**, shown (a) in a Deep Dive results view, (b) next to the Expected Pattern selector **during trade labelling, with most value in live sessions** (replay, stepwise, paper, real), and also in post-analysis Label Trades.
5. Patterns view should also use the strategies the owner already labels on trades: show **actual traded Buy/Sell on the 3-min bars** with a clear "traded" differentiator; the owner may edit and **save them as pattern annotations**.
6. Minor: Max Price strike search window 30 → 50 strikes (spec item 2 is blank, treated as a leftover).

### Decisions made with the owner
| # | Decision |
|---|---|
| D1 | Hosts: **Windows desktop (KLine only)** and **website + webapp (Lightweight and KLine, per the existing Analysis chart renderer setting)**. Phone gets only the read-only frequency panel in Label Trades (it shares that form). |
| D2 | **Tags** (renamed from "questions" on 2026-11-16: "does every opening breakout reversal have a double top" is an attribute of the setup, not a question) are per **category + strategy**, shared by Buy and Sell. On each day a tag is **Valid** (yes), **Not valid** (no) or **unmarked** (not looked at yet); each marked day carries its side so stats can be filtered Buy / Sell / All. |
| D3 | **Soft block**: Next/Prev always works; day status, banner and a "Needs marking" panel show every gap. |
| D4 | Frequency % shown in **label forms on all hosts and in live popups** (website `PendingLabelPanel` / `StepwiseLabelPopup`, desktop `DesktopLabelPopup`), opening on **Buy, Sell or All**: Buy and Sell come from the position's direction (long equity = Buy, short = Sell; CE bought = Buy, PE bought = Sell; selling flips both, so a short CE = Sell and a short PE = Buy), with a toggle to switch to the other side or All. |
| D5 | Deep-dive marks live in their own record; a **"Save to Pattern Library"** button copies them into `PatternAnnotations` (the spec's Extension). |
| D6 | Symbols and strikes same as Patterns today: Max Price (NIFTY, BSESEN) or OTM at 09:30, strikes saved per setup. |
| D7 | 30 → 50 strikes applies **everywhere** (Patterns, Browse, phone, session start). |
| D8 | Percentages: per tag over the days where that tag was marked (valid or not valid), **n shown**; success rate over days with an outcome; fewer than 5 days shows a "few days" warning. |
| D9 | Deep Dive data is **shared read-only** with the Pattern share list (`pattern_share_emails`), like pattern charts. Writes owner-only. |
| D10 | Pattern view lists strategies coming from **labelled trades** (expected or actual) and draws the **actual Buy/Sell** on the bars, visibly different from marked patterns; editable, then saved as annotations. |

## Existing code to reuse (found in exploration)

- **Strategy registry:** `PatternNames` (`backend/app/services/pattern_logger_service.py` `add_name`, `register_annotation_names`, `_list_names`); UI `shared/analysis/PatternNameSelect.tsx`. Strategies are plain name strings; deep-dive keys use `category::strategy` exactly like `risk_reward_ratios`.
- **Pattern charts:** `PatternAnnotations`, routes in `backend/app/routers/pattern_logger.py`; marker model `PatternAnnotation`, `buildMarkers`, `MARKER_COLORS` in `shared/analysis/patternMarkers.ts`; `toggleAnnotation` / `TOOL_OPTIONS` (six tools).
- **Tag model to copy (it was the question model):** `backend/app/services/behavior_service.py` (lazy `ensure_*_table`, archive not delete, case-insensitive unique text, ≤40 active, ≤140 chars) and `shared/analysis/behavior/*` (injectable `BehaviorApi`, `model.ts`, saver classes in `labeling/saver.ts`). Gaps: Behavior stores only "yes" and has no "unmarked", so Deep Dive needs its own tag-value map.
- **Charts:** desktop KLine `shared/analysis/kline/AnalysisChart.tsx` (props `pickMode`, `onPick`, `annotations`); desktop wrapper `windowsapp/src/tools/PatternLibrary.tsx`, `patternLibraryModel.ts` (`resolveStrikes`, `ExtraPane`), `usePatternsRuntime.ts`; strike rules `frontend/src/patternStrikes.ts` (`patternStrikeRule`, `otmStrikes`, 09:30 Max Price time); website lightweight `ChartPane` inside `frontend/src/pages/PatternLibrary.tsx` (needs extraction); website KLine path `withWebsiteAnalysis` in `frontend/src/services/analysisEnvironment.tsx` + `useAnalysisChartRenderer`.
- **Calendar basis:** `frontend/src/components/browse/BrowseCalendar.tsx` + `monthGrid`, `shiftMonth`, `pickableDay` in `frontend/src/services/browseWorkspace.ts`; trading-day stepping in `shared/browse/browseModel.ts`; backend `app/utils.py:is_trading_day`.
- **Transport:** `backend/app/routers/desktop_patterns.py` auto-mirrors routers under `/api/desktop/v1/patterns/...`; allowlist copies in `windowsapp/src-tauri/src/lib.rs` (`valid_patterns_path`), `windowsapp/src/patternsApi.ts` (`ALLOWED`), parity tests (`patternsApi.test.ts`, cargo `patterns_allowlist_is_exact_and_method_scoped`), `backend/tests/test_desktop_patterns.py`.
- **Labels:** `TradeLabels` (PK `session_id`, SK `round_trip_index`, GSI `UserIdDateIndex`), `trade_label_service.get_stats` (already groups by expected category/strategy), round-trip builder `build_cycles`; label form `shared/analysis/labeling/RoundTripLabelForm.tsx`.
- **Analysis allowlist (3 copies)** for routes the label forms call: `backend/app/routers/desktop_analysis.py`, `windowsapp/src/analysisApi.ts` (`validAnalysisPath`), `lib.rs` (`valid_analysis_path`); the phone imports the same allowlist.

## Data model (new, lazy `ensure_*` + `scripts/setup-dynamodb-tables.py` + `docs/architecture-backend.md`)

**`DeepDiveSetups`** — one item per *symbol + day + side*.
- PK `user_id`, SK `{category}::{strategy}#{date}#{symbol}#{side}` (side `buy|sell`). One query `begins_with` loads a whole dive.
- Attributes: `category`, `strategy`, `symbol`, `date`, `side`, `strike_ce`, `strike_pe`, `strike_mode`, `interval_minutes` (default 3), `annotations` (JSON, same item shape as `PatternAnnotation`), `outcome` (`success|failed|null`), `tag_values` (map `tag_id → bool`: true valid, false not valid; absent = unmarked), `notes`, `created_at`, `updated_at`.
- A day with both sides = two items; order is date ascending, buy before sell.

**`DeepDiveTags`** — PK `user_id`, SK `tag_key` = `{category}::{strategy}#{tag_id}`. Attributes `name` (≤140), `status` (`active|archived`), `sort_order`, `created_at`, `archived_at`. Never hard-deleted (the marks survive); archived tags stop counting. Case-insensitive unique among active per dive, ≤40 active.

No separate dive table: a dive exists when it has setups or tags. Sharing reads through `get_accessible_owner_ids`.

## Backend (`backend/app/routers/deep_dive.py`, prefix `/api/deep-dive`; service `deep_dive_service.py`)

| Route | Purpose |
|---|---|
| `GET /dives` | list dives (own + shared) with day counts, tag counts, incomplete counts |
| `GET /dive?category&strategy&owner_id?` | setups + tags + gap matrix |
| `PUT /setup` | upsert a setup (day, side, symbol, strikes, annotations, outcome, notes); validates trading day, symbol, side; removing a side deletes its item |
| `DELETE /setup` | remove a marked day/side (UI confirms; its tag marks go with it) |
| `PUT /setup/tag-values` | mark tags `{tag_id: true|false|null}` (true valid, false not valid, null unmarked) via `SET tag_values.#t` (atomic, idempotent) |
| `POST /tags`, `POST /tags/{id}/update|archive|restore` | tag CRUD |
| `GET /stats?category&strategy&side?&owner_id?` | frequency stats |
| `GET /stats/all` | stats for every dive, small payload, for the label-form panel |
| `POST /setup/save-to-patterns` | copy marks into `PatternAnnotations` via existing create/update (merge if a chart exists for that symbol/day; returns the chart id) |

**Stats** (pure function `compute_stats`, unit-tested): per active tag `valid`, `not_valid`, `marked`, `pct`; `success`, `with_outcome`, `success_pct`; `days`, `buy_days`, `sell_days`; `few_days` flag when `marked < 5` (D8). Filter by side.

**Writes** require `owner == self`; reads accept `owner_id` validated against accessible owners. In label forms: own stats win, else the first sharing owner with data, labelled with the owner.

**Desktop mirror:** add `deep_dive` to the adapt loop in `desktop_patterns.py` → `/api/desktop/v1/patterns/deep-dive/...`; add path shapes to `valid_patterns_path` (Rust) and `ALLOWED` (TS), extend both parity tests and `test_desktop_patterns.py`. For label forms, add read-only `deep-dive/stats/all` to the **analysis** allowlist (3 copies); for the live desktop popup prefer attaching the stats to the existing `trading/trade-labels/metadata` response (fetched when the popup opens) so the trading allowlist and real-trading routes gain no new path. Verify in the sprint; fall back to one read-only trading route if needed.

## Frontend design

### Shared module `shared/deepdive/` (host-agnostic, injectable `DeepDiveApi` like `BehaviorApi`)
- `model.ts` (pure): types, setup ordering, `gapMatrix(setups, tags)`, day completeness, navigation, stats formatting, "n=" labels, few-days warning. Tests go in `windowsapp/src/deepDive.test.ts` (vitest include only covers `windowsapp/src` and `shared/games`).
- Components: `DeepDiveHome`, `DateMarkingStep` + `DiveCalendar`, `InDepthStep` (day strip, tags panel, outcome toggle, gaps panel), `ResultsView`, `StatsPanel` (compact, reused in label forms), `TradedStrip`.
- Hosts inject the chart panes: desktop → KLine `DesktopAnalysisChart`; website → Lightweight pane or KLine per `useAnalysisChartRenderer`.

### UX flow
0. **Home** (new third tab "Deep dive" next to Annotate / Saved charts on desktop and website): list of dives; "Start deep dive" = `PatternNameSelect` (category + strategy, add new) + symbol.
1. **Mark dates**: multi-month calendar (scroll back to a year), weekends/holidays disabled, each day cycles None → Buy → Sell → Both (or a small popover); a side panel with the selected day's **underlying chart preview** (interval selector) so the owner can verify; marked-days list with counts. Autosaves.
2. **In-depth**: header `3 / 12 · 11 Mar · BUY`, Prev/Next, a **day strip** coloured complete / incomplete / "new tag". Left: underlying chart + the matching option chart (Buy → CE, Sell → PE; index symbols only, equities get the underlying only), strikes resolved once (Max Price or OTM 09:30 via the existing resolvers) and saved; the six marker tools with the strategy fixed to the dive's. Right: outcome (success / failed), each tag as a chip with **Valid / Not valid / clear** (unmarked tags are highlighted), "Add tag", archive, notes, and a **"Mark the rest not valid"** shortcut so a long tag list is quick. **Banner** on the current day when tags are unmarked; **"Needs marking" panel** lists every day with the number missing, click to jump. Adding a tag shows how many earlier days it leaves unmarked.
3. **Results**: per-tag bars with `valid/marked (n)` and few-days warning, success rate, Buy/Sell/All filter, per-day table (date, side, outcome, tag dots); click a row to reopen the day read-only; "Save to Pattern Library".

### Frequency panel in labelling (D4)
- Component `StatsPanel` shown under the Expected Pattern row when a strategy with data is selected: top tags with %, success %, n, Buy / Sell / All toggle defaulting to the position's direction (`setupSideOfTrade`). Silent when no data.
- **Post-analysis:** shared `RoundTripLabelForm` (website, webapp, desktop, phone).
- **Live:** `frontend/src/components/PendingLabelPanel.tsx`, `StepwiseLabelPopup.tsx`, `windowsapp/src/App.tsx` (`DesktopLabelPopup`). Rules (real-trading path, per the manual-override philosophy): purely additive, read-only, fetched once when the popup opens with a short timeout, failure or empty data renders nothing, **never delays or blocks Save**, no change to label payloads.

### Patterns view from labelled trades (D10)
- New backend `traded_patterns_service` + route `GET /api/pattern/traded?category&strategy&from&to`: query `TradeLabels` via `UserIdDateIndex`, keep rows where expected or actual matches, resolve entry/exit time, price, direction, instrument (CE/PE, strike) from the round-trip builder for each session (cached per session). The first sprint step is a feasibility check on cost for many sessions and real-session snapshots.
- Pattern view (Saved charts) gets a "From labelled trades" list. Opening one draws **Buy/Sell markers at the actual entry/exit bars** (hollow or dashed with a "traded" tag and a legend that says it is the actual trade, not an ideal marked pattern), expected vs actual shown. **"Edit & save as pattern"** converts them into `PatternAnnotation` marks (editable) and saves through the normal chart create route. Also shown in Deep Dive day view when the owner traded that day.

## Sprints (each = branch off `origin/dev`, PR into `dev`, merge commit, docs updated inside the PR)

| Sprint | Scope | Tests | Exit |
|---|---|---|---|
| **S0** Docs | `docs/spec-phase26-implementation-plan.md` (from this plan), `docs/phase26-manual-acceptance.md` skeleton, `docs/todo.md`, memory. The owner's spec draft was committed later, on request (2026-11-17). Docs go straight to `dev`. | n/a | Plan doc on `dev` |
| **S1** Max Price 30 → 50 (**merged, #865**) | `desktop_preparation.py` (`range(30)`, message "within 30 strikes", docstring), `options_service.py` `_MAX_SCAN_INTERVALS`; update the tests asserting 30 (`test_desktop_preparation.py`, `test_fetch_patterns_script.py`, `test_minute_ohlc.py`, `test_reselect_strike.py`, `pattern-library.spec.ts`, `browseModel.test.ts`, `browse.spec.ts`), the comment and `MAX_PRICE_TIMEOUT_MS` check in `BrowseScreen.tsx`, docs (`live-history-providers.md`, `architecture-phone.md`, `spec-phase24.md`, `phase24-manual-acceptance.md`). `scripts/fetch-patterns-data.py` `MAX_PRICES` are rupee caps, not strike counts: leave. | backend suite | scan stops at the first hit; cold worst case measured and noted |
| **S2** Backend core (**in PR**) | tables, service, router, stats, sharing, save-to-patterns, desktop mirror, Rust + TS allowlists and parity tests, setup script, architecture-backend | new `test_deep_dive.py` (moto): CRUD, side validation, tag-values map, gap matrix, stats incl. few-days, sharing read-only, archive; `test_desktop_patterns.py`; cargo; `patternsApi.test.ts` | routes exposed on both transports |
| **S3** Shared model + API client (**merged, #867**) | `shared/deepdive/model.ts`, `api` type + website client in `services/api.ts`, desktop `patternsClient` methods | `windowsapp/src/deepDive.test.ts` | pure logic fully tested |
| **S4** Desktop: Home + date marking (**merged, #868**) | third tab, calendar, underlying preview, autosave | model tests + SSR render smoke | owner can mark days on desktop (rebuild needed) |
| **S5** Desktop: in-depth analysis (**merged, #869**) | charts, marks, tags, outcome, gaps panel, strikes | model tests + browser script | full walk of a dive |
| **S6** Desktop: results + save to patterns (**merged, #870**) | results view, filters, save-to-pattern | model tests | Deep Dive complete on desktop |
| **S7a** Screens moved to `shared/` behind a host (**merged, #871**), then **S7b** Website/webapp: Deep Dive (**merged, #872**) | extract `ChartPane` from the 1629-line page into a reusable file (minimal edit to `PatternLibrary.tsx`), mode `'deepdive'`, home/calendar/analysis/results with Lightweight and KLine | Playwright harness `frontend/tests/phase22`, `webapp/tests`, `tsc --noEmit` | parity with desktop on both renderers |
| **S8** Frequency in post-analysis forms (**merged, #873**) | `stats/all` route on analysis allowlists (3 copies), `StatsPanel` in shared `RoundTripLabelForm`; phone inherits | vitest, `mobile` typecheck/tests | % appear in Label Trades on all hosts |
| **S9** Frequency in live popups (**merged, #874**) | `PendingLabelPanel`, `StepwiseLabelPopup`, `DesktopLabelPopup`; stats in `trade-labels/metadata` on desktop | popup tests, `scripts/website-live-label-check.mjs`, `desktop-live-label-check.mjs`, replay + stepwise runs | panel visible in replay/stepwise/paper/real; save never delayed. **Dev only; never to `preprod` without the owner's real-session try** |
| **S10a** Traded patterns: backend and transport (**merged, #876**), then **S10b** the screens (**merged, #877**) | backend route + service, "From labelled trades" list, traded markers, edit and save as annotations; both hosts | backend tests, model tests, browser checks | owner can see/convert actual trades into pattern annotations |
| **S11** Hardening (**in PR**) | empty/error states, few-days wording, performance of big dives, accessibility, acceptance doc final, `CLAUDE.md` Phase 26 row, architecture docs, memory | full suites | owner acceptance list ready |

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
Weekend/holiday days (calendar + server validation); day without data (chart shows "no data", day stays markable); equity symbols without options (underlying only); Both sides on one day (two items, buy first); tag added mid-way (gap matrix); tag archived (drops from stats, marks kept); un-marking a side (confirm, deletes its tag marks); strike changes (saved per setup, changes only on explicit re-pick); existing pattern chart on save-to-patterns (merge with confirm); shared viewer (read-only UI, no edit controls); label with a strategy that has no dive (panel hidden).

## Verification
- Backend: `cd backend && source ~/venvs/tradematangi/bin/activate && python -m pytest tests/ -v` (moto tables, no DynamoDB Local needed for the new tests; 17 `test_auth.py` tests need it).
- Desktop: `cd windowsapp && npm run build && npm test`; `cd windowsapp/src-tauri && cargo test`; rebuild the desktop app for Rust changes.
- Website: `cd frontend && node node_modules/typescript/bin/tsc --noEmit`; Playwright `npm run test:charts`; `bash scripts/build-frontend-with-webapp.sh` then `cd webapp && npm test`.
- Phone: `cd mobile && npm run typecheck && npm test`.
- End to end by hand (`docs/phase26-manual-acceptance.md`): start the stack (`scripts/start-backend.sh`, `scripts/start-frontend.sh`), mark 4–5 days (one with both sides), mark tags, add a tag on day 3 and confirm earlier days flag, check results %, open Label Trades and a replay/stepwise label popup and see the % for that strategy, check a shared account read-only, check Pattern view traded markers.

## Open points to confirm during build (no action needed now)
1. ~~Whether the owner wants the spec draft committed~~: done on request, 2026-11-17 (`docs/spec-phase26.md` now carries the status).
2. The 3-min bar interval for traded markers when the owner's pattern chart used another interval (use the pattern's saved `interval_minutes`, else 3).
3. S10 cost on many real-session snapshots; fall back to a stored entry/exit time on labels if the round-trip rebuild is too slow.

## S1 as built (2026-11-16)

- `desktop_preparation.MAX_PRICE_SCAN_STRIKES = 50` drives `find_max_price_strike` (the minute scan behind Patterns, Browse, phone and `prepare-session`); the error text is built from it ("within 50 strikes"). `options_service._MAX_SCAN_INTERVALS = 50` (the legacy second-level scan, which still falls back to ATM on a miss).
- Tests: new `test_scan_reaches_the_fiftieth_strike_and_stops_there`; the call-count test is tied to the constant; message assertions updated in backend, `frontend/tests/phase22`, `mobile` unit and UI tests. Backend suite: 3497 passed (the 17 `test_auth.py` tests need DynamoDB Local).
- `BrowseScreen.tsx` comment updated; `MAX_PRICE_TIMEOUT_MS` (120 s) kept: Browse scans minute candles, and the scan stops at the first qualifying strike, so only a miss pays for all 50. Check a cold-cache miss on the phone during acceptance.
- Docs: `live-history-providers.md`, `architecture-phone.md`, `phase24-manual-acceptance.md`. `spec-phase24.md` describes the earlier state and is left as history.

## S2 as built (2026-11-16)

- **Service** `backend/app/services/deep_dive_service.py`; **router** `backend/app/routers/deep_dive.py` (`/api/deep-dive`, registered in `main.py`); tables `DeepDiveSetups` and `DeepDiveTags` (lazy-created, also in `scripts/setup-dynamodb-tables.py`; `docs/architecture-backend.md`). Sort keys are `setup_key` and `tag_key` (the plan called both SK).
- **Routes:** `GET dives | dive | stats | stats/all`, `PUT setup`, `DELETE setup` (query params), `PUT setup/tag-values`, `POST setup/save-to-patterns`, `POST tags`, `POST tags/{id}/update|archive|restore` (category and strategy go in the body: they are part of the key).
- **Decisions:** names reject `::` and `#` (they build the keys). A setup upsert is one `update_item` (partial fields; `null` clears outcome and strikes; `tag_values` starts as `{}`; interval defaults to 3). Marks are rewritten with the dive's category and strategy. A new mark on an archived tag is refused, clearing one is allowed. Day completeness = every active tag marked valid or not valid (the outcome is separate). `stats_all` returns `all`/`buy`/`sell` blocks per strategy, own dive first, else the first sharer. `save-to-patterns` merges by mark id into the user's own chart for that day and refuses a chart that uses other CE/PE strikes. Names are added to the `PatternNames` registry on a best-effort basis.
- **Desktop:** the router is mirrored by `desktop_patterns.py` as `/api/desktop/v1/patterns/deep-dive/...`; `valid_patterns_path` (Rust) and `ALLOWED` (`patternsApi.ts`) carry the same shapes with parity cases in `patternsApi.test.ts` and the cargo test. The desktop app needs a rebuild once S4 uses the routes. `stats/all` is also needed on the **analysis** allowlists in S8.
- **Tests:** `backend/tests/test_deep_dive.py` (moto, 42 tests), `test_desktop_patterns.py` (+3), `patternsApi.test.ts` (61), `cargo test patterns_allowlist`. Backend suite: 3539 passed plus the 17 `test_auth.py` tests that need DynamoDB Local.
- **Tags, not questions (2026-11-16, same PR):** the owner asked to rename Questions to Tags before merge. Valid = yes, Not valid = no, and a third state **unmarked** stays so the "needs marking" gaps keep working; percentages are valid / (valid + not valid) per tag. Tag fields are `name`, `tag_id`, `tag_values`; stats rows carry `valid`, `not_valid`, `marked`; the desktop paths are `deep-dive/tags[...]` and `deep-dive/setup/tag-values`.

## S3 as built (2026-11-16)

- **Files:** `shared/deepdive/types.ts` (shapes, `DeepDiveApi`, `DeepDiveRequest`), `client.ts` (`createDeepDiveClient`), `model.ts` (pure logic). Website: `deepDiveApi` in `frontend/src/services/api.ts`. Desktop: `createPatternsClient(...).deepDive` in `windowsapp/src/patternsClient.ts`.
- **One client for both hosts** (a change from the plan, which had a separate website client and desktop methods): both transports serve the same `deep-dive/...` paths, so one factory builds every call and the two hosts cannot drift. A test runs every client call through `validPatternsPath`.
- **Model decisions:** a calendar click cycles none, Buy, Sell, both, none; a second tap on the same tag state clears it; an archived tag never counts as unmarked; "mark the rest not valid" only touches unmarked active tags; `thinNote` uses the server's 5-day threshold; `defaultSideForTrade` maps CE to Buy and PE to Sell.
- **Tests:** `windowsapp/src/deepDive.test.ts` (22). Full `windowsapp` vitest: 1695 passed. `tsc --noEmit` clean for `windowsapp` and `frontend`. The phone project was not type-checked (its dependencies are not installed here) and does not import these files yet.
- **Docs:** `docs/architecture-frontend.md` (new "Patterns Deep Dive" section).

## S4 as built (2026-11-16)

- **Files:** `windowsapp/src/tools/deepdive/` (`DeepDive.tsx`, `DiveHome.tsx`, `DateMarking.tsx`, `DiveCalendar.tsx`), `shared/deepdive/calendar.ts`, styles `dd-*` in `patternTools.css`; `PatternLibrary.tsx` gains the third tab (5 lines).
- **Change from the plan:** the calendar has **B and S buttons per day** instead of one click that cycles none, Buy, Sell, both. The cycle would have deleted a marked side's data on a stray click. `cycleDay` and `diffDayMarks` (S3) were replaced by `removalImpact`, which drives a confirmation before a side with data is removed.
- **Behaviour:** each click saves (no save button); weekends, today and later days cannot be marked; a holiday is refused by the server and its message is shown; the symbol can differ per marked day (calendar and list follow the symbol box); a shared dive shows read-only; the selected day's chart is the same KLine Analysis chart as the rest of the Patterns tools.
- **Tests:** `deepDive.test.ts` (24, calendar and `removalImpact` added), `deepDiveScreens.test.tsx` (4: calendar buttons, weekends/today disabled, read-only, home render). `tsc --noEmit` clean, `vite build` passes. Not tried in the running desktop app: `docs/phase26-manual-acceptance.md` section A.
- **Needs a desktop rebuild** (the Rust allowlist changed in S2).

## S5 as built (2026-11-16)

- **Files** (`windowsapp/src/tools/deepdive/`): `InDepth.tsx` (step container: day navigation, save queue, tag and outcome handlers), `DayWorkspace.tsx` (one day: charts, mark tools, outcome, tags, notes), `TagPanel.tsx`, `GapsPanel.tsx`, `DayStrip.tsx`, `DayIntervalBridge.tsx`, `useDayStrikes.ts`, `inDepthModel.ts`, `saveQueue.ts`. `DeepDive.tsx` gets the two step tabs. Shared: `withTags` and `strikeLabel` in `shared/deepdive/model.ts`. `usePatternsRuntime.ts`: `PatternSettings.loaded`.
- **Decisions:** the strategy is fixed to the dive's (no strategy dropdown); the option chart is the setup's own side only (CE for Buy, PE for Sell), plus "Pick strikes again"; strikes and the candle interval are saved per day so a reopened day looks the same; saves are optimistic and serialised (`SaveQueue`), with Retry on failure; "Mark the rest not valid" only touches unmarked active tags; archiving a tag keeps its marks and removes it from counts and gaps at once; a shared dive is read-only.
- **Found while building:** the strike lookup must wait until the account's settings have been read, or a day opened straight away resolves with the default OTM rule and saves the wrong strikes, so `PatternSettings.loaded` was added.
- **Tests:** `inDepth.test.tsx` (21: `withTags`, in-depth helpers, `SaveQueue` ordering / state / failure, day strip, gaps panel, tag panel incl. read-only). Full `windowsapp` vitest: 1716 passed; `tsc --noEmit` clean; `vite build` passes. **Browser check** `scripts/desktop-deepdive-check.mjs` (built app, fake native layer and server, headless Chrome): start a dive, mark days with B and S, open the in-depth step, add tags, mark Valid / Not valid and clear, "Mark the rest not valid", outcome and notes saved, a chart click saved as a mark, Next unmarked day, archive a tag, reopen from the list; no console errors.
- **Not covered by that check:** the real server, real strikes and the Windows build (`docs/phase26-manual-acceptance.md` section B).

## S6 as built (2026-11-16)

- **Files:** `windowsapp/src/tools/deepdive/Results.tsx` (step 3, a third tab in `DeepDive.tsx`), shared `computeStats`, `roundTenth`, `tagDots`, `setupSideOfTrade`, `SIDE_MEANING` in `shared/deepdive/model.ts`. `InDepth` takes a `focus` day so a results row opens that day.
- **Screen:** **All / Buy / Sell** filter with counts; a summary (days, buy and sell counts, "Success 8 of 12 (66.7%)"); per tag a bar with `70% (n=14)`, valid and not valid counts and a "Only 3 days marked" note under 5 days (the bar is striped while thin); order by tag order or most frequent; a row per day (date opens it, outcome, one dot per active tag, mark count, notes); **Save to Patterns** per day with chart marks and **Save n marked days to Pattern Library** (shows how many charts were created or updated; not offered on a shared dive).
- **Percentages are computed on screen** from the days held in memory with the server's arithmetic (ties to even at one decimal, 6.25 is 6.2 on both), so they include the latest edit without a request; `deepDive.test.ts` repeats the server tests' numbers.
- **Buy and Sell mean the direction the position profits from** (owner, 2026-11-16): long equity or index = Buy, short = Sell; CE bought = Buy, PE bought = Sell; selling flips both (short CE = Sell, short PE = Buy). `setupSideOfTrade({ right, action })` implements it (S3's CE-or-PE-only helper was wrong for sold options and was replaced); the label forms in S8 and S9 will use it for the side a form opens on. The screens say so in tooltips, a hint line under the filter and the calendar legend.
- **Tests:** `results.test.tsx` (7), `deepDive.test.ts` (stats mirror and trade side, now 28). Full `windowsapp` vitest 1725 passed; `tsc --noEmit` clean; `vite build` passes; `scripts/desktop-deepdive-check.mjs` now also covers Results (percentages, filters, archived tag left out, Save to Patterns, opening a day).

## S7a as built (2026-11-16): the screens move to `shared/` (no behaviour change)

- **Why:** the website must show the same Deep Dive on Lightweight and KLine. Copying the screens would have forked them, so they now live once in `shared/deepdive/ui/` and a **host** supplies what differs (API transport, names, strike lookup, settings, chart). S7b adds the website host. Done as its own PR so the move can be reviewed with nothing else in it.
- **Moved** (git renames, imports adjusted): `DeepDive`, `DiveHome`, `DateMarking`, `DiveCalendar`, `InDepth`, `DayWorkspace`, `DayStrip`, `GapsPanel`, `TagPanel`, `DayIntervalBridge`, `Results`, `useDayStrikes`, `inDepthModel`, `saveQueue` and the `dd-*` styles (`deepdive.css`) from `windowsapp/src/tools/` to `shared/deepdive/ui/`. New: `ui/host.tsx` (`DeepDiveHost`, `DiveChartProps`, `DiveSettings`, provider and hook), `shared/deepdive/marking.ts` and `strikes.ts` (extracted from `patternLibraryModel`, which re-exports them), `windowsapp/src/tools/deepdive/desktopHost.ts`.
- **Props became the host:** the screens no longer take `client`, `api`, `settings` or a chart component; the website's `PatternLibrary` page will pass its own host.
- **Check:** `tsc --noEmit`, `vite build`, 200 desktop tests (the screen tests now live over a stub host) and `scripts/desktop-deepdive-check.mjs` give the same results as before the move.

## S7b as built (2026-11-16): the website and webapp

- **Files:** `frontend/src/components/deepdive/WebsiteDeepDive.tsx` (host), `DeepDiveLightChart.tsx`, `deepDiveWeb.css`; `pages/PatternLibrary.tsx` gains a third mode (`'deepdive'`) with its tab and a body branch (about 10 lines; Create and View are untouched). Test harness `frontend/tests/phase22/deep-dive.{html,tsx,spec.ts}`.
- **Change from the plan:** the plan said to extract `ChartPane` from the 1629-line page. Instead a small purpose-built `DeepDiveLightChart` (about 120 lines) renders the Lightweight chart, so the page's own chart code was not touched at all. KLine reuses the shared Analysis chart the rest of Analysis already uses on the website.
- **Behaviour:** both renderers show the same screens as the desktop. A Buy setup shows the underlying chart and its **CE** chart, a Sell setup its **PE** chart. The renderer is the existing **Analysis & Patterns** setting (Settings, Display). Strikes use the website's Max Price / OTM settings on minute data like the Patterns page.
- **Webapp:** it renders the same page, so it gets the Deep Dive without changes.
- **Tests:** `deep-dive.spec.ts` (2: Lightweight and KLine; start a dive, mark B and S days, in-depth with CE then PE chart, add a tag, mark Valid, a click on the chart saves a mark, results percentages and the Sell filter, Save to Patterns, no console errors); all 60 website Playwright specs pass; `tsc --noEmit` clean; website `vite build` passes. Not run: the webapp's own Playwright suite and a manual try in a real browser against the real server (`docs/phase26-manual-acceptance.md` section D).

## S8 as built (2026-11-16): percentages in the Label Trades form (all hosts)

- **Files:** `shared/deepdive/ui/StatsPanel.tsx` + `statsPanel.css`; `RoundTripLabelForm.tsx` gets an optional `deepDive` prop (about 6 lines); `TradeLabeling.tsx` loads the stats once (fire and forget) and passes them with each trip's `{ right, action }`; `AnalysisApi.getDeepDiveStats` (optional) in `shared/analysis/environment.tsx`; website `api.getDeepDiveStats`; desktop `createAnalysisApi(...).getDeepDiveStats`.
- **Transport:** one read-only route, `GET deep-dive/stats/all`, added to the three analysis allowlist copies (`backend/app/routers/desktop_analysis.py`, `windowsapp/src/analysisApi.ts`, `windowsapp/src-tauri/src/lib.rs`) with tests in all three; the phone shares the TS allowlist. **The desktop app needs a rebuild** (Rust change).
- **Side:** the panel opens on the position's direction from the round trip's option right and the side of its first entry order (`setupSideOfTrade`): a sold CE opens on Sell, a sold PE on Buy. A switch shows the other side or All; unknown direction opens on All.
- **Never in the way:** the stats load is optional and unawaited; a failure, a 404 from an older server, an empty list, no expected strategy or a strategy without a deep dive all render nothing and labels save as before.
- **Tests:** `windowsapp/src/deepDiveStats.test.tsx` (9: side by position, thin notes, caps, shared, empty, and the label form), `analysisApi.test.ts`, cargo `deep_dive_stats_is_one_read_only_analysis_route`, backend `test_desktop_analysis.py` (+2), webapp Playwright (`label-trades.spec.ts`: long equity opens on Buy with the right numbers, a sold CE on Sell, switching sides, and an older server with no panel). Full `windowsapp` vitest 1734, phone vitest 116, `tsc --noEmit` clean on windowsapp, frontend and mobile.
- **Fixed on the way:** the two existing webapp Label Trades tests had been failing on `dev` since the "labelled" badge was added to the trade counter (the exact-text locator "Trade 1 of 2" no longer matched); the locators now match the start of the text.

## S9 as built (2026-11-16): percentages in the live label popups (replay, stepwise, paper, real)

- **Where:** entry popups only (the Expected Pattern). Website: `PendingLabelPanel.tsx` (shared by replay, paper and real) and `StepwiseLabelPopup.tsx`; desktop: `DesktopLabelPopup` in `windowsapp/src/App.tsx`. All three reuse `StatsPanel` from S8, opening on the position's side (sold CE and bought PE = Sell; sold PE and bought CE = Buy; long equity = Buy, short = Sell), with the Buy / Sell / All switch.
- **Direction:** website open legs now carry `action` (`App.tsx`: a LONG position was bought, a SHORT one sold; `TradePanel`'s prop type widened); the stepwise popup reads each round trip's first entry order from `api.getRoundTrips` (only fetched when the user has deep dives; if it fails the panel opens on All); the desktop reads `roundTrip.entry_trades[0].side`.
- **Desktop data path:** `GET trading/trade-labels/metadata` gains `deep_dive` (the S8 stats). It is read with a 2 second bound (`DEEP_DIVE_STATS_TIMEOUT_SECONDS`) and falls back to `[]`, so a slow or failing read can never delay or fail the label values. No new trading route and no change to the desktop trading allowlist.
- **Real-trading safety:** purely additive and read-only. Saving a label does not depend on the stats: the payloads are byte-for-byte the ones from before (asserted in the browser checks); the website stats load is a separate, never-awaited effect; nothing is added to a hot path. **Stays on `dev`: it does not go to `preprod` without the owner's real-session try** (see `docs/todo.md`).
- **Tests:** backend `test_desktop_api.py` (metadata carries `deep_dive`; a failing read gives `[]` and the other values; a slow read is cut off after the timeout); browser checks that mount the real popups with stubbed APIs: new `scripts/website-live-deepdive-check.mjs` (replay/paper/real panel: all four directions, exit popup has no panel, stats that never answer, fail or are empty never block or change a save; stepwise per round trip incl. a failed round-trip lookup) and an extended `scripts/desktop-live-label-check.mjs` (six directions, an older server with no `deep_dive`, unchanged save payload). Full `windowsapp` vitest 1734, backend desktop and Deep Dive tests 222, `tsc --noEmit` clean for website and desktop.
- **Not covered:** a real replay, paper, stepwise or real session end to end (`docs/phase26-manual-acceptance.md` section F).

## Fixes after the owner tried the desktop and website (2026-11-16)

Three things found by using the screens, each now with a test that fails without the fix:

1. **Only NIFTY and BSESEN could be chosen.** The symbol box copied the desktop Pattern Library's two-item suggestion list and defaulted to NIFTY; the website Pattern Library offers five. The Deep Dive now has a **symbol dropdown** with exactly the Pattern Library's symbols (NIFTY 50, SENSEX, Reliance Industries, Tata Motors CV, Tata Power), and the desktop Pattern Library's own box lists them too. A second problem sat behind it: option charts were limited to the two indices, so a stock deep dive would have had no CE or PE chart; every Pattern symbol now gets one (stocks use OTM strikes at their gap of 5, as the Patterns page does; the "OTM" box shows whenever the symbol's rule is OTM). Guard: `windowsapp/src/deepDiveSymbols.test.ts` reads the website page's symbol and strike-gap tables and fails if they drift from the shared ones.
2. **The calendar put every date one column late** (Monday under Tuesday, Friday under Saturday). The cells of the neighbouring months were `display: none`, which removed them from the grid and slid the whole month left. The date arithmetic was right and unit-tested; nothing tested where the cells sit. They now keep their slot (`visibility: hidden`). Guard: both browser checks assert, for every visible day of two months, that it sits under its own weekday header (confirmed to fail with the old CSS).
3. **In-depth charts did not use the window** (about half of a tall window empty, and on a short window the lower chart's time axis fell below the fold). The day area is now sized to the bottom of the window (`useFillWindow`) and the two **stacked** charts share it, half each, with each at least 260px (shorter windows scroll rather than clip a time axis). I tried side by side first; the owner preferred stacked. Guard: the website spec (both renderers, 1920×1080, 1600×900 and 1366×768) and the desktop check assert the area reaches the window bottom, the charts are stacked and equal, and neither is squeezed below 255px.

Also in this PR: the redundant date line under the in-depth workspace was removed (it only added height).

## S10a as built (2026-11-17): traded patterns, backend and transport

- **What it is:** the strategies the user already labels on trades (as expected or actual) become pattern material: a list of them, the trades behind one, and a way to copy a trade's entry and exit into a pattern chart as marks. S10b adds the screens (Pattern Library on the desktop and website: a list, the trade drawn on its bars with a "traded" look, and Edit).
- **Feasibility (the question from the plan):** `summary` reads **labels only** (one indexed query on `UserIdDateIndex`), so the strategy list is cheap however many sessions exist. `list_traded` rebuilds round trips per session, so it works on **one strategy at a time and its newest `limit` labels** (default 50, max 200), **one rebuild per session**, and counts a session it cannot read as `unavailable` instead of failing. So the cost is bounded by the user's choice, not by history.
- **Files:** `backend/app/services/traded_patterns_service.py` (`summary`, `list_traded`, `save_traded`, `setup_side`, `marks_for`); three routes on the pattern router (`GET /api/pattern/traded/summary`, `GET /api/pattern/traded`, `POST /api/pattern/traded/save`), mirrored on the desktop as `/api/desktop/v1/patterns/pattern/traded...`; `shared/traded/{types,client}.ts` (one client for both hosts, like the Deep Dive); `tradedApi` in `frontend/src/services/api.ts`; `createPatternsClient(...).traded`; the Rust and TS allowlists with parity tests.
- **What a trade item carries:** session, day, symbol, option right and strike, the opening order (`action`), the **side it profits from** (`setup_side`: long equity, CE bought and PE sold = Buy; short equity, CE sold and PE bought = Sell), entry and exit (time, volume-weighted price, quantity), P&L, the expected and actual strategy and which one matched.
- **Save as marks:** the trade's entry and exit become `entry` / `exit` marks of the chosen strategy on the instrument traded (the option's own CE or PE leg, or the underlying), placed on the 3-minute bar they happened in, and join the day's own pattern chart (merged by mark id) or start one; a chart on other strikes is refused. The trade must be the user's own and labelled with that strategy.
- **Refactors with no behaviour change:** the marks-into-chart logic written for the Deep Dive moved to `pattern_logger_service.save_marks_to_chart` and both features call it; `trade_label_service.canonical_labels` was extracted from `get_stats` (a linked real session is counted once, from its owner session) so the list and the stats agree on which labels count.
- **Guard changed:** the desktop test that no trading path is exposed matched the substring "trade" and flagged `traded`; it now matches "trade" as a whole word (still fails for a real trade route).
- **Tests:** `backend/tests/test_traded_patterns.py` (19: direction table, summary counts and date ranges, expected / actual / both, newest first, limit and truncation, one rebuild per session, unreadable session, marks on 3-minute bars, PE leg and underlying, merge, refusals, the three HTTP routes), `test_desktop_patterns.py`, `windowsapp/src/tradedClient.test.ts`, `patternsApi.test.ts`, cargo `patterns_allowlist_is_exact_and_method_scoped`. Full backend suite: 3566 passed; the 2 failures are date-dependent tests in `test_options_service.py` that fail on a clean `dev` too (`test_today_*`, they assume today's date).
- **Desktop app needs a rebuild once S10b uses the routes** (Rust allowlist).

## S10b as built (2026-11-17): the screens for "From your trades"

- **Files:** `shared/traded/model.ts`, `shared/traded/ui/{TradedPatterns.tsx,host.tsx,traded.css}`; desktop `PatternLibrary.tsx` (fourth tab and `tradedHost`); website `components/deepdive/WebsiteTradedPatterns.tsx` and a fourth mode in `pages/PatternLibrary.tsx` (a tab, a body branch and `openTradedChart`, about 15 lines; Create, View and Deep dive are untouched). Small shared changes: `PatternAnnotation` gains the optional `source` and `action` (`frontend/src/services/api.ts`), `buildMarkers` renders `source: 'traded'` gold (`shared/analysis/patternMarkers.ts`), `DiveChartProps` gains `focusTime`, and the Lightweight chart honours it.
- **Behaviour:** see "Pattern Library: From your trades" in `docs/architecture-frontend.md`. Decisions: the owner's wish to "mark Buy and Sell on the 3-minute bars where I actually bought and sold, show it in the pattern view with something that says it is the actual trade, and let me edit it into pattern annotations" became gold ⚑ BUY / ⚑ SELL marks, a legend ("gold = your actual orders") and **Save and edit**; the trade's entry and exit are saved as ordinary entry and exit marks of the strategy being viewed (a trade can carry it as the expected or the actual strategy; the strategy chosen in the list is the one used).
- **Position:** each trade shows the order that opened it and the side it profits from, with the same rule as everywhere (a short PE is Buy-side).
- **Tests:** `tradedModel.test.ts` (8: marks for a long, a short and an open trade, the gold look and that ordinary marks are unchanged, wording), `tradedClient.test.ts`, website `traded-patterns.spec.ts` on both renderers (strategies and counts, filter, two trades incl. a short PE, stacked charts reaching the window bottom, the contract chart per trade, save, save and edit loads the chart into Create), desktop check (same flow through Annotate). Full `windowsapp` vitest 1756; all 62 website Playwright specs; `tsc --noEmit` clean for website and desktop.
- **Not covered:** a real account's labelled trades on the real server (`docs/phase26-manual-acceptance.md` section H). The desktop app needs a rebuild.

## S11 as built (2026-11-17): hardening and wrap-up

What was reviewed for real-use problems, and what changed:

- **Cost of the label-form percentages.** `stats_all` runs every time a label form or live popup opens and reads all of a user's marked days. It is now cached per process for 20 seconds (`STATS_ALL_TTL_SECONDS`) and **every write drops the cache** (setup upsert and delete, tag marks, tag add, rename, archive, restore), so the owner's own edits show at once; another process or a viewer of a shared deep dive sees a change within the TTL. Callers get a copy, so nothing can corrupt the cache.
- **Past days only, in India.** The calendar already allowed only days before today; the server now refuses a day that is not before today in IST (`A deep dive day must be before today`), so the two agree and a half-finished day cannot be marked from another client. IST, not the server's UTC date, so marking yesterday just after midnight in India works.
- **Plain error wording** (`shared/deepdive/ui/errors.ts`, used by every Deep Dive and traded-patterns screen): an older backend's bare "Not Found" or "request failed (404)" becomes "This server does not have this feature yet. Update the backend, then try again.", a dropped connection becomes "Could not reach the server...", and the server's own sentences (including its own "not found" ones) pass through unchanged.
- **A weakness found by testing an older server:** the start screen loaded its category and strategy names and the list of deep dives together, so one failure left both dropdowns empty and "Loading…" forever. They load independently now; the list says "Your deep dives could not be loaded." and the start form keeps working.
- **Keyboard:** the day strip is one tab stop; the arrow keys, Home and End walk the days and focus follows.
- **No feed row while the feed is healthy** (owner request, 2026-11-17): the website's paper-trading status row "Feed kite · connected" cost the chart a row; `feedNotice` (`shared/liveFeedNotice.ts`) now shows the line only while connecting, reconnecting or unavailable, or when data comes from a fallback provider. The desktop's toolbar label follows the same rule. Real-trading hook points: `frontend/src/App.tsx` and `windowsapp/src/App.tsx` (a conditional render only).
- **Reviewed, no change needed:** big dives (the screens work from one `GET /dive` and sort in memory; the calendar, strip and tables are linear); concurrent edits from two windows (tag marks are per-key atomic; chart marks are last write wins, as everywhere in the Pattern Library); limits (100 tag values per request, 200 marks per day, 40 active tags, 2000 characters of notes) are all enforced by the server.
- **Tests:** backend `test_deep_dive.py` (cache served, dropped by every write, expires, copy-safe; future and today refused) 3570 passed in the full suite; `deepDiveErrors.test.ts`, `liveFeedNotice.test.ts`; website Playwright `hardening.spec.ts` (an older server and a dropped connection, both screens stay usable) and keyboard walking in `deep-dive.spec.ts` (64 specs pass); desktop vitest 1762; `scripts/desktop-deepdive-check.mjs` passes.

## Final status (2026-11-17)

All sprints are merged to `dev` except S11 (in PR). What remains is the **owner's acceptance** of sections A to I in `docs/phase26-manual-acceptance.md` (Windows build, website and a real session), and nothing from Phase 26 goes to `preprod` before the owner's real-session try of S9 (`docs/todo.md`). `docs/spec-phase26.md` (the owner's requirement draft) carries the status and a "Built" note under every requirement.

## Review changes (2026-11-17, after the owner's first look)

- **From your trades**: charts side by side (each the full height of the viewer; under 1000px wide they stack). The Deep Dive's in-depth step stays stacked.
- **Maximize per chart** in both screens (`ChartFrame`, `useMaximizedChart`): a thin bar above each chart with its name and Maximize / Restore; the other chart hides but stays mounted; the choice is remembered across days and trades.
- **Deep Dive header in the Pattern Library's own row** (`HeaderPortal`, `DeepDiveHost.headerSlot`, a slot in the website page header and the desktop `.pl-head`): back ("← All"), name, steps and the day walk no longer take rows of their own. Compact controls (‹ ›, no year in the day label, a truncating name) so the row fits on one line from about 1500px.
- **Tests:** website `deep-dive.spec.ts` (header controls in the library's row at 1920px; maximize, persistence to the next day, restore) and `traded-patterns.spec.ts` (side by side, maximize, restore) on both renderers; `scripts/desktop-deepdive-check.mjs` (same on the built desktop app); `positionLabel` year rule in `deepDive.test.ts`.

