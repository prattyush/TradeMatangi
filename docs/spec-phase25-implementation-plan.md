# Phase 25 — Implementation plan (Patterns port + Brain Games)

Approved 2026-11-14. Source of truth for sprint order; update the status column as sprints merge.


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
| P2 | Pattern Library on KLine (desktop-only, core) | In PR into `dev` (branch `feat/desktop-pattern-library`); P2b (drawing tools, R:R, Top Patterns, extra panes, bulk delete) planned |
| P3 | Chart Structures (Broad) | Planned |
| P4 | Fine Structures | Planned |
| P5 | Docs, Windows acceptance | Planned |

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
