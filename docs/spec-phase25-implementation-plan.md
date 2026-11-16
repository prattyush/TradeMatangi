# Phase 25 — Implementation plan (Patterns port + Brain Games)

Approved 2026-11-14. Source of truth for sprint order; update the status column as sprints merge.

**Updated 2026-11-15 (Sprint B0):** the full remaining roadmap (Track G and Track B, one linear order with docs per sprint) and the Track B discovery are at the end of this file, under "Track B: Brain Games". Where that roadmap and the Track G sprint list below differ (G3 split into G3a and G3b), the roadmap wins.


## Context
`docs/spec-phase25.md` (written in the Claude web UI; header says "Phase 24", which is already used) specifies ten scalping "brain games" for the desktop app only. The user asked for four things:
1. Plan the Games.
2. Say whether the website and webapp can host them, and add them there if browser compute is enough.
3. Port **Patterns, Chart Structures and Fine Structures** to the desktop.
4. Flag anything touching the real-trading path.

Decisions made with the user:
- Patterns port goes **first**, and is **rewritten on KLine** (no lightweight-charts on desktop).
- Games code lives in `shared/games/` and is used by all three clients; the desktop opens it in its own Tauri window.
- Touching shared files is OK on `dev` only. Each PR description lists the shared files touched and confirms no trading logic changed.
- Rename the spec header and file references to **Phase 25** (`docs/spec-phase25.md`, `docs/spec-phase25-implementation-plan.md`, `docs/phase25-manual-acceptance.md`) and add a Phase 25 row to `CLAUDE.md`.

## Browser feasibility (answer)
Yes. The engine is plain TS: seeded RNG, scoring, Black-Scholes, simple detectors. The chart is one canvas of at most 20k points. Windows are about 30 KB each. A desktop WebView and a Chrome tab have the same capability, and the 600 MB budget is comfortable on a laptop browser. IndexedDB has no precedent in `frontend/` but is standard. Phone is out of scope. `webapp/` just imports `frontend/src/WebsiteApp`, so one website change covers both.

## Real-trading path: what is and is not touched
No order, session, broker, stream, guardrail or strategy code changes. Shared files that do get edited:

| File | Change | Risk |
|---|---|---|
| `windowsapp/src-tauri/src/lib.rs` | New commands `desktop_games_request`, `open_games_window`, `desktop_patterns_request`; handler list; `on_window_event` and close handling for the `games` label; `tauri.conf.json` capability `windows` list gets `"games"`. Requires desktop rebuild. | Low. The shared window-event handler is the one place to review. |
| `windowsapp/src/App.tsx` | One toolbar button (Games); `ToolsView` entries for Patterns, Structures. Games window needs a `?window=games` branch in `main.tsx`, not `App.tsx`. | Low |
| `frontend/src/App.tsx` (website, 260 KB, holds live trading) | One `showGames` flag, one `NavIconButton`, one lazy mount. Can be moved into `WebsiteApp.tsx` if the user prefers (offered; user chose to proceed as-is). | Low, but the file is the live-trading screen |
| `frontend/src/components/NavIconButton.tsx` | New `games` icon | None |
| `backend/app/main.py` | `include_router` lines for games, plus pattern, structure and fine routers under `/api/desktop/v1` | Low |
| `backend/app/routers/desktop.py` | Append `"games"` to `DesktopCapabilities.features` | None |

I will **not** add a global `GZipMiddleware` (it would change every route, including trading streams); compress inside the games window route only. I will not touch `/historical/pages`, `load_dataframe` live mode, or any `_ensure_data` path.

## Track P: Patterns, Chart Structures and Fine Structures on the desktop

**Findings.** The website has ~4.2k lines across `frontend/src/pages/PatternLibrary.tsx` (1629), `ChartStructures.tsx` (573), `FineStructures.tsx` (1867), all on `lightweight-charts` and the monolithic `services/api.ts`. Backend routers are `/api/pattern`, `/api/chart-structures`, `/api/fine-structures`, using `get_request_user_id`, and are not mounted under `/api/desktop/v1`. `desktop_analysis.py` already exposes a read subset of patterns through its `allowed` table (no writes). Desktop has no `lightweight-charts`; it hosts tools in `tools/ToolsView.tsx` (lazy, `TOOLS` list).

**Design (follows the Analysis/Browse precedent).**
1. **Backend:** mount the three routers a second time under `/api/desktop/v1/{pattern,chart-structures,fine-structures}` with `get_desktop_user_id` (precedent: `main.py:147-149` for browse and swing). Add the missing helper routes the pages need: `data/price-at`, `find-strike-by-price`, `data/symbols`. Keep minute data (`minute_ohlc.load_candle_records`, PR #830).
2. **Rust:** one new `desktop_patterns_request` command with its own allowlist. It needs PUT and the `ohlc/{symbol}/{date}` path shapes, so do not extend `valid_analysis_path`. Mirror it in `windowsapp/src/patternsApi.ts` and add vitest and cargo parity tests (the "three copies" rule from `docs/spec-phase23.md`).
3. **Shared UI:** move the page logic to `shared/patterns/` behind a `PatternsEnvironment` (same shape as `shared/analysis/environment.tsx`): API facade, Max Price/strike settings source, error notifier. The website supplies `services/api.ts`; the desktop supplies `patternsApi.ts` and reads Max Price from the settings route (`windowsapp/src/settingsFields.ts`), not localStorage. The website's pages shrink to thin wrappers.
4. **Chart layer:** rewrite rendering on KLine, reusing `shared/charts/KLineChart.tsx`, `useKLineDrawings` and `shared/analysis/patternMarkers.ts`. KLine overlays carry markers, annotation rectangles (replacing `indicators/rectanglePrimitive.ts`), flow transition bars and EMA 9/21. Fine Structures (builder/search) is the heaviest piece. The website keeps lightweight-charts; only the desktop renders through KLine.
5. **Desktop placement:** new entries in `ToolsView` `TOOLS` (Patterns; Structures with Broad/Fine tabs), honouring `active` so hidden charts do not draw.

**Sprints (each = branch off `dev`, PR into `dev`, docs updated):**
- P0 Discovery: confirm KLine overlay capability for rectangles and flow bars; list exact routes and helpers the three pages call; write the implementation plan doc.
- P1 Backend desktop mounts and helper routes, plus tests. Rust `desktop_patterns_request` and the TS mirror, plus parity tests.
- P2 `shared/patterns` environment and Pattern Library on KLine (desktop) with the website page as a thin wrapper.
- P3 Chart Structures (Broad), then P4 Fine Structures (definitions, builder, search).
- P5 Docs (`CLAUDE.md`, `architecture-frontend.md`), manual acceptance on the Windows build.
- Website regressions: after each sprint, run the website pages (they now sit on the shared code) to confirm they behave the same.

## Track G: Games (starts after Track P; backend work may overlap)

**Spec corrections to apply (verified against code):**
1. Do not use `load_dataframe` (it drops `observed` and downloads in live mode). Read with `pd.read_parquet` plus `observed_frame`/`infer_observed` from `desktop_preparation.py`.
2. `has_native_second_cadence` is always true on gap-filled cached frames; the index script must read parquet metadata `native_interval_seconds` (and `_MIN_DAY_ROWS=20000`).
3. `DesktopCapabilities` has no booleans; append `"games"` to `features`.
4. `resample_to_candles` is minute-only. 5 s/15 s resampling is new pandas code (small, in `games_data_service.py`), or the client resamples 1 s data; decide in G0 (recommend client-side, which also removes server CPU).
5. No per-user rate limiter and no gzip middleware exist: write a small in-process token bucket and compress in the route.
6. No TTL exists anywhere: add `update_time_to_live` and an epoch-seconds `expires_at`. DynamoDB Local does not enforce TTL.
7. Revision and `mutation_id` idempotency are new code; use `analysis_sharing.py:92`'s `transact_write_items` pattern with `TypeSerializer`. Convert floats to `Decimal`/integers.
8. Config lives in `config.py` (`LOT_SIZES`, `SUPPORTED_SYMBOLS`) and `options_service.py` (`STRIKE_INTERVALS`, `get_expiry_date`). NIFTY lot size is 65 in the code, not 75.
9. Hotkey Drill: the desktop has **no** hotkey store, so there is nothing to import. Use the defaults only.
10. CSS: the desktop has no theme variables (hard-coded dark palette); games define their own tokens.
11. The Tauri capability is inline in `tauri.conf.json`; add `"games"` to its `windows` list. `schedule_window_close` and `on_window_event` only know `main` and `screen:*`, so add `games` handling there.
12. Second-level data on this machine: NIFTY 236 dates (about 370 KB per file), BSESEN 150, and NIFTY option files for 232 dates (about 3,177 files, up to 39 contracts per day). Other symbols have 3-15 dates, so games should list **NIFTY and BSESEN** only. Real dir is `/mnt/d/data/dbfolder/ohlcdata` (from `accesskeys.ini`), not `data/ohlcdata`; always use `config.OHLCDATA_DIR`.
13. Website auth is `X-User-Id` with no token, and `get_desktop_user_id` already accepts it, so the same `/api/desktop/v1/games/*` routes work from the browser.

**Client structure.** `shared/games/{engine,chart,games,ui,config}` holds everything pure and the canvas `GameChart`. Per-client pieces: a `gamesRequest` transport (desktop uses the new Rust command, the website uses `fetch` like `desktopDrawingRequest.ts`), plus `windowCache` and `outbox` on IndexedDB (written once in `shared/games/data`, since both clients run in a browser engine). Desktop: separate `games` Tauri window via `?window=games` branch in `main.tsx` (isolation per spec §3.4). Website and webapp: lazy `GamesWorkspace` (like `BrowseWorkspace`) behind a new nav icon. Import-boundary test: node `*.test.mjs` or vitest scanning `shared/games` for forbidden imports (trading modules); fake-indexeddb is new for desktop tests and needs adding (the desktop vitest env is plain node).

**Sprints (as the spec, shifted):**
- G0 Discovery (answer spec §13 using the findings above, tune anchors, write the implementation plan, rename to Phase 25).
- G1 Backend data: `scripts/build-games-index.py` (filename scan plus parquet metadata), `/availability`, `/window` (cache-only, observed-only, integer paise, gzip, token bucket), tests proving no broker/download call on a miss.
- G2 Backend persistence: `GameProfiles`, `/state` GET/PUT with transact-write, TTL, revisions, idempotency, `games` feature flag, and `scripts/setup-dynamodb-tables.py` entry.
- G3 Foundation: Rust `desktop_games_request` + `open_games_window`, the shared engine core and `GameChart`, caches, hub, website/webapp nav, and **Tick Reader end to end** on desktop and in the browser.
- G4 Entry Sniper, Exit Discipline, Hotkey Drill, Risk Calculator.
- G5 Level Recall, Strike Picker, Regime Switch. **G6** Spot the Trap (own `patterns.ts`; optionally reuse Opening/Midday/Closing classifiers extracted from `scripts/classify_chart_structures.py` into a service), No-Trade Day.
- G7 Dashboard, Warm-up, Review, Settings, memory/perf pass against §3.5, docs, manual acceptance on Windows and Chrome.

## Critical files
- Backend: `backend/app/main.py`, `routers/desktop.py`, `routers/desktop_analysis.py`, new `routers/desktop_games.py`, `services/games_data_service.py`, `services/games_persistence_service.py`, `scripts/build-games-index.py`, `scripts/setup-dynamodb-tables.py`.
- Desktop: `windowsapp/src-tauri/src/lib.rs` (~781-870 window, ~1078-1157 requests, ~2411 events, ~2417 handlers), `tauri.conf.json`, `windowsapp/src/main.tsx`, `App.tsx` (toolbar ~2810-2835), `tools/ToolsView.tsx`, new `patternsApi.ts`.
- Shared: new `shared/patterns/`, `shared/games/`; reuse `shared/charts/KLineChart.tsx`, `shared/analysis/environment.tsx` (pattern to copy), `shared/analysis/patternMarkers.ts`.
- Website: `frontend/src/App.tsx` (~2274-2305 nav, ~2503 mount), `components/NavIconButton.tsx`, `WebsiteApp.tsx`.

## Verification
- Per sprint: `cd backend && python -m pytest tests/ -v` (new tests for the touched areas), `cd windowsapp && npm run build && npm test`, `cargo test` for Rust allowlists, `cd frontend && node node_modules/typescript/bin/tsc --noEmit`, `bash scripts/check-preprod-synced.sh` is unaffected (dev-only work).
- Add `npm test` and `cargo test` steps to the desktop CI workflow (it currently runs neither).
- Track P manual checks on the Windows build and the website: create, save, reload and delete a pattern chart, a chart structure and a fine flow; Max Price strikes honour desktop settings; website pages unchanged after refactor.
- Track G manual: play each game at levels 1, 10 and 20 on desktop and in Chrome; Task Manager memory at level 20; network trace shows only `/api/desktop/v1/games/*`; offline outbox flush; trading window and live session unaffected while Games runs; a cache miss returns 404 and logs no broker call.
- Each PR description lists shared files touched and confirms no trading logic changed.

---

## Track P, Sprint P0 findings (2026-11-14, discovery only, no code changed)

**KLine can draw everything the three pages need.** Reuse, do not add a library:
- Custom overlays: `registerOverlay` / `createOverlay` with `points` and `extendData` (see `analysisAnnotation`, `analysisExecution`, `analysisLevel` in `shared/analysis/kline/AnalysisChart.tsx:54-69`). The desktop already renders saved pattern annotations this way, so **Pattern marker display is already done**; Pattern Library only adds placement and saving.
- Click to place: `chart.convertFromPixel` on a capture-phase container click (`AnalysisChart.tsx:~141-152`, the What If picker) gives time and price. This replaces `subscribeClick` plus `coordinateToPrice`.
- Drawings: KLine built-ins `rect`, `segment`, `horizontalStraightLine`, `fibonacciLine` (`shared/charts/catalogue.ts`, `klineDrawingModel.ts overlayName`). The pages' drawings are throwaway (not persisted), so create the overlays directly instead of going through `useKLineDrawings`, which saves to the user's drawing store and must not be touched.
- Only custom work: the **risk/reward indicator** (`rrindicator`, three coloured line segments) and Fine Structures **transition bar** markers. Both are small `registerOverlay` figures (a rect pair plus text).
- EMA 9/21: `shared/charts/useKLineIndicators.ts` exists; Chart Structures also draws a sparkline on a plain 2D canvas, which needs no chart library.

**Routes the three pages call** (website `services/api.ts` method -> needs a desktop route):
- Pattern: strategies (list), categories (list), charts (list, get, get-by-date, create, update, delete, bulk-delete), `ohlc/equity`, `ohlc/options`.
- Chart Structures: types, list, create, update, `ohlc/{symbol}/{date}`.
- Fine Structures: definitions (list, create, update, delete), flows (create, update, list, get, delete), `search`, `ohlc/{symbol}/{date}`, `ohlc-options/...`.
- Helpers used by two or more pages and absent from the desktop allowlist: `getExpiry`, `getPriceAt`, `findStrikeByPrice`, `getSymbols`.
- `updateUserSettings` (Max Price caps): on the desktop use the existing `desktop_settings_request` route, not a new one.

**Decisions for P1.**
1. One new Rust command `desktop_patterns_request(path, method, body)` for `pattern/`, `chart-structures/` and `fine-structures/`; methods GET/POST/PUT/DELETE; segment checks as `valid_analysis_path`, plus a path-shape allowlist per family and a `?query` allowance. Do not extend the Analysis command.
2. Backend: second `include_router` for each of the three routers under `/api/desktop/v1/...`, with `get_desktop_user_id` in place of `get_request_user_id` (it accepts `X-User-Id` too, so the website behaviour is unchanged). The helper routes get a small `desktop_patterns_helpers` router (expiry, price-at, strike-by-price, symbols), all minute-data only.
3. TS: `windowsapp/src/patternsApi.ts` with `validPatternsPath`, mirroring the Rust allowlist, and parity tests (vitest and cargo).
4. Shared UI environment: `shared/patterns/environment.tsx`.

**Real-trading path check:** nothing in P0 or P1 touches order, session, broker or stream code. P1 touches `backend/app/main.py` (router mounts), `windowsapp/src-tauri/src/lib.rs` (new command and its tests) and the Rust handler list.

| Sprint | Scope | Status |
|---|---|---|
| P0 | Discovery (this section) | Done, awaiting owner review |
| P1 | Backend desktop mounts, helper routes, Rust `desktop_patterns_request`, `patternsApi.ts`, parity tests | In PR into `dev` (branch `feat/desktop-patterns-transport`) |
| P2 | Pattern Library on KLine (desktop-only, core) | Core merged (#834); P2b (drawing tools, R:R, Top Patterns, extra panes, bulk delete) in PR (branch `feat/desktop-pattern-library-full`) |
| P3 | Chart Structures (Broad) | Merged (#836) |
| P4 | Fine Structures | Merged (#837) |
| P5 | Docs, Windows acceptance | Docs done (`architecture-frontend.md`, `CLAUDE.md`, `docs/phase25-manual-acceptance.md`); Windows acceptance is the owner's |

### P1 as built
- Backend `routers/desktop_patterns.py`: re-registers every route of `pattern_logger`, `chart_structures` and `fine_structures` under `/api/desktop/v1/patterns/{pattern,chart-structures,fine-structures}/...`, plus four read-only `data` helpers (`symbols`, `price-at`, `expiry`, `options/find-strike-by-price`). It swaps the website identity for a **desktop bearer only** (`get_patterns_user_id`; `X-User-Id` gives 401), and runs the legacy sync handlers on the bounded history pool (`run_history`), as `desktop_analysis.adapt` does. The website routers are unchanged.
- Rust `desktop_patterns_request` + `valid_patterns_path` (GET/POST/PUT/DELETE, exact path shapes, id/symbol/date segment checks) in `lib.rs`; TS mirror `windowsapp/src/patternsApi.ts` (`validPatternsPath`, `patternsRequest`). Both run the same 36 allow/deny cases (`patternsApi.test.ts`, cargo test `patterns_allowlist_is_exact_and_method_scoped`).
- Tests: `backend/tests/test_desktop_patterns.py` (bearer required, every website route mirrored, only the four data helpers exposed, no order/session/trade/wallet/broker/stream path exposed, identity is the bearer user).
- Needs a desktop rebuild (Rust change). No trading logic touched; shared files changed: `backend/app/main.py` (one import and one `include_router`) and `windowsapp/src-tauri/src/lib.rs` (new command, its tests, one handler-list line).
- Sharing (pattern/fine/structure share-by-email) routes are not in the website routers' route list, so they are not exposed; revisit in P2 if the pages need them.

### P2 as built (owner chose "desktop-only, reuse the Analysis chart", 2026-11-14)
Deviation from the plan above: **no `shared/patterns` refactor and no change to the website page.** The desktop Pattern Library is a new tool, `windowsapp/src/tools/PatternLibrary.tsx` (Tools > Pattern Library), built on the desktop Analysis KLine chart, which already draws saved pattern markers (`analysisAnnotation` overlays) and has a click-to-pick mode (What If). The website page stays on lightweight-charts untouched, so there is no regression risk to the website (which is also the live-trading screen). Unifying the two is optional and can be revisited in P5.
- Pieces: `patternsClient.ts` (typed calls over `patternsRequest`), `tools/patternLibraryModel.ts` (pure: mark toggling, strike resolution OTM / Max Price using the website's `patternStrikes.ts`, save body), `PatternLibrary.tsx`, `patternTools.css`, one `TOOLS` entry in `ToolsView.tsx`. Max Price mode and caps, and historical days, come from the account settings (`trading/settings/current`), not localStorage.
- Features: load a day (underlying only, or underlying + CE + PE with OTM offset or Max Price strikes), mark entry/exit per instrument with category and strategy (a second click on the same candle removes the mark), notes, save and update (one chart per symbol, day and type), restore an existing chart for that day, Saved charts table with strategy, category and top-pattern filters, open and delete.
- Not in P2 (planned as P2b): drawing tools (hline, trend, fib, rectangle), R:R indicator, Top Patterns editing, adding or removing extra strike panes, bulk delete, pattern sharing. The candle interval is the Analysis chart's own selector and is saved with the chart.
- Tests: `patternLibraryModel.test.ts` (7), `PatternLibrary.test.tsx` (initial render). Needs manual acceptance on the Windows build (P1's Rust command must be rebuilt): marks land on the clicked candle at every interval, saved charts reload with their marks and interval, Max Price strikes follow Settings.
- No trading logic touched: only `windowsapp/src/tools/ToolsView.tsx` (one list entry) among existing files.

### P2b as built (owner: "add the full Pattern first")
The desktop Pattern Library now has the website page's feature set, except sharing (the website page itself has no share action, only a "Shared" badge on charts it cannot delete).
- **Top Patterns:** Top 1, Top 2 and Bottom 1 pickers over the distinct category/strategy pairs among the marks; saved as `top_patterns`; ranked markers get the badge as on the website.
- **R:R:** `R:R 1:` field per category and strategy, saved as `risk_reward_ratios`, shown as `(1:x)` on that pattern's markers. This needed one optional prop, `riskRewardRatios`, on the shared `shared/analysis/kline/AnalysisChart.tsx` (passed to `buildMarkers`, which already supported it); no other host sets it, so Analysis is unchanged.
- **Strike panes:** add a CE or PE strike pane, remove or maximize any option pane; the first CE and first PE pane are saved as `strike` and `strike_pe`. Opening a saved chart restores its strikes.
- **Drawing tools:** the Analysis chart's own drawing rail (hline, trend, rectangle, fib), switched on by giving the tool the desktop drawing transport (`desktop_drawing_request`) and the catalogue instrument lookup, so drawings persist per instrument exactly as on the trading charts.
- **Bulk delete:** row checkboxes, select all, confirm; only the user's own charts are selectable; calls `pattern/charts/bulk-delete`.
- Tests: `patternLibraryModel.test.ts` grows to 11 (ranking, R:R, saved strike pair). Desktop vitest 623, tsc clean on desktop and website. Manual acceptance on the Windows build: drawings persist and reappear, strike panes added/removed and saved, ranked and R:R markers.
- Shared file touched: `shared/analysis/kline/AnalysisChart.tsx` (one optional prop). No trading logic touched.

### P3 as built (Chart Structures, Broad)
Desktop Tools > **Chart Structures**, `windowsapp/src/tools/ChartStructures.tsx`, on the same Analysis KLine chart as the Pattern Library; the website page is untouched.
- Gallery of daily structures with Opening, Midday and Closing multi-select filters (comma-joined to the route), colour badges, and a close-price sparkline per card. Sparklines load only when a card scrolls into view (the website fetches every card up front), from 15-minute candles for that day.
- Opening a day shows its KLine chart (with the account's historical days of context), previous and next day through the filtered list, and the classification editor. Saving follows the website's rule (`saveMode`): a system (predefined) or shared structure is never edited, the user gets a custom copy via POST; their own structure is updated via PUT.
- `usePatternsRuntime.ts` now holds the shared setup (patterns client, Analysis environment with drawing transport, account settings); Pattern Library uses it too (pure refactor, no behaviour change). The Fine tab arrives with P4.
- Tests: `chartStructuresModel.test.ts` (8: sparkline day filter and scaling, save rule, filter query, OHLC path, POST/PUT) and `ChartStructures.test.tsx` (initial render).
- No new Rust or backend code (the P1 allowlist and routes already cover `chart-structures/*`). Shared files touched: none. One list entry in `ToolsView.tsx`. No trading logic touched.
- Manual acceptance on the Windows build: filters narrow the gallery, a card opens its day on KLine, previous/next move through the filtered list, saving a system structure creates your own copy and saving your own updates it.

### P4 as built (Fine Structures)
Inside Tools > Chart Structures, a **Broad | Fine** switch (as on the website). Fine has three views, kept mounted so a half-built flow or a search survives a tab switch: **Builder**, **Search**, **Definitions**.
- **Definitions** (`FineDefinitions.tsx`): add, edit and delete your structure definitions with comma-separated sub-types; system ones are read only.
- **Builder** (`FineBuilder.tsx`): load a day as Underlying only or Underlying + CE/PE (OTM offset, or Max Price from Settings, via the same `resolveStrikes` as the Pattern Library). Add steps (structure, optional type, Bull/Bear), reorder and remove them, select a step and click a candle to set its transition bar; Bull draws an up arrow under the bar and Bear a down arrow over it, numbered by step. The drawing rail of the chart stays available (deselect the step to draw). Each pane (underlying, CE, PE) has its own flow, saved with the chart's candle interval. A saved flow is restored when the day is loaded, found by day, instrument type and right (one precise lookup, not the website's "first flow of the day").
- **Search** (`FineSearch.tsx`): build a sequence of structures with `✱ Any` wildcards, filter equity or options, search, open a result on the chart with its transition bars and the matched steps highlighted. Options flows keep the right but not the strike, so the chart shows the **ATM contract of that day** (from the 09:15 price). The website uses the first candle of the loaded window, which can be an earlier day, so this is slightly more correct.
- Model `fineStructuresModel.ts` is pure (step reducers, transition marks, flow lookup, query steps); the chart-interval bridge moved to `IntervalBridge.tsx`. No new Rust or backend code: the P1 allowlist and routes already cover `fine-structures/*`. Transition arrows use the chart's own annotation overlay, so their label is cut to the chart's marker length; the step list beside it has the full names.
- Tests: `fineStructuresModel.test.ts` (12: step reducers, transition marks, flow lookup, search steps, client calls) and the Chart Structures render test now checks the Fine views. Desktop vitest 644, tsc clean.
- Not in P4: the website's old equity and options builders are merged into one Builder (same data); no flow delete (the website page has none either); no flow sharing.
- Shared files touched: none. No trading logic touched.
- Manual acceptance on the Windows build: build a 3-step flow with transitions on the underlying and on CE/PE, save, reload the day and see it restored; search for the sequence and for one with a wildcard; add, edit and delete a definition.


---

## Track B: Brain Games (21 cognitive games), and the remaining Phase 25 roadmap

Sprint B0 (discovery and calibration, **doc only, 2026-11-15**). Covers spec §17. No feature code was written. Awaiting owner review.

### B0 findings in brief
1. **G2 and G3 are not built.** No `shared/games/`, no `desktop_games` router, no `GameProfiles` table, no `games` flag, no `gamesRequest`, no `GamesWorkspace`. §17.11 says Track B starts once G2 and G3 are merged, so G3 is split (decision D1) and G2 + G3a become the prerequisite.
2. **Website live-session behaviour:** Games must copy **Browse** (a fixed overlay, trading layout stays mounted), not Pattern Library / Chart Structures / Swing (early `return`, trading layout unmounted). Details in B.2.
3. **§17 has defects** that would make its own acceptance tests fail or its numbers unreachable (C1–C4), a missing framework feature (step parameters, C5), an under-specified test property (C6) and one omission, the main-thread budget on the website (C7). Corrections C1–C11 below; they are applied to the spec when the owning sprint starts (D3).
4. **Word lists:** ENABLE (public domain) as the valid list and SCOWL 2020.12.07 levels ≤ 60 as the common list, both measured (B.3). The common list is **49,301–50,312 words** (not 20–30k) so only the first tier is the `common` list.
5. **Games stay out of real trading**, apart from the hook points in "Existing files Phase 25 touches".

### Master roadmap (remaining Phase 25 work)
Recommended linear order (one branch and one PR into `dev` per sprint, merge commit). Brain games first because they need no market data (decision D6).

| # | Sprint | Scope | Depends on | Exit criterion |
|---|---|---|---|---|
| — | P5 acceptance (owner) | Windows run of `docs/phase25-manual-acceptance.md` Track P rows | none | Owner signs off |
| 1 | **B0** (doc only) | This section; spec §17 committed | none | Owner approves |
| 2 | **G0-close** (doc only) | Answer spec §13 in a table (most already verified under "Spec corrections to apply" above); record the resampling decision (client-side recommended); confirm market anchors | B0 | Owner approves |
| 3 | **G2** Backend persistence | `GameProfiles`, `GET/PUT /state` (transaction, `mutation_id`, revisions, 409), schema/size/TTL rules, 31-id whitelist, `games` flag, table setup script, token-bucket limiter helper | none | Round trip, idempotency, conflict, isolation, TTL tests pass |
| 4 | **G3a** Foundation shell | Rust `desktop_games_request` + Games window + toolbar button; `shared/games/core` (`rng`, `difficulty` with step params, `scoring`, timed-capable `GameShell`, registry with `kind`); hub shell with tabs; `outbox` (+ `fake-indexeddb`); `gamesRequest` for desktop and website; website/webapp nav + lazy `GamesWorkspace`; import-boundary test; CI test steps | G2 | Empty hub opens on desktop and website; settings round-trip; Rust change rebuilt |
| 5 | **B1** Framework + Speed | `TrialGameDefinition`, `rt.ts`, `scoringBrain.ts`, `generatorHost`, UI primitives, simulated-player harness; Quick Match, Colour Clash, Green Light | G3a | Three games playable at all levels in both clients; sim tests pass |
| 6 | **B2** Memory + Attention | Grid Recall, Sequence Echo, N-Back Stream, Flanker Flock, Needle Finder, Track the Dots | B1 | Six games playable; dot replay deterministic |
| 7 | **B3** Flexibility + Math | Rule Switch, Card Sorter, Flip Map, Number Sprint, Equation Drop, Make Target (+ solver in a Worker) | B1 | Six games playable; solver tests pass |
| 8 | **B4** Reasoning | Pattern Matrix, Number Series, Code Breaker (generators with uniqueness checks) | B1 | Uniqueness holds at every level |
| 9 | **B5** Word | Word assets + `NOTICE` + build script; Anagram Dash, Letter Grid, Word Ladder; lazy loading | B1 | Assets absent from the main bundle |
| 10 | **B6** Brain integration | Brain tab; Dashboard (brain panels), Warm-up (`warmupPool=brain` works; `both`/`market` degrade to brain until G7), brain Review with trial logs, Settings (palette, reduce motion, zoom, sound, practice-tool note), accessibility and performance pass | B1–B5 | Brain-only acceptance passes on the Windows build and in Chrome |
| 11 | **G1** Backend data | `scripts/build-games-index.py`, `GET /availability`, `GET /window` (cache-only, observed-only, integer paise, gzip in route, token bucket) | none (may move earlier) | Tests prove no broker/download call on a miss; payload sizes recorded |
| 12 | **G3b** Market foundation | `GameChart` canvas, `windowCache` (IndexedDB LRU), `seenWindows`, `windows.ts`, `costModel`, `volUnit`; Tick Reader end to end | G1, G3a | Tick Reader playable at all levels, progress saved, memory within §3.5 |
| 13 | **G4** | Entry Sniper, Exit Discipline, Hotkey Drill, Risk Calculator | G3b | Each playable, tested, tuned with owner feedback |
| 14 | **G5** | Level Recall (`levels.ts`), Strike Picker (`optionPricing.ts`), Regime Switch (`regime.ts`) | G3b | Same |
| 15 | **G6** | Spot the Trap (`patterns.ts`), No-Trade Day | G3b | Same |
| 16 | **G7** Integration and close | Market panels on the Dashboard; Warm-up `both`/`market` pools; market Review; market settings (cost model placeholders, hotkeys, rebasing, cache cap, Low memory mode); §3.5 memory/perf pass; final docs; acceptance for both pools | all | Full acceptance on the Windows build and in Chrome; Phase 25 marked complete |

The earlier Track G list (G0–G7) above is superseded in order by this table: G3 becomes G3a + G3b; G0 is closed by a doc-only step; everything else is unchanged.

### Docs updated inside every sprint (not optional)
1. `docs/spec-phase25.md`: sprint status in §14 / §17.11, "as built" notes, and any spec correction (C1–C11) applied to the affected section.
2. This plan: a "`<sprint>` as built" subsection (decisions, deviations, tests, shared files touched), as Track P did.
3. `CLAUDE.md`: the Phase 25 row (status, PR numbers, test counts), updated in the same PR.
4. `docs/phase25-manual-acceptance.md`: that sprint's manual rows, added as the sprint lands.
5. Architecture docs when structure is added: `docs/architecture-backend.md` (G1, G2), `docs/architecture-frontend.md` (G3a onward), and the technical-constraints docs for any new rule (key handlers, Worker budget, z-order, TTL not enforced on DynamoDB Local).
6. Memory: `project_phase25_games.md` (status and how to resume) plus its `MEMORY.md` pointer.
7. PR description: shared files touched (table below) and "no trading logic changed".

| Sprint | Extra docs |
|---|---|
| B0 | This section (interfaces, website findings, word-list decision record and `NOTICE` text, palette, corrections, anchors, roadmap) |
| G0-close | Spec §13 answers table, resampling decision |
| G2 | `architecture-backend.md`: `GameProfiles` schema, size budget, TTL note, `/state` contract; table setup script usage |
| G3a | `architecture-frontend.md`: Games module, window, transports, nav hook; `windowsapp/README.md`: Games window and rebuild note; `frontend-technical-constraints.md`: Games overlay rules; CI note |
| B1 | Spec §17.3 timing rules as built; simulated-player contract |
| B5 | Word-list `NOTICE`, build recipe, measured sizes |
| B6 | Spec §12 "How to add a game" completed with a `TrialGameDefinition` example; Track B acceptance section |
| G1 | `architecture-backend.md`: index file, `/availability`, `/window`; ops note for the index script; `docs/live-history-providers.md` cross-reference |
| G3b | Spec §9 chart notes; memory budget measurements |
| G7 | Spec §11/§16 acceptance results; Phase 25 row set to Complete; final pass on the architecture docs |

### Existing files Phase 25 touches (the real-trading hook points)
Games are new code in new folders (`shared/games/`, `backend/app/{routers,services}/*games*`). They call no order, session, broker, stream, guardrail, strategy or analysis code; an import-boundary test fails the build if they try. Everything lands on `dev`; nothing reaches `preprod` or `main` until promoted.

| Existing file | Edit | Risk |
|---|---|---|
| `frontend/src/App.tsx` (website live-trading screen) | `showGames` flag, one `NavIconButton`, one lazy mount, one `sessionKind` prop (G3a) | Low, but the file to review closely |
| `frontend/src/components/NavIconButton.tsx` | new `games` icon | None |
| `windowsapp/src-tauri/src/lib.rs`, `tauri.conf.json` | `desktop_games_request`, `open_games_window`, handler list, window-event/close handling for label `games`, windows list. Needs a desktop rebuild | Low; the shared window-event handler is the one to review |
| `windowsapp/src/main.tsx`, `windowsapp/src/App.tsx` | `?window=games` branch (none exists today); one toolbar button | Low |
| `backend/app/main.py` | one `include_router` | Low |
| `backend/app/routers/desktop.py` | append `"games"` to `DesktopCapabilities.features` (a plain string list, line 28) | None |
| `scripts/setup-dynamodb-tables.py` | new table entry | None |
| `.github/workflows/desktop-windows.yml` | add `npm test` and `cargo test` steps | None for runtime |

One **runtime** interaction: on the website the Games overlay shares a browser renderer with the live trading screen, so a heavy generator could delay tick handling. Handled by the 8 ms main-thread budget, Worker generators and a lazy chunk (B.2, C7). The desktop Games window is a separate WebView.

### Sprint status (Track B and roadmap)
| Sprint | Status |
|---|---|
| B0 | Done (2026-11-15), awaiting owner review |
| G0-close | Done (2026-11-15), see the table at the end of this file |
| G2 | Done (2026-11-15), see "G2 as built" below |
| G3a | Done (2026-11-15), see "G3a as built" below |
| B1 | Done (2026-11-15), see "B1 as built" below |
| B2 | Done (2026-11-15), see "B2 as built" below |
| B3 | Done (2026-11-15), see "B3 as built" below |
| B4 | Done (2026-11-15), see "B4 as built" below |
| B5 | Done (2026-11-16), see "B5 as built" below |
| B6 | Done (2026-11-16), see "B6 as built" below |
| G1, G3b, G4–G7 | Planned, order above |

### Decisions (defaults applied by B0; owner may overrule)
- **D1** Split G3 into G3a (shell, framework, transports, nav) and G3b (chart, cache, market engine, Tick Reader); G2 + G3a are the prerequisite of B1. G3b needs G1.
- **D2** Words in the exclusion list are not accepted from the player either (as §17.6 says).
- **D3** Spec corrections C1–C4 are applied to the spec when the owning sprint starts, not in B0.
- **D4** On the website, opening Analysis closes Games (a running Progress block asks to quit first).
- **D5** B0 commits the §17 spec as its own commit; this section is the second commit.
- **D6** Build order: brain games first (B1–B6), then market games (G1, G3b, G4–G6), then G7. If market first, B6's Warm-up and Dashboard wait for G7.

### B.1 G2/G3 interfaces the brain games depend on

Status: all specified in §3, §4, §6, §7, §8 and the plan; none implemented. This table is what B0 records and what G2/G3 must deliver before B1.

| # | Interface | Specified in | Exists today | What Track B needs from it |
|---|---|---|---|---|
| 1 | `GameId` union and `registry.ts` | §4.1, §17.2 | no | 31 ids; registry holds both definition kinds. **Both `GameDefinition` and `TrialGameDefinition` need a discriminant `kind: 'market' \| 'trial'`** (neither has one) |
| 2 | `GameShell` (instructions → Practice/Progress → countdown → play → result) | §4.2, §17.3 | no | A timed-block mode: time bar, no pause, Esc asks to quit, focus-loss voiding. Build it in G3 with that mode in mind, or B1 adds it |
| 3 | `difficulty.ts` anchors at L1/5/10/15/20, linear interpolation, level up/down rule | §6.1–6.2 | no | **Must also support stepped and categorical parameters** (e.g. item kind changes at L6 and L13, rule banner mode, reverse recall from L12). Linear interpolation cannot express this. Proposed config shape: `{"steps":[{"from":1,"v":0},{"from":6,"v":1},{"from":13,"v":2}]}` next to `{"anchors":[a1,a5,a10,a15,a20]}` |
| 4 | `scoring.ts` (SessionScore 0–100, category rating `0.7·prev + 0.3·score·levelFactor`) | §6.3 | no | Pure functions; brain `scoringBrain.ts` builds on them |
| 5 | `rng.ts` (mulberry32) | §3.3 | no | Seed = hash of `userId + date + gameId + sessionNo`. Define the string hash now: xmur3 → mulberry32. `sessionNo` = local count of that game's sessions that day (two devices on one day may repeat a seed; accepted) |
| 6 | `gamesRequest` transport | plan "Client structure" | no | Desktop: Rust `desktop_games_request` (allowlist, GET/PUT). Website: `fetch` with `X-User-Id`, modelled on `frontend/src/services/desktopDrawingRequest.ts`. Brain code calls only `/state` (§8.4) |
| 7 | `GET/PUT /state` with `mutation_id`, per-record `revision`, 409 on conflict | §8.4 | no | One write per completed Progress session. Same pattern as `desktop_persistence_service.update_screen` (`revision` condition, `mutation_id`) |
| 8 | `GameProfiles` table (`profile`, `game#<id>`, `day#…`, `month#…`) | §8.5, §17.9 | no | Validation accepts 31 ids; day items `expires_at` ≈ 200 days and ≤ 2.5 KB; ≤ 20 stats keys |
| 9 | `games` flag in `DesktopCapabilities.features` | §3.2 | `features` is a plain string list (`routers/desktop.py:28`) | Append `"games"`. Hides the Games button against an older backend |
| 10 | `outbox.ts` (IndexedDB) | §3.3 | no | Queue the one write; flush on reconnect. Desktop vitest runs in plain node, so `fake-indexeddb` is a **new dev dependency** (G3) |
| 11 | Hub (tabs Brain / Market / Dashboard / Warm-up), ResultScreen, Dashboard, Warm-up, Review, Settings | §7, §17.8 | no | Brain adds tabs and panels; ResultScreen needs a per-trial review variant |
| 12 | Desktop Games window (`?window=games`, label `games`, Tauri capability, close handling) | plan correction #11 | `windowsapp/src/main.tsx` has **no** window routing at all today; it renders `<App/>` | G3 adds the branch. Brain games need nothing more |
| 13 | Website/webapp nav and lazy `GamesWorkspace` | plan "Client structure" | no | Detailed in B.2 below |
| 14 | Import-boundary test | §3.4, §17.7 | no | Needs an allow-list (see correction C8) |
| 15 | Package layout | §3.3 says `windowsapp/src/games/`; plan and §17.7 say `shared/games/` | n/a | `shared/games/` is canonical. Propose `shared/games/core/` (framework, imported by both pools), `shared/games/market/`, `shared/games/brain/` |

Desktop test environment: vitest `2.1.9`, plain node, no jsdom. Components are tested through pure model functions. Existing desktop tests already import from `../../shared/...`, so engine tests for `shared/games/**` run in the desktop vitest. The website has no unit-test runner (only Playwright and a few `*.test.mjs`), so the Playwright smoke in §17.10 is the website test.

**Decision D1 (needs the owner):** G3's first deliverable is "Tick Reader end to end", which needs G1 (market data). Track B must not wait for that. Recommended: **split G3 into G3a and G3b** and make G2 + G3a the prerequisite of B1.
- G3a = Rust `desktop_games_request` + window, shared framework (`rng`, `difficulty` with steps, `scoring`, `GameShell` incl. timed mode), hub shell with tabs, outbox, `gamesRequest` for both clients, website/webapp nav, import-boundary test, `fake-indexeddb`.
- G3b = `GameChart`, `windowCache`, market engine pieces, Tick Reader (needs G1).
- G2 (backend persistence) is unchanged and needed first.
Alternative: finish G1–G3 entirely before any brain game (slower, no benefit to Track B).

### B.2 Website live-session behaviour (verified in `frontend/src/App.tsx`)

How Browse behaves with a live session (all line numbers in `frontend/src/App.tsx` unless stated):
- **Nav button is always shown** (`:2274`), also during a live session. It toggles `showBrowse`.
- **Default view:** `showBrowse` starts true only if localStorage `tradematangi_workspace_<userId>` has no `sessionId` (`:324`). The restore effect sets it true when no session attaches (`:649`) and false when one does (`:654`, and on restore failure `:678`).
- **Starting or attaching a session always leaves Browse** (`:328`, an effect on `sim.sessionState`). Toggling Browse manually during a live session is allowed and sticks.
- **Overlay, not replacement:** `BrowseWorkspace` renders `position: fixed; z-index: 20` under the measured header (`components/browse/BrowseWorkspace.tsx:77`). The trading layout is **unmounted only when `showBrowse && idle`** (`:2663`). With a live session it stays mounted underneath, so streams, candle alerts, guardrail popups and notifications keep running. This matches §17.7's "mounted but hidden".
- **Analysis closes Browse's mount:** `showBrowse && !showAnalysis` (`:2503`). One chart set on screen at a time.
- **Counter-examples to avoid:** `showPatternLibrary` (`:2197`), `showChartStructures` (`:2046`), `showSwing` (`:2195`) early-`return` a different tree and unmount the trading panes.
- **Global key handlers that exist:** only Escape handlers: `App.tsx:371` (`window`, cancels price-pick), `App.tsx:390` (`document`, only while an entry ticket is open), `components/Chart.tsx:658` (`window`). There are **no global trading hotkeys** on the website, so the keyboard hazard is small. A game's root-element handler that calls `stopPropagation` keeps Escape (and everything else) from reaching these.

Design for Games on the website (one hook in `App.tsx`, nothing else existing):
- `showGames` flag, one `NavIconButton icon="games"`, one lazy `GamesWorkspace` overlay using Browse's measured-offset pattern. Never `display: none` the trading screen and never unmount it while a session runs.
- **Mutual exclusion:** opening Games closes Browse and vice versa. Opening Analysis closes Games (Games, like timed blocks, would void on blur anyway; if a Progress block is running show the standard "quit?" confirm first).
- **Session banner (§3.4 #5):** `App.tsx` passes one prop, `sessionKind: 'none' | 'sim' | 'paper' | 'real'`, to `GamesWorkspace`. The workspace never imports session or sim modules. For `real`, show the non-blocking banner and keep sound off.
- **z-order check in G3a:** overlay z-index 20 must sit below the guardrail popup, ConfirmModal, Kotak TOTP and notification toasts. Verify and write down the actual values.
- **New requirement (omitted from §17), main-thread budget on the website.** Games share a renderer with live trading and the SSE streams. A long synchronous task (Boggle trie solve, Make Target exhaustive search, ladder graph build, matrix uniqueness check) delays tick handling and button clicks. Rule: no game task over **8 ms** on the main thread while a session is active. All heavy generators (`makeTarget`, `boggle`, `ladder`, `matrix`, `series`, `mastermind`) and word-list parsing run in a **module Web Worker** behind a `GeneratorHost` interface (desktop may run inline since the Games window is its own WebView). Generate the next puzzle while the current one is played. Canvas games pause rendering on `visibilitychange`. Test: a vitest benchmark records worst-case generator time per level and fails over a budget.
- **Desktop:** nothing to verify beyond G3's own window work; the Games window is a separate WebView.


#### B.2 addendum: values read at B0 time (2026-11-15)
- Session state type: `'idle' | 'running' | 'paused' | 'ended'` (`frontend/src/hooks/useSimulation.ts:9`). `sessionKind` for `GamesWorkspace` is derived in `App.tsx` from `sim.sessionState` and `sim.sessionType` (`'real'`, `'paper'`, else simulated); the workspace itself never sees `sim`.
- z-index values in use: Browse overlay 20; header dropdown 100; swing sidebar parts 5–40; AI chat and Settings modal 1000; swing order backdrop 1500; `ConfirmModal`, `KotakTOTPModal` and `GuardRailPopup` 2000; notification bar 20000 and history 20001. The Games overlay at **z-index 20 (same as Browse)** therefore stays below every modal, popup and notification. No change needed; G3a records this in `frontend-technical-constraints.md`.
- Browse offsets itself with `.website-header` and `.website-chart-tools` measured by `ResizeObserver`/`MutationObserver` (`BrowseWorkspace.tsx:41-59`). Games reuses the same measuring (extract it as a small shared helper in G3a rather than copy it).
- `windowsapp/src/main.tsx` renders `<App/>` only; there is no `?window=` routing today, so G3a adds the branch.

### B.3 Word lists: decision record with measurements

Downloaded into the scratchpad only (nothing committed in B0). Measured with a script run on 2026-11-15.

**Sources**
| Source | Version / location | SHA-256 | Licence (text verified) |
|---|---|---|---|
| ENABLE `enable1.txt` | GitHub mirror `dolph/dictionary` (`raw.githubusercontent.com/dolph/dictionary/master/enable1.txt`), 172,823 words, 1,743,363 bytes | `3f16130220645692ed49c7134e24a18504c2ca55b3c012f7290e3e77c63b1a89` | Public domain. ENABLE `readme.1st` (inside the SCOWL tarball, `r/enable/`): "The ENABLE list has been placed in the Public Domain… No fees, registrations, or contributions are required". SCOWL `Copyright` repeats the full release text, including "Please mention the source and credit us as originators of the list" and the note that the WORD.LST portion of a product may not be legally restricted from redistribution |
| SCOWL | 2020.12.07 (`downloads.sourceforge.net/project/wordlist/SCOWL/2020.12.07/scowl-2020.12.07.tar.gz`, 2,569,810 bytes) | `5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc` | "Copyright 2000-2018 by Kevin Atkinson. Permission to use, copy, modify, distribute and sell these word lists, the associated scripts, the output created from the scripts, and its documentation for any purpose is hereby granted without fee, provided that the above copyright notice appears in all copies and that both that copyright notice and this permission notice appear in supporting documentation." (SCOWL `Copyright`) |

**Verification notes**
- The original ENABLE `WORD.LST` could not be fetched: the Debian `sources.debian.org` path returned 404 and the SCOWL tarball carries only the ENABLE documents, not the list. The mirror was therefore checked indirectly: **161,780 of its 172,823 words (93.6 %) appear in SCOWL's `english-words.*` lists**; the rest are US spellings that SCOWL keeps in its separate `american-words.*` files (for example `color`, `favorite`, `center`, `honor`, `theater`, `gray`, `defense`, `organize` are in the mirror and absent from `english-words`). That fits a genuine ENABLE copy. The licence rests on the ENABLE text above, not on the mirror's own (absent) licence file. To be re-verified in B5 against a second source if one can be found.
- SCOWL levels used: `english-words.{10,20,35,40,50,55,60}` plus `american-words.{10…60}`. The `american-words` files are needed because ENABLE is American: leaving them out drops about 1,000 common words ("color", "favorite", "center"). They are generated with VarCon, which brings an Ispell-derived licence notice (below). Levels 70, 80 and 95 are **not** used (80 brings ENABLE-supplement and UKACD, with its verbatim-notice clause; 95 brings more).
- Correction to the earlier plan text: levels ≤ 60 are **not** free of the WordNet notice. SCOWL's `Copyright` ties the WordNet licence to the inflection database used from level 35 up, so the WordNet notice goes in `NOTICE` too. All notices below are permissive (copyright and permission notices must travel with the files, no copyleft, no share-alike).
- Rejected: `dolph/dictionary` `popular.txt` (built from Wiktionary frequency lists, CC BY-SA; no licence file), `first20hours/google-10000-english` (licence not stated on the page; derived from the Google n-gram corpus; swear filter from third-party lists), LDNOOBW and similar lists (CC BY-SA family), Wiktionary/wordfreq data (CC BY-SA mix), `/usr/share/dict/words` (mixed provenance, proper nouns; the local machine only has a README there).

**Measured lists** (letters a–z only; offensive words removed; ENABLE as the whitelist for the common list)
| List | Words | Raw | gzip -9 | Front-coded raw | Front-coded + gzip |
|---|---|---|---|---|---|
| Valid, all lengths (ENABLE minus SCOWL exclusions) | 172,758 | 1,742,850 B | 453,109 B | 733,314 B | **244,917 B** |
| Valid, length ≤ 15 | 168,486 | 1,665,579 B | 439,536 B | 711,692 B | 237,087 B |
| Valid, length ≤ 12 | 152,342 | 1,428,052 B | 390,814 B | 632,319 B | 210,837 B |
| Common candidate (SCOWL ≤ 60 ∩ ENABLE, length 3–9, english + american) | 50,312 | 408,407 B | 129,438 B | 206,338 B | 68,535 B |

- **Valid list decision:** ship **all lengths, front-coded** (sorted, one prefix-length character then the suffix; decoded on load). It meets both budgets (733 KB raw ≤ 1.5 MB; 245 KB gzipped ≤ 500 KB) with no loss of words. Plain text fails the raw budget (1.74 MB); the length cap is not needed.
- **Trie memory:** the valid list has 387,889 trie nodes. A typed-array first-child/next-sibling trie is roughly 5 MB; an object-per-node trie would be 40 MB or more. **Rule: typed-array trie only**, which keeps the §17.6 limit (under 40 MB) with a wide margin.
- **Common list decision:** SCOWL ≤ 60 gives 50,312 words (tier by SCOWL level: tier 1 = level ≤ 35, tier 2 = 40–50, tier 3 = 55–60):

| Length | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|
| Words (all tiers) | 634 | 2,511 | 4,947 | 8,024 | 11,189 | 12,116 | 10,891 |

  Tier counts: tier 1 = **29,645**, tier 2 = 12,907, tier 3 = 7,760. The spec's 20–30k target is met by **tier 1 alone**. So: `common` = tier 1 (29,645 words; targets, Word Ladder graph and endpoints, Letter Grid denominator per C3/C4); tiers 2 and 3 form a `less common` extension used only for Anagram Dash targets from the tiers in the anchors table. One tiered file (word and tier digit) is shipped: about 69 KB front-coded and gzipped.
- **Excluded words:** SCOWL's own `misc/offensive.1`, `offensive.2`, `profane.1`, `profane.3` give 81 distinct a–z words, of which 65 are in ENABLE (the lists hold many inflected forms already; the rest are not words in ENABLE). This is a small base: B5 writes an in-house `exclude.txt` (slurs, sexual and profane stems and common inflections) and the exclusion test checks both. It is **authored by us**, not copied from a share-alike list. The Games settings page says some words are excluded (D2).
- Length distribution of ENABLE (for the Letter Grid and Anagram planning): 2 letters 96, 3: 972, 4: 3,903, 5: 8,636, 6: 15,232, 7: 23,109, 8: 28,420, 9: 24,873, 10: 20,302, 11: 15,504, 12: 11,358, then falling to 28 letters.

**Draft `NOTICE`** (to be committed in B5 as `shared/games/brain/assets/words/NOTICE`, with the full texts copied from SCOWL's `Copyright`)
1. ENABLE word list: public domain, released by M. Cooper ("thegrendel") with the efforts of Alan Beale; credit given as the originators of the list. The word files are not restricted from redistribution.
2. SCOWL (Spell Checker Oriented Word Lists) 2020.12.07, Copyright 2000-2018 Kevin Atkinson: the permission notice quoted above, verbatim.
3. Components of SCOWL levels ≤ 60 stated public domain by SCOWL: Moby Words II (Grady Ward), Brian Kelk's UK English wordlist with frequency classification, the 12Dicts package and its supplement (Alan Beale).
4. WordNet 1.6 (Princeton University), used in SCOWL's inflection data: the Princeton copyright and disclaimer text, verbatim.
5. VarCon and Ispell-derived word lists (American spellings): Copyright 2000-2016 Kevin Atkinson; Copyright 2016 Benjamin Titze; Copyright 1993 Geoff Kuenning (the Ispell licence text, verbatim). Note that our shipped lists are filtered and re-formatted derivatives of SCOWL output and say so.
6. A statement of the filtering applied (a–z only, ENABLE whitelist, offensive terms removed, lengths), the build script name and the SHA-256 of each source and each shipped file.

**Tests added in B5 beyond §17.10:** both lists sorted and unique, `[a-z]` only, length bounds, excluded words absent, common ⊂ valid, tier digits valid, decoded front-coded file equals the source list, shipped file hashes match `NOTICE`.

### B.4 Palette, symbols (B0 sprint-row items, short)

- **Palette:** Okabe–Ito: orange `#E69F00`, sky blue `#56B4E9`, bluish green `#009E73`, yellow `#F0E442`, blue `#0072B2`, vermilion `#D55E00`, reddish purple `#CC79A7`. The set's black is replaced by light grey `#D0D7DE` because the games sit on `#0d1117`. Colour Clash words: 4 colours = ORANGE, BLUE, GREEN, RED (vermilion); 6 adds YELLOW, PINK (reddish purple). Avoid sky blue vs blue in the same 4-set.
- **Symbol set drawn in code:** circle, square, triangle, diamond, pentagon, hexagon, 5-point star, cross; 6 fills/patterns (solid, stripes, dots, cross-hatch, ring, half). Colour is never the only cue (shape or pattern or label always present).
- No third-party icon packs or fonts.

### B.5 Spec corrections found during B0 (apply when the owning sprint implements; the owner confirms)

| # | Defect in §17 | Why it matters | Fix |
|---|---|---|---|
| C1 | **Grid Recall / Sequence Echo are unbounded for a perfect player** ("until 3 misses"), and `gainTarget 6` is unreachable at L1 (3×3 grid, start span 3 → max sensible span 7 → gain 5 → score 88, below the required ≥ 95) | Fails the "perfect ≥ 95" property; a perfect session never ends | Add `maxSpan = min(tiles − 2, 12)`, `maxTrials = gainTarget + 3`, and `gainTarget(level) = min(6, maxSpan − startSpan + 1)` per level in config. `TrialEngine.next()` already returns null for a cap |
| C2 | **Card Sorter `categoryTarget` 6 is unreachable at `runLength` 10.** 64 cards ÷ (10 + ≈2 search) ≈ 5 categories max | Perfect scores ≈ 83 × perseveration factor | `categoryTarget` L1/5/10/15/20 = 4/5/5/6/6, each ≥ 1 below the perfect-player maximum (`⌊64 / (runLength + 2.5)⌋` = 5/6/6/7/7). Re-check with the simulated player |
| C3 | **Letter Grid `maxPossibleValue` over the valid list** (173k words) includes many obscure words | A human cannot reach 25–55 % of an obscure-inclusive total | Denominator counts only words in the **common** list; any valid word still scores; share capped at 1 |
| C4 | **Word Ladder par** ambiguous: BFS over which list? | Over the valid list par may use words nobody knows | `par` = BFS over the **common** graph. Accept valid-list intermediate words. Score `clamp(par / steps, 0, 1)` so a shorter obscure route cannot exceed 1 |
| C5 | `difficulty.ts` only interpolates | Several levers are steps (item kind, banner mode, reverse recall, rule count, dual n-back) | Add step parameters (B.1 row 3) |
| C6 | "Perfect ≥ 95, random ≤ 25" mixes two things | A perfect player at the RT floor tests scoring math, not human feasibility (e.g. Needle Finder absent trials at 60 items need a full scan) | Define each game's `simProfile`: perfect = always correct at `RT_fast`; random = uniform guess; fast-random = random at `RT_fast`; always/never press for detection games; "consistent solver" is the perfect player for Code Breaker. Human achievability is a **calibration** task per sprint, recorded in the owner's play notes |
| C7 | Website runs games on the trading renderer | Main-thread blocking can delay live tick handling | B.2: 8 ms budget, Worker generators |
| C8 | Import boundary forbids market imports but G3's framework lives in the same tree | The scan would flag legitimate framework imports | Boundary rule: `brain/**` may import `shared/games/core/**` and `shared/*` pure utilities only; it may not import `market/**`, `chart/**`, data or trading modules. Test lists the allow-list |
| C9 | Two definition types with no discriminant | Hub/registry cannot narrow | `kind` discriminant (B.1 row 1) |
| C10 | Seed hash and `sessionNo` unspecified | Review must regenerate a session | B.1 row 5 |
| C11 | Brain trial-log storage unspecified | "≤ 250 trials × 20 sessions × 21 games" can reach several MB | IndexedDB store `brainLogs`, cap 20 sessions per game and a global 5 MB, oldest evicted; tuples of numbers only |

### B.6 First parameter anchors (L1 / L5 / L10 / L15 / L20, provisional)

Conventions: times in ms unless marked s. "step" = categorical (from-level → value). `RT_fast` / `RT_slow` are the speed-factor ends. **Expected trials** for volume check = block seconds ÷ (½(RT_fast+RT_slow) + inter-trial gap). All numbers are first-pass; each owning sprint tunes them from the owner's play with a calibration log. Where a value needs owner play to set, it is marked ◇.

#### Speed
| Game | Parameter | L1 | L5 | L10 | L15 | L20 |
|---|---|---|---|---|---|---|
| Quick Match (60 s, gap 400) | display time | 6000 (= until answered) | 3000 | 1500 | 900 | 600 |
| | response window | 3000 | 2500 | 2000 | 1600 | 1200 |
| | item kind (step) | circles | circles | polygons | mirrored | mirrored |
| | "different" gap (1 = one feature) | 0.2 | 0.4 | 0.6 | 0.8 | 1.0 |
| | RT_fast / RT_slow | 450/1800 | 420/1500 | 390/1300 | 370/1200 | 350/1100 |
| Colour Clash (60 s) | colours k | 4 | 4 | 5 | 6 | 6 |
| | incongruent % | 25 | 35 | 45 | 55 | 65 |
| | neutral % (from L12) | 0 | 0 | 0 | 10 | 15 |
| | response window | 3000 | 2500 | 1900 | 1400 | 1100 |
| | shuffle swatches (step) | no | no | no | yes (L16+) | yes |
| | RT_fast / RT_slow | 550/2200 | 520/1900 | 500/1700 | 480/1500 | 450/1400 |
| Green Light (75 s) | symbol display | 1000 | 850 | 700 | 550 | 450 |
| | interval mean ± jitter | 1000±200 | 1000±300 | 1000±400 | 1000±500 | 1000±600 |
| | NO-GO % | 15 | 20 | 25 | 30 | 35 |
| | rule stage (step) | colour+shape | colour+shape | any circle/any square | mid-block changes | mid-block changes |
| | rule changes per block | 0 | 0 | 0 | 2 | 3 |
| | RT_fast / RT_slow | 280/700 | 270/650 | 260/600 | 250/550 | 240/500 |

#### Memory
| Game | Parameter | L1 | L5 | L10 | L15 | L20 |
|---|---|---|---|---|---|---|
| Grid Recall | grid N×N | 3 | 4 | 5 | 5 | 6 |
| | start span | 3 | 3 | 4 | 4 | 5 |
| | span step (1, or 2 at L1–3) | 2 | 1 | 1 | 1 | 1 |
| | max span | 7 | 12 | 12 | 12 | 12 |
| | gainTarget (C1) | 5 | 6 | 6 | 6 | 6 |
| | max trials | 8 | 9 | 9 | 9 | 9 |
| | flash / gap | 700/200 | 600/200 | 500/200 | 400/200 | 300/200 |
| | modes (step) | sequential | sequential | simultaneous (L8+), reverse (L12+) | reverse | reverse + rotate (L18+) |
| Sequence Echo | item set | 4 pads | 5 pads | 6 digits | 8 digits | 9 digits/letters |
| | start span | 3 | 3 | 4 | 5 | 6 |
| | item time / gap | 800/250 | 650/250 | 500/250 | 400/250 | 300/250 |
| | backward (step) | no | no | yes (L8+) | yes | yes |
| | distractor flash (step) | no | no | no | yes (L15+) | yes |
| | gainTarget fwd / bwd | 6/5 | 6/5 | 6/5 | 6/5 | 6/5 |
| | max span | 12 | 12 | 12 | 12 | 12 |
| N-Back Stream (≈ 90 s) | n (step) | 1 | 1 | 2 | 3 | 4 (L19+) |
| | item time (incl. 500 gap) | 2000 | 1800 | 1500 | 1300 | 1200 |
| | match % | 30 | 28 | 27 | 25 | 25 |
| | lure % (L10+) | 0 | 0 | 10 | 12 | 15 |
| | dual (step) | no | no | no | yes (L16+) | yes |

#### Attention
| Game | Parameter | L1 | L5 | L10 | L15 | L20 |
|---|---|---|---|---|---|---|
| Flanker Flock (60 s) | flankers per side | 2 | 3 | 4 | 5 | 6 |
| | incongruent % | 33 | 40 | 50 | 58 | 66 |
| | display | 1500 | 1200 | 900 | 700 | 500 |
| | response window | 2000 | 1700 | 1400 | 1100 | 900 |
| | position jitter / decoy row (steps) | off/off | off/off | on/off | on/on (L14+) | on/on |
| | RT_fast / RT_slow | 330/1400 | 320/1250 | 310/1100 | 300/950 | 290/800 |
| Needle Finder (20 trials) | set size | 8 | 14 | 24 | 40 | 60 |
| | time per trial (s) | 15 | 12 | 10 | 7 | 5 |
| | absent % | 20 | 22 | 25 | 28 | 30 |
| | mode (step) | feature | feature | conjunction (L7+) | conjunction + 2nd feature (L15+) | same |
| Track the Dots (8 trials) | dots N | 8 | 10 | 12 | 14 | 16 |
| | targets t | 2 | 3 | 4 | 5 | 6 |
| | speed px/s | 80 | 110 | 150 | 190 | 220 |
| | motion time (s) | 5 | 6 | 7 | 9 | 10 |
| | occluder (L12+) / flicker (L16+) | no | no | yes / no | yes / yes | yes / yes |

#### Flexibility
| Game | Parameter | L1 | L5 | L10 | L15 | L20 |
|---|---|---|---|---|---|---|
| Rule Switch (75 s) | rules | 2 | 2 | 2 | 2 | 3 (L16+) |
| | switch pattern (step) | AABB | AABB | random ≈ 50 % | cue with card (L13+) | cue with card |
| | cue lead | 1000 | 1000 | 500 | 0 | 0 |
| | response window | 3500 | 3000 | 2500 | 2000 | 1700 |
| | RT_fast / RT_slow | 600/2200 | 570/1900 | 540/1600 | 520/1400 | 500/1200 |
| Card Sorter (64 cards) | rules in play (step) | 2 | 2 | 3 (L8+) | 3 | 3 |
| | run length | 10 | 8 | 7 | 6 | 5 |
| | ambiguous cards % | 0 | 5 | 12 | 20 | 25 |
| | feedback delay (L15+) | 0 | 0 | 0 | 600 | 600 |
| | categoryTarget (C2) | 4 | 5 | 5 | 6 | 6 |
| Flip Map (75 s) | rules | 2 | 2 | 2 | 2 | 3 (L16+) |
| | change every (trials, min–max) | 10–12 | 8–12 | 6–10 | 5–9 | 4–8 |
| | banner (step) | persistent | persistent (to L6) | timed 1.5 s (L7–12) | none | none |
| | display | 2000 | 1700 | 1400 | 1100 | 900 |
| | RT_fast / RT_slow | 450/1800 | 430/1600 | 410/1400 | 390/1200 | 370/1000 |

#### Math
| Game | Parameter | L1 | L5 | L10 | L15 | L20 |
|---|---|---|---|---|---|---|
| Number Sprint (90 s) | operations (step) | + − | × ÷ added (L5+) | mixed two-step (L9+) | mixed | mixed |
| | max operand | 9 | 20 | 99 | 200 | 999 |
| | negatives (L12+) / decimals (L16+) | no | no | no | negatives | negatives + decimals |
| | soft time T_q (s) | 12 | 9 | 7 | 5 | 4 |
| | expert time per problem (s) ◇ | 2.2 | 3.0 | 4.0 | 5.5 | 7.0 |
| | itemsTarget = round(0.81 × 90 / expert time) | 33 | 24 | 18 | 13 | 10 |
| Equation Drop (90 s / 3 lives) | spawn interval (s) | 4.0 | 3.2 | 2.5 | 1.9 | 1.4 |
| | fall time top→bottom (s) | 14 | 12 | 10 | 8 | 6 |
| | simultaneous max | 2 | 3 | 4 | 5 | 6 |
| | reverse drops (L12+) | no | no | no | yes | yes |
| | target = round(0.85 × scheduled equations) | derived | derived | derived | derived | derived |
| Make Target (8 puzzles) | numbers given | 4 | 4 | 5 | 5 | 6 |
| | target digits | 2 | 2 | 2–3 | 3 | 3 |
| | min solution depth (≤ numbers − 1) | 2 | 2 | 3 | 4 | 5 |
| | time per puzzle (s) | 60 | 50 | 45 | 38 | 30 |
| | tolerance ±2 (L1–6) | yes | yes | no | no | no |

#### Reasoning (speed factor ends given as seconds: RT_fast ≈ 0.15 T, RT_slow ≈ 0.8 T)
| Game | Parameter | L1 | L5 | L10 | L15 | L20 |
|---|---|---|---|---|---|---|
| Pattern Matrix (10) | simultaneous rules | 1 | 2 | 2 | 3 | 4 |
| | options | 6 | 6 | 7 | 8 | 8 |
| | time per puzzle (s) | 90 | 75 | 60 | 50 | 40 |
| | distractor similarity | 0.3 | 0.5 | 0.7 | 0.9 | 1.0 |
| | logical overlay (L14+) | no | no | no | yes | yes |
| | RT_fast / RT_slow (s) | 13/72 | 11/60 | 9/48 | 8/40 | 6/32 |
| Number Series (12) | rule tier | 1 | 2 | 3 | 4 | 5 |
| | terms shown | 8 | 7 | 6 | 6 | 5 |
| | time (s) | 60 | 50 | 40 | 30 | 25 |
| | typed answer (L15+) | no | no | no | yes | yes |
| | RT_fast / RT_slow (s) | 9/48 | 8/40 | 6/32 | 5/24 | 4/20 |
| Code Breaker (6 codes) | code length | 3 | 3 | 4 | 4 | 5 |
| | symbols | 4 | 5 | 6 | 7 | 8 |
| | repeats (L10+) | no | no | yes | yes | yes |
| | guess limit | 10 | 10 | 9 | 9 | 8 |
| | hidden feedback cell (L16+) | no | no | no | no | yes |

#### Word
| Game | Parameter | L1 | L5 | L10 | L15 | L20 |
|---|---|---|---|---|---|---|
| Anagram Dash (90 s) | word length | 4 | 5 | 6 | 7 | 9 |
| | frequency tier (SCOWL ≤ 35 / 50 / 60) | 1 | 1 | 2 | 2 | 3 |
| | soft cap per word (s) | 30 | 25 | 20 | 17 | 15 |
| | hints per block | 3 | 3 | 2 | 2 | 1 |
| | expert time per word (s) ◇ | 8 | 10 | 12 | 14 | 16 |
| | target value = round(0.8 × 90/expert time × (len − 2) × 0.85) | 15 | 16 | 18 | 18 | 27 (recompute from config) |
| Letter Grid (120 s) | grid N×N | 4 | 4 | 4 | 5 | 5 |
| | min word length | 3 | 3 | 3 | 4 | 4 |
| | min solvable words (grid filter) | 25 | 30 | 35 | 45 | 55 |
| | targetShare of common-list value (C3) | 0.25 | 0.30 | 0.38 | 0.46 | 0.55 |
| Word Ladder (5) | word length | 3 | 3 | 4 | 4 | 5 |
| | par (common graph, C4) | 3 | 4 | 5 | 6 | 8 |
| | time per puzzle (s) | 120 | 105 | 90 | 75 | 60 |
| | hints | 3 | 3 | 2 | 1 | 0 |

The simulated-player harness, per game, uses these configs plus the `simProfile` of C6, and asserts: perfect ≥ 95, random ≤ 25, fast-random ≤ 25, always/never press ≤ 5, at L1, L10, L20.


### B.7 Sprints and real-trading check

#### Sprint detail
| Sprint | Deliverables (files) | Tests | Exit |
|---|---|---|---|
| **Prereq** G2 + G3a | per plan; plus step params, timed `GameShell`, `kind` discriminant, `core/market/brain` layout, boundary test | per plan | Hub opens on desktop and website with an empty Brain tab |
| **B1** Framework + 3 Speed games | `shared/games/brain/engine/{trialEngine,rt,scoringBrain,generatorHost}.ts`, `ui/*` primitives, simPlayers harness, `difficulty.brain.json` (Speed rows), games `quick_match`, `colour_clash`, `green_light`; worker scaffold | RT/timing (fake timers, mocked rAF), anticipation exclusion, discard-and-replace, focus-loss voiding, scoring bounds, sim players, boundary and key-handler scans, no-network assertion, Playwright smoke | Three games at all levels in both clients |
| **B2** Memory + Attention | 6 games; deterministic dot trajectories (fixed timestep) for Review replay | span cap tests (C1), n-back lure logic, search-slope stats, replay equality | Six games playable |
| **B3** Flexibility + Math | 6 games; Make Target solver (in Worker) | switch-cost stats, card-sort perseveration, C2 sim check, solver correctness vs brute force, equation schedule determinism | Six games playable |
| **B4** Reasoning | matrix, series, mastermind generators with uniqueness verification | uniqueness at every level, par solver, ambiguity solver, worst-case generation time | Three games playable |
| **B5** Word | word assets, loader, `NOTICE`, build script; three games | asset counts, charset, exclusion, common ⊂ valid, trie vs brute force, lazy chunk assertion (not in main or trading bundle), memory check | Assets absent from main bundle |
| **B6** Hub, dashboard, Warm-up, Review, settings, a11y/perf, docs | Brain tab, filters, brain trend panels, `warmupPool`, trial-log Review, settings (palette, reduce motion, zoom, sound, note), `CLAUDE.md` row, architecture docs, spec §12 example, `docs/phase25-manual-acceptance.md` Track B section | dashboard model tests, warm-up determinism per pool | Acceptance on Windows build and Chrome |

Per sprint (all): branch off `dev`, PR into `dev` (merge commit), docs updated, PR lists shared files touched (expected: the single `App.tsx` nav hook from G3a) and confirms no trading logic changed.

#### Real-trading-path check
Track B adds no backend route, no Rust beyond G3a, and no change to order, session, broker, stream, guardrail or strategy code. Shared file touched in B-work: only `frontend/src/App.tsx` via the G3a nav hook (already in the G3 plan). `App.tsx` is the live-trading screen, so that hook is the one place to review: it adds `showGames`, one `NavIconButton`, one lazy mount and one prop (`sessionKind`).



---

## G0-close: answers to spec §13 (2026-11-15, doc only)

Most answers were verified against the code during Track P discovery and are collected here in one place. "Plan #n" points to the numbered corrections under "Track G" above.

| # | Question | Answer |
|---|---|---|
| 1 | Second-level coverage; semantics of `has_native_second_cadence` and `observed` | NIFTY 236 dates (about 370 KB per file), BSESEN 150, NIFTY option files for 232 dates (about 3,177 files, up to 39 contracts a day). Other symbols have 3–15 dates, so games list **NIFTY and BSESEN only**. `has_native_second_cadence` is always true on gap-filled cached frames, so the index script reads the parquet metadata `native_interval_seconds` and requires `_MIN_DAY_ROWS=20000`. Rows are flagged by the `observed` column (`observed_frame` / `infer_observed` in `desktop_preparation.py`) (plan #1, #2, #12) |
| 2 | Window endpoint: observed rows or flag; helpers; file formats and sizes | Return **observed rows only**, no flag (keeps payloads small and removes the back-fill risk). Read with `pd.read_parquet` plus `observed_frame`; do not use `load_dataframe` (it drops `observed` and downloads in live mode). Real directory is `config.OHLCDATA_DIR` (`/mnt/d/data/dbfolder/ohlcdata` here), not `data/ohlcdata`. `resample_to_candles` is minute-only: **5 s and 15 s resampling is done on the client** from 1 s data (also removes server CPU); the server serves 1 s and 60 s only. Per-request cost is one file read of about 370 KB plus a slice |
| 3 | Where the index script runs; existing maintenance-script pattern | `scripts/` holds ad-hoc scripts run by hand (for example `backup-ddb.py`, `classify_chart_structures.py`); there is no `ddb_maintenance` module and no cron convention in the repo. `scripts/build-games-index.py` is incremental and run **by hand** after data refreshes (documented in `architecture-backend.md` in G1); the endpoint returns `index_missing: true` rather than scanning |
| 4 | Tauri windows and the toolbar button | `open_screen_window` (`windowsapp/src-tauri/src/lib.rs:782`) builds the label `screen:<id>`; `schedule_window_close` (`:897`) and the window-event handler only know `main` and `screen:*`. The capability is inline in `tauri.conf.json` (`"windows": ["main", "screen:*"]`, lines 27–30): add `"games"` there and add `games` handling in `schedule_window_close` and the window-event handler. The toolbar uses `ToolbarActionButton.tsx` / `ToolbarIcon.tsx`; `windowsapp/src/main.tsx` has no `?window=` routing today, so G3a adds that branch (plan #11) |
| 5 | Rust transport and the "three copies" rule | Copy `desktop_settings_request` (`lib.rs:1079`) and `valid_analysis_path` (`:1111`). Three copies, as in Phase 23: backend router (`desktop_games.py`), TS mirror (`gamesApi`/transport with its path validator), Rust command with an exact allowlist (`/api/desktop/v1/games/{availability,window,state}`, GET and PUT only). Parity tests run the same allow/deny cases in vitest and `cargo test`, as `patternsApi.test.ts` does |
| 6 | `DesktopCapabilities` shape | `features: list[str]` in `routers/desktop.py:28`; append `"games"`. No booleans (plan #3) |
| 7 | Persistence helpers; table declaration | `desktop_persistence_service` creates tables lazily (`_ensure_tables`, `PAY_PER_REQUEST`, line 19) and has the revision pattern (`update_screen`: `revision` condition, `mutation_id`). It does not do multi-item transactions, so G2 uses `analysis_sharing.py`'s `transact_write_items` with `TypeSerializer` and `Decimal`/integer conversion (plan #7). Tables are also declared in `scripts/setup-dynamodb-tables.py` (`TABLES` list): add `GameProfiles` there too. No TTL exists anywhere: G2 calls `update_time_to_live` and writes an epoch-seconds `expires_at`; DynamoDB Local does not enforce TTL, so tests assert the attribute only (plan #6) |
| 8 | Existing hotkeys for Hotkey Drill | **None**: the desktop has no hotkey store, so Hotkey Drill uses its own defaults (plan #9). The website has only Escape handlers (B.2) |
| 9 | Config sources for lots, strikes, expiry, symbols | `config.LOT_SIZES` (`config.py:55`), `config.SUPPORTED_SYMBOLS` (`:91`), `options_service.STRIKE_INTERVALS` (`:30`) and `get_expiry_date` (`:103`). NIFTY lot size is 65 in the code, not 75 as the spec example says (plan #8). `/availability` reads these, never copies them |
| 10 | Desktop CI and WebView2 | `.github/workflows/desktop-windows.yml` runs `npm ci` and `tauri build` only; it runs **neither `npm test` nor `cargo test`**, so G3a adds both. A Rust change needs a rebuild and ships with the next desktop release; the updater and version bump follow the existing process. WebView2 (offline installer in `tauri.conf.json`) supports IndexedDB; quota behaviour is checked in G3b with the window cache |
| 11 | Test tooling | Desktop vitest `2.1.9`, plain node environment, no jsdom; components are tested through pure model functions. `fake-indexeddb` is **not** installed and is added as a dev dependency in G3a (outbox) and used again in G3b (window cache). The website has no unit-test runner: use `node --test` `*.test.mjs` for pure code and Playwright for browser smoke |
| 12 | Per-user rate limiter | None exists (the broker history modules have their own provider limits, not per-user). G1 writes a small in-process token bucket in `games_data_service.py`; no global `GZipMiddleware` (it would change every route): compress in the games route only (plan #5) |

**Resampling decision (recorded):** client-side for 5 s and 15 s. **Market anchors:** the §15 table stays as the first pass; G3b/G4–G6 tune it from the owner's play. Spec §13 now points here.

## G2 as built (2026-11-15)

Backend persistence for Games progress. Branch `feat/games-persistence`, PR into `dev`.

- **Files:** `backend/app/services/games_persistence_service.py` (table, validation, `get_state`, `put_state`), `backend/app/services/games_rate_limit.py` (`TokenBucket`), `backend/app/routers/desktop_games.py` (`GET`/`PUT /api/desktop/v1/games/state`), `scripts/setup-dynamodb-tables.py` (table plus TTL), tests `backend/tests/test_games_persistence.py` (68 tests).
- **Shared files touched:** `backend/app/main.py` (one import and one `include_router`) and `backend/app/routers/desktop.py` (`"games"` appended to `features`). No trading logic touched; a test scans the new modules' imports for order, session, broker, stream, guardrail and strategy code.
- **Decisions:**
  - One range query (`day#<today-30d>` to `profile`) returns recent days, all games, all months and the profile; the 30 days are calendar days.
  - The PUT body also takes `month` (the client writes the rollup). `revision` 0 means a new record; mismatches return 409 with the current records and nothing is written.
  - Idempotency is `last_mutation_id` on every written record (no dedupe table). A retry is a no-op only while the same mutation is the latest on all its records; otherwise the client re-reads, as for any conflict.
  - Per-type size caps: profile 4 KB, game 3 KB, day 2.5 KB, month 3 KB, hard 8 KB. A test fills a day record with all 31 games and all categories and checks it stays under 2.5 KB.
  - Only day records get `expires_at` (now + 200 days), and TTL is enabled at table creation. DynamoDB Local does not enforce it.
  - Float to `Decimal` conversion and `TypeSerializer` for the low-level `transact_write_items`, as `analysis_sharing` does.
  - The token bucket is per process (2 requests/s, burst 10); G1 reuses it.
- **Tests:** moto (`mock_aws`) like the other DynamoDB tests, so DynamoDB Local is not needed for the suite (the earlier plan text said it was). One manual smoke against the real DynamoDB Local on `:8000` also passed (create, idempotent retry, stale 409, read, cleanup).
- **Docs updated:** spec §8.4 and §14, `architecture-backend.md`, `backend-technical-constraints.md`, `phase25-manual-acceptance.md` (section F), `CLAUDE.md` row.
- **Manual acceptance:** section F of `docs/phase25-manual-acceptance.md`.

## G3a as built (2026-11-15)

Foundation shell for Games on the desktop, website and webapp. Branch `feat/games-foundation`, PR into `dev`. No game is playable yet (all 31 show "Coming soon"); the first games arrive in B1.

- **Rust (needs a desktop rebuild):** `windowsapp/src-tauri/src/lib.rs`: `valid_games_path` (GET `availability`, `window`, `state`; PUT `state`; nothing else), `desktop_games_request` (only callable from the window labelled `games`), `open_games_window` (main window only; focuses an existing window), the main window's `Destroyed` event also destroys the Games window, both commands in the handler list, cargo test `games_allowlist_is_exact_and_method_scoped` (passes locally). `tauri.conf.json`: `"games"` in the capability's windows list.
- **Shared code `shared/games/`:** `core` (ids and catalogue, `rng`, `difficulty` with step parameters and the level rule, `scoring`, `types` with the `kind` discriminant, `registry`, `progress`, `client`, `paths`, `settings`, `shell`, `uid`), `data` (IndexedDB outbox with memory fallback, `sync`), `ui` (`GamesApp` hub, `GameShell`, `useProgress`, CSS), `games/index.ts` (empty registry). Spec corrections applied: C5 (step parameters), C8 (boundary rules), C9 (`kind`), C10 (seed hash and `sessionNo`).
- **Desktop glue:** `gamesApi.ts` (`gamesRequest`), `GamesWindow.tsx`, a `?window=games` branch in `main.tsx` (lazy; the trading `App` is not mounted), toolbar button in the desktop header (`App.tsx`), shown only when `GET capabilities` lists `games`; a `Games` icon in the shared `ToolbarIcon`.
- **Website glue:** `services/gamesRequest.ts`, `components/games/GamesWorkspace.tsx` (Browse-style overlay), `NavIconButton` icon `games`, and in `App.tsx`: `showGames`, the nav button, the lazy mount, the `sessionKind` prop, mutual exclusion with Browse and Analysis, and one changed condition so an **idle** trading screen is not mounted under Games (`(showBrowse || showGames) && idle`). With a running session nothing is unmounted.
- **Decisions and deviations**
  - **IndexedDB, not the desktop SQLite, for the outbox.** The same code runs in all three clients; the desktop's SQLite is Rust-side and used by the trading cache. `fake-indexeddb` is a dev-only dependency so plain-node vitest can run the real outbox.
  - **Outbox stores the session, not the final records.** The PUT body is rebuilt from the latest server state at send time, which makes the 409 re-apply trivial; a record's `last_mutation_id` tells whether a retry already landed.
  - **The month record is updated on every Progress session** (a `month` entry in the same PUT, `days` counted when a day is first created) instead of rolling the previous month up when a new month starts. Simpler and exact; it costs one more item per write.
  - **`emaScore` stores the moving rated score** (`0.7*prev + 0.3*SessionScore*levelFactor`); a category rating is the mean of its played games' `emaScore`. `best` is the best raw score.
  - **`GET /state` now also returns `user_id`** (needed for the session seed; avoids a call outside the Games routes). G2 tests updated.
  - **Esc and quit:** the shell handles Escape on its own focused element only; there are no global key listeners (tested).
  - **Not done here, by design:** pause UI between rounds (no round-based game yet), the Dashboard's per-game history and Warm-up (B6/G7), a Playwright smoke file. The website flow was checked by hand in a browser against a local backend (below).
- **Tests:** desktop vitest 734 (the shared Games tests run there: 27 core, 10 progress, 13 outbox/sync, 9 boundary, 31 transport); `tsc` clean for desktop and website; desktop and website builds; cargo test for the allowlist; backend `test_games_persistence.py` 68 and the full backend suite. `npm test` and `cargo test` are now steps in `.github/workflows/desktop-windows.yml` (the web assets are built before `cargo test`, because tauri embeds `../dist`).
- **Checked in a real browser (Playwright, local backend, throwaway user):** the Games icon appears; the hub opens as a z-index 20 overlay with the trading screen still mounted; saving Sound, 120 % and Brain-only returned "Saved.", the server holds them, and after a reload the size is 120 %; the only Games request was `GET /api/desktop/v1/games/state`. The test user's record was deleted afterwards. The desktop window itself (Rust, new window) is not checked here: it needs a Windows build (acceptance section G).
- **Shared files touched:** `frontend/src/App.tsx` (the hook above), `frontend/src/components/NavIconButton.tsx` (icon), `shared/analysis/kline/ToolbarIcon.tsx` (one icon entry), `windowsapp/src/App.tsx` (capability check and toolbar button), `windowsapp/src/main.tsx`, `windowsapp/src-tauri/src/lib.rs` and `tauri.conf.json`, `windowsapp/vite.config.ts` (test include), `windowsapp/package.json` and lock (fake-indexeddb), the desktop CI workflow, `backend/app/services/games_persistence_service.py` (`user_id`). No trading logic changed.
- **Docs updated:** spec §14, `architecture-frontend.md`, `frontend-technical-constraints.md`, `windowsapp/README.md`, `phase25-manual-acceptance.md` (section G), this plan, `CLAUDE.md` row.
- **CI fix after the first run (2026-11-15):** the desktop build failed with "Cannot find module '../data/outbox'" because `.gitignore` ignores `data/`, which silently left `shared/games/data/` (4 files) out of the PR; local builds passed because the files existed on disk. Fixed with `!shared/games/data/` in `.gitignore`, a test that no Games file is gitignored, and a clean-worktree rebuild (desktop `tsc`, `vite build`, vitest 735; website `tsc`) before pushing. Lesson: verify a PR from a clean checkout, not from the working tree.
- **Second CI finding (the new `cargo test` step, first time on Windows):** `youtube::tests::saving_fails_loudly_when_the_store_does_not_keep_the_value` failed on Windows (the other 75 Rust tests pass). It assumes the keyring crate's Linux "mock" store, which loses the value; Windows has the real Credential Manager, which keeps it, so saving succeeds. It also wrote `"secret"` into the app's own YouTube connection entry. It is now `#[cfg(not(windows))]`.
- **Sync with preprod (2026-11-15):** `origin/preprod` (the #841 merge commit, no file changes) was merged into this branch so `dev` contains everything on `preprod` once this PR merges (`check-preprod-synced.sh` then passes).

## B1 as built (2026-11-15)

The trial-game framework and the three Speed games: **Quick Match, Colour Clash, Green Light**. Branch `feat/brain-games-b1`, PR into `dev`. Dev is in sync with preprod (`check-preprod-synced.sh` OK at the start).

- **New code (all in `shared/games/`):** `core/trial.ts` (`TrialEngine`, `TrialTiming`, `TrialOutcome`, `TrialLogEntry`, `ReviewRow`); `brain/engine/{rt,trialEngine,scoringBrain,simPlayers,generatorHost}.ts`; `brain/ui/{useTrialBlock.ts,Stimulus.tsx,shapes.ts,palette.ts,ResponsePad.tsx,TimeBar.tsx,KeyHint.tsx,brain.css}`; `brain/config/difficulty.brain.ts`; `brain/games/{quick_match,colour_clash,green_light}/{engine.ts,View.tsx,index.ts}`; `ui/TrialReview.tsx`; registration in `games/index.ts`.
- **Changed:** `core/types.ts` (`TrialGameDefinition` now has `createEngine` and `summarise`; view props gain `seed` and `suspended`; `SessionSummary.review`), `ui/GameShell.tsx` (Practice lets you pick a level, a quit prompt left open over a timed block voids it after 10 s, stats and the per-trial review on the result screen, a fresh seeded stream per session), `ui/games.css`, `boundary.test.ts` (no `Date.now`/timers in `brain/**`).
- **Timing as built (spec 17.3):** onset = rAF timestamp of the frame in which the stimulus is painted (`flushSync` inside the callback); RT = `event.timeStamp - onset`; deadlines on the frame clock; anticipation under 150 ms = error with no RT; a frame over 100 ms or a display more than 2 frames off discards and replaces the trial; losing focus or an open dialog discards the trial and pauses the block clock (the shell voids the block after 10 s). A tab hidden or window blur is handled by listeners; no key listeners anywhere outside the focused game root.
- **Scoring as built (17.4):** choice tasks `(acc - 1/k)/(1 - 1/k)`, detection `hit rate - false-alarm rate`, `100 * skill * (0.6 + 0.4 * speed)` (Green Light 0.7 + 0.3), volume check `completed / (0.6 * expected)`. `expected` = block time over (mid RT + gap).
- **Games.** Quick Match: S/D, exact 50/50 balance per ten trials, kinds by level (circles, polygons, rotated and mirrored), 5 hand-drawn **chiral** polygons (a test proves none has a mirror axis), "different" pairs differ in 1 or 2 features by similarity. Colour Clash: 4 to 6 Okabe-Ito colours, answer buttons carry pattern and number, exact incongruent/neutral shares per 20 trials, shuffled buttons from level 16. Green Light: go/no-go with exact NO-GO share per 20 trials, stage 0 (green circle / red square), stage 1 (any circle / any square), stage 2 (rule changes during the block with a 1.5 s banner), jittered gaps.
- **Spec corrections applied:** C5 (step parameters, in G3a and used here), C6 (below), C9. Typed TypeScript tables replace `difficulty.brain.json` (compile-time checking).
- **C6 in practice (simulated players, 200 seeds per case, levels 1, 10, 20):** perfect = 100 everywhere; always press and never press = exactly 0; random and fast-random: mean 2 to 7, 90th percentile 7 to 25, 5 % to 12 % of runs above 25, worst single run 62 (Green Light level 1, about 6 NO-GO trials per block). So "random <= 25" holds as a statistical property, tested as: mean <= 10, 90th percentile <= 30, at most 15 % of runs above 25. **Calibration note for the owner:** Green Light levels 1 to 5 have few NO-GO trials, so a lucky random run can score well; if that matters, raise the NO-GO count floor at low levels.
- **Per-trial data:** the review (what was shown, answered, correct answer, RT) is built on the device and shown on the result screen; the server stores only the usual game, day and month records (a test checks the review never goes to the transport and a whole block costs one state read and one state write).
- **Checked in a real browser (Playwright, local backend, throwaway user, production build):** all three games render and run a full block; a bot playing Green Light by reading the shape and pressing 350 ms later scored 94 with hit rate 1, no false alarms and a median RT of 361 ms (the RT measurement is accurate to about 10 ms); the Progress records (game, day, month) were saved with the stats and without the review; a Practice block only bumped the practice counter; Esc asks to quit, "Keep playing" resumes, Quit records nothing. Found and fixed on the way: scaled shapes were clipped by the SVG box, the practice-level box was white, button labels crowded the swatch. Also learned: the Vite dev server reloads the page every 60 s here (its HMR websocket points at the production domain), so long browser tests use `vite preview` (noted in `frontend-technical-constraints.md`).
- **Not in B1:** the Web Worker is not wired to anything (no heavy generator yet); Playwright smoke is manual (acceptance section H), no committed script; Dashboard brain panels, Warm-up and Review replay are B6; the Windows build still needs your check (acceptance section H).
- **Tests:** desktop vitest 841 (107 new in `shared/games/brain`: rt, block runner, scoring, generator host, shapes, three games' engines and scoring, simulated players, no-network, registration, and the boundary scans), `tsc` clean for desktop and website, desktop and website builds (Games chunk about 47 KB, 17 KB gzipped, lazy), cargo test unchanged.
- **Shared files touched:** none outside `shared/games/` and the docs (the shell and hub changes are inside it). No trading logic changed.
- **Docs updated:** spec §17.4, §17.7 and §17.11, `architecture-frontend.md`, `frontend-technical-constraints.md`, `phase25-manual-acceptance.md` (section H), this plan, `CLAUDE.md` row.

## B2 as built (2026-11-15)

Memory and Attention: **Grid Recall, Sequence Echo, N-Back Stream, Flanker Flock, Needle Finder, Track the Dots**. Branch `feat/brain-games-b2`, PR into `dev`. Dev was in sync with preprod at the start.

- **Framework additions (`shared/games/`):** `core/trial.ts` (`TrialTiming.fixedCadence`, `StageSpec`, `engine.stages`), `brain/ui/useStagedRounds.ts` (rounds with timed stages, discard-and-replace on a bad frame, focus loss discards the round), `brain/ui/useTrialBlock.ts` (inputs collected for fixed-cadence trials via `combine`, optional block length and `maxTrials`), `brain/engine/span.ts` (span tracker and score shared by the two span games), `createBlock({ anticipation: false })` for answers that are not reactions, and `simPlayers` support for staged and fixed-cadence games.
- **Games:** each is `brain/games/<id>/{engine.ts,View.tsx,index.ts}` with typed anchors in `config/difficulty.brain.ts`, registered in `games/index.ts`.
  - **Grid Recall:** 3x3 to 6x6 grid, sequential (in order), all at once (any order, levels 8-11), reverse (from 12), the response grid turned or flipped by CSS from level 18; span cap `min(tiles - 2, 12)`, gain target `min(6, cap - start + 1)` and at most `gainTarget + 3` rounds (spec correction C1, so a perfect player's session ends and can reach 100).
  - **Sequence Echo:** pads, digits (10+), letters (18+); backward from 8; grey dashed distractor flashes from 15 (intrusions counted); serial-position error profile.
  - **N-Back Stream:** letters (and grid cells in dual mode from 16), exact match share per 20 trials, lures one step off n, fixed pace, a press under 150 ms ignored.
  - **Flanker Flock:** 2 to 6 flankers per side, exact congruent/incongruent/neutral shares per 20, a decoy row and a cue banner from 14, vertical jitter from 10.
  - **Needle Finder:** feature, then conjunction (7+), then extra distractor kinds (15+); set size varies inside a block (half, three quarters, full) so the search slope can be estimated.
  - **Track the Dots:** fixed 120 Hz steps precomputed from the seed (exact replay), wall bounces with small random turns, an occluder from 12, blips on non-target dots from 16; canvas view, dots picked by position.
- **Scoring decisions (also in spec 17.4):** chance-corrected recall accuracy; Needle Finder `100 * (hit rate - false-alarm rate) * speed bonus` (the spec's formula would give a "never found it" player about 25); Track the Dots clamps the mean skill once at the end; N-Back pools both keys. New spec corrections: C12 (Needle), C13 (Track the Dots clamping), C14 (counting judged rounds).
- **Bug found by the browser check and fixed:** fixed-count engines (Needle Finder 20, Track the Dots 8) counted a round when it was handed out, so a round replaced after a bad frame used up one of the eight (a session ended with 7 judged trials). They now count judged rounds, with tests. Also learned: headless Chrome gives no frames during a plain sleep, so frame-driven games look frozen; wait on page text instead (noted in `frontend-technical-constraints.md`).
- **Simulated players (levels 1, 10, 20; 200 seeds, 60 for Track the Dots):** perfect 98 to 100 everywhere (Needle Finder 98); N-Back always/never press exactly 0; random and fast-random: mean 0 to 7, 90th percentile 0 to 25, at most 7 % of runs above 25, worst single run 40 (N-Back level 10). Same statistical thresholds as B1.
- **Checked in a real browser (Playwright, production build, local backend, throwaway user):** a bot reading the page played all six: Grid Recall 100 (spans 3, 5, 7), Sequence Echo (patterned pads, correct recall, no strikes), Needle Finder 98 (16 present, 4 absent, set sizes 4, 6, 8, search time measured at 910 ms for a 900 ms bot delay), N-Back 100 (45 items at the 2 s pace, 12 presses for 12 matches, no false alarms), Flanker 95 (69 trials, 100 % accuracy), Track the Dots (mark, move and answer stages, picking by canvas position, a full session; its trial count exposed the bug above). The test user's records were deleted.
- **Not in B2:** Dashboard brain panels, Warm-up and Review replay (B6); the Web Worker is still unused (no heavy generator yet); the dual-mode N-Back, the distractor flashes and the decoy-row Flanker were exercised by engine tests but not played in a browser; the Windows build is yours to check (acceptance section I).
- **Tests:** desktop vitest 973 (132 new for B2: span, six engines and scorings, simulated-player properties for nine games, registration), `tsc` clean for desktop and website, builds pass (Games chunk about 84 KB, 29 KB gzipped, lazy).
- **Shared files touched:** none outside `shared/games/` and docs. No trading logic changed.
- **Docs updated:** spec 17.4 and 17.11, `architecture-frontend.md`, `frontend-technical-constraints.md`, `phase25-manual-acceptance.md` (section I), this plan, `CLAUDE.md` row.

## B3 as built (2026-11-15)

Flexibility and Math: **Rule Switch, Card Sorter, Flip Map, Number Sprint, Equation Drop, Make Target**. Branch `feat/brain-games-b3`, PR into `dev`. Dev was in sync with preprod at the start (`check-preprod-synced.sh` OK).

- **Framework additions (`shared/games/`):** `TrialEngine.gapAfter(trial, outcome)` (a pause that depends on the outcome: Number Sprint shows a wrong answer for 1 s), `useTrialBlock` returns `last` (the entry just judged, for feedback during the pause) and uses `gapAfter`, `simPlayers` honours `gapAfter`, `brain/engine/arithmetic.ts` (seeded problems shared by Number Sprint and Equation Drop: exact division, carry/borrow control, two-step with brackets, decimals computed in hundredths, the reverse form), and the **Web Worker is now used**: `make_target/solver.ts` is the generator, `makeTarget.worker.ts` the module worker entry, `make_target/host.ts` builds the puzzle set in the worker and falls back to the calling thread (no Worker, blocked by policy, a build without the file).
- **Games:** each is `brain/games/<id>/{engine.ts,View.tsx,index.ts}` with anchors in `config/difficulty.brain.ts`, registered in `games/index.ts`.
  - **Rule Switch:** number / letter (and size from level 16) rule on a digit-and-letter card; F and J keys; predictable A A B B pairs to level 5, random switches (about half) from 6, cue lead 1000 ms, 500 ms, then none. Switch cost, error switch cost.
  - **Card Sorter:** four fixed reference cards (card `i` has colour `i`, shape `i`, `i+1` symbols, so a card's value in a dimension is the reference it matches), a hidden rule that changes after `runLength` correct in a row, ambiguous cards (two dimensions point at one reference), 600 ms feedback delay from level 15, perseverative errors and failures to maintain set. The 64 cards are counted when judged.
  - **Flip Map:** SAME / OPPOSITE (TURN from 16), a rule period of 4 to 12 arrows, banner modes (always, 1.5 s after a change, none with a red flash after a mistake), adaptation cost and perseveration.
  - **Number Sprint:** typed answer, Enter submits, Tab skips; `+ -`, then `x /`, then two-step, negatives from 12, decimals from 16.
  - **Equation Drop:** `createDropSim` is a pure, clock-free simulation stepped by the view each frame (and by the tests on a virtual clock); reverse equations from level 12; combo weighting; the early-death cap of 70.
  - **Make Target:** BFS solver over multisets of the numbers still available (the first layer holding the target is the minimum number of operations), generator builds a reachable target from a random combination and rejects ones with a shorter solution, depth recorded; click number, operator, number, or keys 1-9, + - * /, Backspace undo, R reset.
- **Scoring decisions (also in spec 17.4):** new spec corrections C15 (Card Sorter category target), C16 (Number Sprint soft time and drop time), C17 (Equation Drop wrong-entry cost and spawn pace), C18 (Make Target exact credit).
- **Simulated players (levels 1, 10, 20; 200 seeds, 40 for Make Target):** perfect 100 everywhere (Equation Drop tested at all 20 levels with its own virtual-clock player, perfect never loses a life); random and fast-random about 0 (Rule Switch mean 5, Flip Map 3, Card Sorter and Number Sprint 0, Equation Drop 0 because the random typist dies early).
- **Make Target solver:** matches an independent brute-force search on 300 random small puzzles (reachable and unreachable targets), every generated puzzle replays against the rules and its recorded depth equals the solver's, generation of a whole set at level 20 about 0.5 s (so it must not run on the main thread: the 8 ms budget is why the worker exists).
- **Checked in a real browser (Playwright, production build of the real `GameShell` with the website's Vite config, bots reading the page):** Make Target built its puzzles in a real Worker (`makeTarget.worker-*.js` requested) and a solver bot solved all 8 through the click UI (score 100); Number Sprint level 16 (59 problems, wrong answers shown, two-step and decimals); Equation Drop level 12 (43 cleared, reverse equations solved, combo 43, score 100, the same figures as the simulation); Rule Switch level 8 (49 cards, 26 switches, RT about 670 ms for a 650 ms bot delay); Flip Map level 10; Card Sorter level 15 (a rule-learning bot, feedback arriving about 610 ms after the click). **Not run:** the website's own Games overlay (DynamoDB Local is not available in this WSL: Docker is off, so a user cannot register), nor Windows; the harness mounted the same `GameShell` the overlay uses.
- **Not in B3:** Dashboard brain panels, Warm-up (Number Sprint's `most_missed_op` feeds it) and Review replay (B6); the "Reduce motion" setting for Equation Drop (B6); calibration of `itemsTarget`, `target`, `categoryTarget` and the RT anchors from the owner's play (all provisional); the Windows build is yours to check (acceptance section J).
- **Tests:** desktop vitest 1114 (141 new: arithmetic, six engines and scorings, Make Target solver/generator/host, Equation Drop simulation, registration, simulated-player properties for five more games), `tsc` clean for desktop and website, website build passes (Games chunk 124 KB, 41 KB gzip, lazy; the worker 3 KB).
- **Shared files touched:** none outside `shared/games/` and docs. No trading logic changed.
- **Docs updated:** spec 17.4 and 17.11, `architecture-frontend.md`, `frontend-technical-constraints.md`, `phase25-manual-acceptance.md` (section J), this plan, `CLAUDE.md` row.

## B4 as built (2026-11-15)

Reasoning: **Pattern Matrix, Number Series, Code Breaker**. Branch `feat/brain-games-b4`, PR into `dev`. Dev was in sync with preprod at the start (the sync PR #848 had just merged).

- **Framework additions:** `engine/puzzleHost.ts` (`buildPuzzleSet`: build a game's whole puzzle set in a module Web Worker, or on the calling thread when there is none or it fails; the per-game `new Worker(new URL(...))` stays in the game's own file because the bundler needs the literal path), one shared `reasoning/reasoning.worker.ts` with `reasoning/registry.ts` (the three generators) and `reasoning/host.ts` (`buildMatrices`, `buildSeries`, `buildCodes`). Make Target keeps its own worker from B3.
- **Pattern Matrix:** `generator.ts` builds a 3x3 grid from rules, then `predictions()` (the rule solver) proves every attribute has exactly one predicted value for the ninth cell; `distractorsAreWrong` re-checks the finished puzzle. Distractors differ from the right figure in one attribute (more often at higher levels) or several; options 6 to 8; the dot-mask XOR/AND attribute from level 14. `FigureView` draws figures in SVG (no assets): count 0 to 3 means 1 to 4 shapes.
- **Number Series:** nine rule families (arithmetic, geometric, alternating add/multiply, second-order, squares and cubes plus c, linear recurrence, Fibonacci-like, woven series, digit sum) in five tiers; the solver `fits()` reports every family that reproduces the shown terms and its next term, and a puzzle is kept only if they all agree with the intended one. Distractors are the plausible mistakes (the arithmetic step, the repeated ratio, the second-order guess, off-by-one). Typed answer from level 15.
- **Code Breaker:** exact / misplaced feedback (each symbol counted once), a simple consistent-guess solver gives `par`, the hidden feedback value (level 16+) is skipped by the solver and by the consistency check, the View takes keys 1 to 8, Backspace, Enter, and shows par and the guess count.
- **Bug found by the browser check:** the figure drawing indexed shape positions by `count - 1` while the attribute value is already 0 to 3 (count 0 crashed the view). A render test now draws every figure of every puzzle at four levels.
- **Scoring decisions (also in spec 17.4):** corrections C19 (Code Breaker), C20 (Pattern Matrix uniqueness and attributes), C21 (Number Series solver strictness and early-level number cap).
- **Simulated players (levels 1, 10, 20; 100 seeds):** perfect 100 on all three (Code Breaker's perfect player is the simple solver, hidden value included); random and fast-random about 0 (the Code Breaker level 1 problem in the spec's setup was a 24-code space, fixed as above).
- **Generation time (inline, level 20):** Pattern Matrix about 6 ms for ten puzzles, Number Series a few ms for twelve, Code Breaker about 90 ms for six (the solver enumerates up to 32,768 codes), so none is near the 8 ms budget per task except Code Breaker, hence the Worker.
- **Checked in a real browser (Playwright, production build of the real `GameShell`, bots reading the page):** Pattern Matrix level 14 (the grid draws, ten puzzles answered, per-rule stats, the Worker file loaded); Number Series level 16 typed answers (12 puzzles; a bot with a partial solver solved 8 and every one it solved matched the generator's answer); Code Breaker level 16 with the hidden value (a solver bot using the displayed feedback and "?" solved 5 of 6 within the limit, 100 % consistency, par shown). **Not run:** the website's own Games overlay (no DynamoDB Local here) and Windows.
- **Not in B4:** Dashboard brain panels, Warm-up and Review replay (B6); calibration of the RT anchors and limits from the owner's play (provisional); the Windows build is yours to check (acceptance section K).
- **Tests:** desktop vitest 1213 (99 new), `tsc` clean for desktop and website, website build passes (the Reasoning worker is a separate 11 KB chunk); new: matrix generator and solver, drawing, series solver and generator, code solver and consistency, the three engines and scorings, Reasoning host (inline, through the worker protocol, fallback), simulated players for the three.
- **Shared files touched:** none outside `shared/games/` and docs. No trading logic changed.
- **Docs updated:** spec 17.4 and 17.11, `architecture-frontend.md`, `phase25-manual-acceptance.md` (section K), this plan, `CLAUDE.md` row.

## B5 as built (2026-11-16)

Word: **Anagram Dash, Letter Grid, Word Ladder**. Branch `feat/brain-games-b5`, PR into `dev`. Dev was in sync with preprod at the start.

- **Word assets (`shared/games/brain/assets/words/`):** `valid.fc.txt` (172,631 words, 732,791 B raw, 244,772 B gzipped), `common.fc.txt` (50,264 words with a tier digit: tier 1 = 29,637, tier 2 = 12,883, tier 3 = 7,744; 256,415 B raw, 81,899 B gzipped), `exclude.txt` (192 words removed) and `NOTICE`. Both lists are inside the 1.5 MB raw / 500 KB gzipped budget. Built by `scripts/build-word-lists.py` from ENABLE `enable1.txt` and SCOWL 2020.12.07 (the SHA-256 values of both sources match the B0 decision record; the script is deterministic, a second run produced identical files). **Recipe:** download the two sources, check the hashes, extract SCOWL, run `python3 scripts/build-word-lists.py --enable enable1.txt --scowl scowl-2020.12.07/`. `NOTICE` carries the ENABLE credit, SCOWL's `Copyright` file verbatim (it holds the Moby, 12Dicts, WordNet 1.6, VarCon and Ispell notices), a modification notice (the Ispell licence needs one), the filtering applied and the SHA-256 of every shipped file.
- **Exclusion:** SCOWL's own taboo lists (`offensive.1`, `offensive.2`, `profane.1`, `profane.3`) with common inflections, plus every ENABLE word containing one of the stems fuck, shit, cunt, nigg, cocksuck, whore, slut, bitch, twat, wank (authored in the script, not copied from a share-alike list). Extend `STRONG_STEMS` / `EXTRA_WORDS` and rerun to exclude more.
- **Loading:** `words/loader.ts` is the only place that imports the assets, with `import('...?raw')`, so they are separate lazy chunks (a test scans the sources to enforce it, and the production build was checked: the main bundle holds none of the list). Decoding is `words/wordlist.ts` (front-coded files, and a typed-array trie that the Letter Grid solver uses: the whole valid list is about 388k nodes and a few MB). The words worker (`games/words/words.worker.ts`, `registry.ts`, `host.ts`) decodes the lists inside the worker and the worker ends with the build; on the calling thread the lists are released afterwards.
- **Framework additions:** `installWorkerRuntime` accepts asynchronous generators; `buildPuzzleSet` takes an `afterInline` hook; `TrialTiming.tolerateStalls` (C22). **Vite `worker.format` is now `"es"` in `frontend/vite.config.ts` and `windowsapp/vite.config.ts`:** a worker that uses `import()` cannot be built as the default IIFE (the website build failed until this was set).
- **Anagram Dash:** targets are common words of the level's length and tier (awkward letters preferred as `hard` rises); the accepted answers are every valid anagram, computed in the worker; Shuffle, Hint (30% less, a few per block), Skip (Tab); a wrong word is rejected without ending the word.
- **Letter Grid:** the solver walks the grid with the valid-list trie and returns every valid word with one path; grids are drawn from English-like letter weights and rejected unless they hold the level's minimum common words and a word of six letters or more; the View takes clicks, drags and typing (typed words light their path).
- **Word Ladder:** the neighbour graph comes from wildcard buckets over the common list; pairs are chosen with the level's par; steps may be any valid word; Undo (Backspace on an empty box), Reset, Hint (BFS from where you are).
- **Verification:** the solver is cross-checked against an independent brute-force path enumeration (3x3 and 4x4), ladder distances against Floyd-Warshall, neighbours against a pairwise check, the trie against a Set.
- **Checked in a real browser (Playwright, production build of the real `GameShell` with the website Vite config, bots reading the page):** Anagram Dash level 5 (47 words, score 100; the bot read the tiles and decoded the list from the lazy chunk), Letter Grid level 3 (typed words, a clicked chain, a repeat and a junk word rejected with notices, Finish now), Word Ladder level 10 (five puzzles at par, one hint, bad moves rejected with the right message). The Letter Grid run found the stalled-frame bug (see C22). **Not run:** the website's own Games overlay (no DynamoDB Local here) and Windows. The Tauri content security policy is `script-src 'self'`, which allows same-origin module workers; the desktop falls back to the calling thread if a worker is refused.
- **Not in B5:** Dashboard brain panels, Warm-up and Review replay (B6); calibration of the targets and limits from the owner's play (provisional); the Windows build is yours to check (acceptance section L).
- **Tests:** desktop vitest 1283 (70 new), `tsc` clean for desktop and website, website build passes (Games chunk 181 KB, 58 KB gzipped; the words worker 5 KB; the word lists are their own lazy chunks, 733 KB and 256 KB raw); new: asset integrity (hashes in `NOTICE`, sorted, unique, a-z, exclusions, size budgets, front coding round trip), trie, lazy loader and the import-site scan, the three generators, engines and scorings, the words host (inline, worker protocol with an async generator, error path) and simulated players for the three.
- **Shared files touched:** none outside `shared/games/`, the two Vite configs (`worker.format`) and docs. No trading logic changed.
- **Docs updated:** spec 17.4 and 17.11, `NOTICE`, `architecture-frontend.md`, `frontend-technical-constraints.md`, `phase25-manual-acceptance.md` (section L), this plan, `CLAUDE.md` row.

## B6 as built (2026-11-16)

Integration: **Dashboard, Warm-up, Review, Settings, accessibility pass, docs**. Branch `feat/brain-games-b6`, PR into `dev`. Dev was in sync with preprod at the start. No game logic changed except the two `reducedMotionParams` hooks.

- **New core (pure, tested):** `core/dates.ts`, `core/dashboard.ts` (rows and filter, warm-up streak, trend panels and series, `LocalSession`), `core/warmup.ts` (`buildWarmup`), `SessionResult.warmup` and the day-record step count in `core/progress.ts`, `palette` in `core/settings.ts`.
- **New data:** `data/sessionLog.ts` and IndexedDB version 2 (`sessions` store; the outbox store is untouched, existing databases upgrade in place).
- **New UI:** `Dashboard.tsx`, `Warmup.tsx`, `ReviewTab.tsx`, `SettingsPanel.tsx`, `Sparkline.tsx`, `sound.ts`, `useSessionLog.ts`; `GamesApp.tsx` renders every game through one `renderGame` so the hub, Warm-up and Review record and apply settings the same way; `GameShell` gains `reduceMotion`, `sound`, `replay`, `stepLabel`, `onSkip` and returns the `seed` in `ShellDone`.
- **Spec corrections:** **C23** the server keeps 20 scores per game, not 30. **C24** no short versions: warm-up games run at normal length (Number Sprint 90 s, a quick-games list for the closing step). **C25** Review replays from the seed in Practice mode and records nothing; adaptive games can diverge. Details in spec 17.8 "As built (B6)".
- **Backend:** none. The day record's `warmupDone` already accepted a count; profile `settings` is a free-form object.
- **Checked in a real browser (Playwright, production build of the real `GamesApp` on a throwaway harness with an in-memory server):** the Warm-up plan (brain fallback notice, five steps), a Quick Match step played to the end (one `PUT` with the game, the day totals and `warmupDone: 1`, the step marked done and kept after a reload), Review (the session listed, its trials, "Play these puzzles again" opens the replay screen), Settings (Higher contrast saved into the profile and `data-palette` applied), Dashboard. **Not run:** the website overlay (no DynamoDB Local here), Windows, sound, the Reduce motion slowdown in play, a full five-step warm-up, a streak across days (covered by unit tests).
- **Not in B6:** market games in the Warm-up and the market trend panels (they join with Track G; `TREND_PANELS` and `WARMUP_QUICK` are the extension points); a per-game "short version"; calibration from the owner's play.
- **Tests:** desktop vitest 1326 (43 new: dashboard model, warm-up plan, session log and pruning, progress warm-up PUTs, render tests of the hub screens, palette, reduce motion); `tsc` clean for desktop and website.
- **Shared files touched:** none outside `shared/games/` and docs. No trading logic changed.
- **Docs updated:** spec 12 (how to add a game, with a `TrialGameDefinition` example), 17.8 and 17.11, `architecture-frontend.md`, `phase25-manual-acceptance.md` (section M), this plan, `CLAUDE.md` row.
