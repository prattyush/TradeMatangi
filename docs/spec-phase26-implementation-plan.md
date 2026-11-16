# Phase 26 — Implementation plan (Patterns Strategy Deep Dive)

Approved 2026-11-16. Source of truth for sprint order; update the status column as sprints merge. Spec: `docs/spec-phase26.md` (owner draft).


## Context

Today the Pattern Library lets the owner mark a strategy (category + strategy) on single-day charts. It says nothing about *how often* a setup behaves a certain way. Phase 26 adds a **Deep Dive** on one strategy at a time so the owner can understand a setup in detail:

1. Pick a category + strategy, then mark on a calendar the days the setup occurred, each as **Buy**, **Sell** or **both** (spec: `docs/spec-phase26.md`, untracked owner draft, never commit it unless asked).
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
| **S0** Docs | `docs/spec-phase26-implementation-plan.md` (from this plan), `docs/phase26-manual-acceptance.md` skeleton, `docs/todo.md`, memory. Spec draft stays untracked unless the owner asks. Docs go straight to `dev`. | n/a | Plan doc on `dev` |
| **S1** Max Price 30 → 50 (**merged, #865**) | `desktop_preparation.py` (`range(30)`, message "within 30 strikes", docstring), `options_service.py` `_MAX_SCAN_INTERVALS`; update the tests asserting 30 (`test_desktop_preparation.py`, `test_fetch_patterns_script.py`, `test_minute_ohlc.py`, `test_reselect_strike.py`, `pattern-library.spec.ts`, `browseModel.test.ts`, `browse.spec.ts`), the comment and `MAX_PRICE_TIMEOUT_MS` check in `BrowseScreen.tsx`, docs (`live-history-providers.md`, `architecture-phone.md`, `spec-phase24.md`, `phase24-manual-acceptance.md`). `scripts/fetch-patterns-data.py` `MAX_PRICES` are rupee caps, not strike counts: leave. | backend suite | scan stops at the first hit; cold worst case measured and noted |
| **S2** Backend core (**in PR**) | tables, service, router, stats, sharing, save-to-patterns, desktop mirror, Rust + TS allowlists and parity tests, setup script, architecture-backend | new `test_deep_dive.py` (moto): CRUD, side validation, tag-values map, gap matrix, stats incl. few-days, sharing read-only, archive; `test_desktop_patterns.py`; cargo; `patternsApi.test.ts` | routes exposed on both transports |
| **S3** Shared model + API client (**merged, #867**) | `shared/deepdive/model.ts`, `api` type + website client in `services/api.ts`, desktop `patternsClient` methods | `windowsapp/src/deepDive.test.ts` | pure logic fully tested |
| **S4** Desktop: Home + date marking (**merged, #868**) | third tab, calendar, underlying preview, autosave | model tests + SSR render smoke | owner can mark days on desktop (rebuild needed) |
| **S5** Desktop: in-depth analysis (**merged, #869**) | charts, marks, tags, outcome, gaps panel, strikes | model tests + browser script | full walk of a dive |
| **S6** Desktop: results + save to patterns (**merged, #870**) | results view, filters, save-to-pattern | model tests | Deep Dive complete on desktop |
| **S7a** Screens moved to `shared/` behind a host (**merged, #871**), then **S7b** Website/webapp: Deep Dive (**in PR**) | extract `ChartPane` from the 1629-line page into a reusable file (minimal edit to `PatternLibrary.tsx`), mode `'deepdive'`, home/calendar/analysis/results with Lightweight and KLine | Playwright harness `frontend/tests/phase22`, `webapp/tests`, `tsc --noEmit` | parity with desktop on both renderers |
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
Weekend/holiday days (calendar + server validation); day without data (chart shows "no data", day stays markable); equity symbols without options (underlying only); Both sides on one day (two items, buy first); tag added mid-way (gap matrix); tag archived (drops from stats, marks kept); un-marking a side (confirm, deletes its tag marks); strike changes (saved per setup, changes only on explicit re-pick); existing pattern chart on save-to-patterns (merge with confirm); shared viewer (read-only UI, no edit controls); label with a strategy that has no dive (panel hidden).

## Verification
- Backend: `cd backend && source ~/venvs/tradematangi/bin/activate && python -m pytest tests/ -v` (moto tables, no DynamoDB Local needed for the new tests; 17 `test_auth.py` tests need it).
- Desktop: `cd windowsapp && npm run build && npm test`; `cd windowsapp/src-tauri && cargo test`; rebuild the desktop app for Rust changes.
- Website: `cd frontend && node node_modules/typescript/bin/tsc --noEmit`; Playwright `npm run test:charts`; `bash scripts/build-frontend-with-webapp.sh` then `cd webapp && npm test`.
- Phone: `cd mobile && npm run typecheck && npm test`.
- End to end by hand (`docs/phase26-manual-acceptance.md`): start the stack (`scripts/start-backend.sh`, `scripts/start-frontend.sh`), mark 4–5 days (one with both sides), mark tags, add a tag on day 3 and confirm earlier days flag, check results %, open Label Trades and a replay/stepwise label popup and see the % for that strategy, check a shared account read-only, check Pattern view traded markers.

## Open points to confirm during build (no action needed now)
1. Whether the owner wants the spec draft committed (untracked now).
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
