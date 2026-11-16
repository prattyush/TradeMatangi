# Trade Matangi — Frontend Architecture

---

## Overview

The frontend is a **React + TypeScript** single-page application built with **Vite**, running at **port 5173**. It displays live OHLC candlestick charts powered by [Lightweight Charts v4](https://tradingview.github.io/lightweight-charts/docs), provides trading controls (buy/sell, orders, strategies), and hosts the AI Helper chat overlay.

Design principles:
- No Redux or Zustand — all session state lives in `useSimulation.ts` custom hook; cross-component state in `App.tsx`.
- P&L computed entirely on the frontend from local `trades` and `position` state — no backend round-trips for display.
- SSE for real-time ticks, order fills, and AI-placed trade notifications.
- `localStorage` for ephemeral preferences (brokerage, strategy settings); backend `UserSettings` DynamoDB for persistent per-user preferences (funds ratios, historical days, analysis price source).

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  App.tsx                                                             │ │
│  │  ├── auth gate (LoginScreen)                                         │ │
│  │  ├── pane config + layout state                                      │ │
│  │  ├── useSimulation hook  (session state, trades, positions, orders)  │ │
│  │  ├── useSSE hook         (EventSource → handleSSEMessage)            │ │
│  │  └── renders:                                                        │ │
│  │       Header | SessionControls | Chart×N | TradePanel |              │ │
│  │       OrderPanel | TradeHistory | AIChatPanel | SettingsModal        │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  api.ts                                                                   │
│  ├── REST calls to Backend  (port 8700)                                  │
│  └── REST calls to aihelper (port 8701)                                  │
│                                                                           │
│  useSSE.ts                                                                │
│  └── EventSource → GET /api/stream/{session_id}  (port 8700)            │
└─────────────────────────────────────────────────────────────────────────┘
         │  REST                          │  SSE
         ▼                               ▼
   Backend :8700                  Backend :8700 /api/stream/{id}
   aihelper :8701
```

---

## Component Hierarchy

```
App
├── LoginScreen                  (shown when not authenticated)
└── (authenticated)
    ├── Header
    │   ├── Day P&L display
    │   ├── BLOCK button (guardrail override)
    │   ├── WalletWidget
    │   ├── TradeAnalysis button
    │   └── SettingsModal (gear icon)
    ├── SessionControls
    │   ├── Symbol + date picker
    │   ├── Options strike/expiry picker
    │   ├── Start / Stop / Pause / Resume
    │   └── Layout preset + Add/Remove pane controls
    ├── GuardRailPopup            (modal overlay when guardrail fires)
    ├── Chart column  (1–4 panes, rendered by renderLayout())
    │   └── Chart (one per pane)
    │       ├── Lightweight Charts candlestick series
    │       ├── EMA line overlays (20/50/200)
    │       ├── Trade markers (one invisible Line series per trade)
    │       ├── Open order price lines (dashed horizontal)
    │       └── Drawing tools (H-Line, Trendline, Fibonacci, Rectangle)
    ├── Right sidebar
    │   ├── TradePanel           (current price, position, P&L, Buy/Sell buttons)
    │   ├── Combined P&L widget  (options sessions — CE + PE total)
    │   ├── OrderPanel           (place Limit/Target/Stoploss orders, strategy controls)
    │   └── TradeHistory         (trade list, reconcile button for real trading)
    └── AIChatPanel              (floating overlay, draggable)
        ├── Chat tab             (message history, input)
        ├── Commands tab         (active/executed/cancelled AI commands)
        ├── Hotwords tab         (saved hotword strategies)
        └── Templates tab        (entry/exit command templates)
```

---

## State Management

### `useSimulation.ts` — Central session state

All per-session data lives here. `App.tsx` calls the hook and passes derived slices as props to child components.

| State field | Type | Purpose |
|------------|------|---------|
| `sessionId` | `string \| null` | Current session identifier |
| `sessionState` | `idle\|running\|paused\|ended` | Session lifecycle |
| `symbol` | `string` | e.g. `"NIFTY"` |
| `latestEquityTick` | `TickEvent \| null` | Last received NIFTY/equity bar |
| `latestCETick` / `latestPETick` | `TickEvent \| null` | Last received CE/PE bar |
| `currentPrice` | `number` | Latest equity close |
| `currentPriceCE` / `currentPricePE` | `number` | Latest options close |
| `trades` | `Trade[]` | All filled trades for the session |
| `historicalTrades` | `Trade[]` | Trades from prior sessions (same symbol+date+type) |
| `position` | `Position` | Equity net position |
| `positionCE` / `positionPE` | `Position` | Options positions |
| `openOrders` | `Order[]` | PENDING orders (shown as chart price lines) |
| `sessionCapital` | `number` | Wallet balance at session start (for P&L %) |
| `sessionStrikeCE` / `sessionStrikePE` | `number \| null` | Active streaming strikes |

**P&L computation** — done inline in the hook, never fetched from backend:
```
pnl = direction × quantity × (currentPrice − avgEntryPrice)
```

**`latestEquityTickRef`** — a `useRef` kept in sync by `setLatestTick`. Allows `buy()`, `sell()`, and `addTradeFromSSE()` to read the current NIFTY price synchronously without adding `latestEquityTick` to their `useCallback` dep arrays. Used to stamp `underlying_price` on CE/PE trades for cross-chart markers.

### `App.tsx` — Cross-component state

| State | Purpose |
|-------|---------|
| `panes: PaneConfig[]` | Which charts are shown (type, interval, strike, expiry, right) |
| `layoutPreset: 1\|2\|3\|4` | Column/row arrangement of chart panes |
| `instrumentType: 'equity'\|'options'` | Current session instrument |
| `activePaneId` | Which pane is "focused" for trading |
| `runningStrategies` | List of active automated strategies |
| `guardrailPopup` | Guardrail alert state |
| `pricePickOrderId` / `tpPickActive` | Chart price-click modes |

---

## Chart Rendering (`Chart.tsx`)

Each `Chart` instance wraps a single Lightweight Charts `IChartApi`. There can be 1–4 simultaneous chart instances on screen.

### Pane types

| `paneType` | Data source | Tick routing |
|-----------|------------|-------------|
| `equity` | `GET /api/data/historical` | `sim.latestEquityTick` |
| `options` | `GET /api/data/options-historical` | `sim.latestCETick` or `sim.latestPETick` (matched by `pane.strike`) |

### Live candle construction

Ticks do not arrive as closed candles. The chart maintains `liveWindowRef` — a rolling `Map<barSlot, {open,high,low,close}>`. On each tick:
```
barSlot = Math.floor(tick.time / (intervalMinutes × 60)) × (intervalMinutes × 60)
if barSlot not in liveWindowRef:
    open = close of previous slot (or tick.close if first)
    liveWindowRef.set(barSlot, {open, high: tick.close, low: tick.close, close: tick.close})
else:
    update high = max(high, tick.close)
    update low  = min(low,  tick.close)
    update close = tick.close
series.update({time: barSlot, open, high, low, close})
```

This epoch-aligned formula must match the backend's `pandas resample("3min")`.

### Trade markers

Each filled trade gets its own invisible `LineSeries` added to the chart (Lightweight Charts limitation: candlestick series markers snap to OHLC extremes). The `setMarkers()` call on the line series places the circle at the exact execution price.

**Equity chart markers (own trades):**
| Side | Color | Text |
|------|-------|------|
| BUY | `#FFFFFF` (white) | `B` |
| SELL | `#00AAFF` (blue) | `S` |

**CE/PE trades mirrored onto the underlying NIFTY chart** (cross-chart markers):
| Options trade | Underlying direction | Color | Text |
|---|---|---|---|
| CE Buy | Buy (bullish) | `#26a641` (green) | `CB` |
| CE Sell | Sell (bearish) | `#cf6679` (pink-red) | `CS` |
| PE Buy | Sell (inverted — PE buy = underlying bearish) | `#9a6dd7` (purple) | `PS` |
| PE Sell | Buy (inverted — PE sell = underlying bullish) | `#d4a72c` (amber) | `PB` |

Cross-chart markers are placed at `trade.underlying_price` (NIFTY close snapshotted in `useSimulation.ts` when the CE/PE trade was added to state).

### Open order price lines

PENDING orders are shown as dashed horizontal price lines (`series.createPriceLine()`). Stoploss lines include a PnL label. Lines are removed when the order fills or is cancelled.

### EMA overlays

Computed client-side from the loaded historical candles array. Three EMAs (20/50/200 period) rendered as `LineSeries` overlays on top of the candlestick series.

### Drawing tools

User-drawn overlays stored in component state: H-Line, Trendline, Fibonacci retracement, Rectangle. All but Rectangle are rendered as additional `LineSeries` or `PriceLine` elements; Rectangle is a series primitive (`indicators/rectanglePrimitive.ts`) whose fill colour/opacity come from Settings -> Display (`drawingFillColor` / `drawingFillOpacity` in the per-user chart-settings record). The former Parallel Channel tool was removed; stored `channel` drawings are ignored on restore.

---

## Browse (website and webapp)

The landing view when no session is running (a session that was running when the page was last used keeps the screen on Trading; starting or attaching a session leaves Browse; a header button, `📈 Browse` / `← Trading`, switches by hand). `components/browse/BrowseWorkspace.tsx` is a fixed region under the header with the trading screen's layouts (`services/browseWorkspace.ts`: 1, 2, 3, 4, 5 equal, 5 wide right, 4 as 1+3; the layout `<select>` is portalled into a slot, `browseSlot.ts`, of the existing header row, so Browse adds no row). Each pane (`BrowsePane.tsx`) has **its own symbol, day, spot or CE/PE contract and interval**, drawn by the same chart host as the trading screen (`BrowseChart.tsx` → `TradingChartHost` with `externalCandles` / `externalLoadOlder`, read-only, like `SwingChart`): **Lightweight when the Trading Chart setting is Lightweight, KLine when it is KLine**, and the chart's own interval control sets the pane's interval. The one control is `BrowsePaneMenu.tsx`, a button placed first in the chart's own header row (`headerStart`, an optional prop of `Chart.tsx` and the shared `KLineChart`) that opens a panel for symbol, day (a month calendar, `BrowseCalendar.tsx`: the month arrows only move between months and nothing loads until a day is clicked; weekends and days after today are greyed out), Spot | CE | PE and strike (the day's 43-strike ladder) or Max price (presets from `shared/optionPremiumPresets`); its open state is held by the pane because changing the symbol rebuilds the chart. `usePaneContract.ts` loads the day's expiry and ladder (`option-metadata` + the underlying's 09:30 price) and runs the Max price search through `trading/prepare-session` (`mode: browse`, the website's `X-User-Id` accepted for that mode only). Data: `services/browseApi.ts` asks every history call for `granularity=minute` (`/api/data/*`), and index / equity panes scroll back through `GET /api/desktop/v1/browse/history` (`useBrowseCandles.ts`; a year or more by interval, see `docs/live-history-providers.md`); option panes keep about 3 days. The panes (layout, symbols, days, strikes, caps, intervals) are saved per user in `localStorage['tradematangi_browse_<userId>']` and restored on the next visit (a damaged entry falls back to the default two panes). The chart height is the pane's height less the Lightweight toolbar (`data-chart-toolbar`, which can wrap on a narrow pane), so the time axis is never cut off. While Browse covers an idle trading screen, that screen's charts are not mounted, so they download nothing. KLine's shared drawing/indicator rail sits at the left of the page: Browse starts beside it. The webapp is the same code (it imports `WebsiteApp`).

## Desktop Tools: Patterns, Chart Structures, Fine Structures (Windows app)

Three tools under the desktop **Tools** view (`windowsapp/src/tools/ToolsView.tsx`, one `TOOLS` entry each; Chart Structures holds the Broad and Fine tabs), ported from the website pages (`frontend/src/pages/PatternLibrary.tsx`, `ChartStructures.tsx`, `FineStructures.tsx`, which stay on lightweight-charts and are unchanged). The desktop versions are new code on the **KLine** chart: they reuse the desktop Analysis chart (`shared/analysis/kline/AnalysisChart.tsx`, saved marks as `analysisAnnotation` overlays, click-to-pick, the drawing rail) rather than a second chart stack. The tools are user notes and read-only candles: no order, session, broker or stream path is reachable from them.

- **Transport.** `patternsApi.ts` (`validPatternsPath`, `patternsRequest`) calls the Rust command `desktop_patterns_request`, whose allowlist (`valid_patterns_path` in `windowsapp/src-tauri/src/lib.rs`) is mirrored case for case in TS and Rust tests. It reaches `backend/app/routers/desktop_patterns.py`, which re-registers the website's `pattern`, `chart-structures` and `fine-structures` routes under `/api/desktop/v1/patterns/...` with a desktop-bearer-only identity, plus four read-only data helpers (`symbols`, `price-at`, `expiry`, `options/find-strike-by-price`). Candles are minute data (same as Browse).
- **Client and runtime.** `patternsClient.ts` holds the typed calls and types. `usePatternsRuntime.ts` builds the client, the Analysis environment (with the drawing transport `desktop_drawing_request` and the catalogue instrument lookup) and the account settings (Max Price mode and caps, historical days come from `trading/settings/current`, not localStorage).
- **Pattern Library** (`PatternLibrary.tsx`, pure logic in `patternLibraryModel.ts`): load a day as underlying or underlying + CE/PE (OTM offset or Max Price strikes, separate CE and PE strikes saved), mark entry/exit per instrument with category and strategy, Top Patterns, R:R per pattern (the optional `riskRewardRatios` prop of the shared `AnalysisChart`), extra CE/PE strike panes, drawings, Saved charts with filters and bulk delete.
- **Chart Structures, Broad** (`ChartStructures.tsx`, `chartStructuresModel.ts`): filter gallery (Opening, Midday, Closing), lazy sparklines (`IntersectionObserver`), day view on KLine with previous/next and the classification editor (system or shared structures are copied, own ones updated).
- **Fine Structures** (`FineStructures.tsx` with `FineBuilder.tsx`, `FineSearch.tsx`, `FineDefinitions.tsx`, `fineStructuresModel.ts`): definitions, a flow builder (a flow per pane, transition bars set by clicking a candle, saved with the chart interval) and sequence search with `Any` wildcards. The three views stay mounted behind their tabs.
- **Differences from the website:** the saved flow is found by day, instrument type and right; Search shows the day's ATM contract (from the 09:15 price) for options flows; transition labels are short and numbered because KLine cuts marker text; no sharing actions (the website pages have none).
- Plan, as-built notes and acceptance: `docs/spec-phase25-implementation-plan.md`, `docs/phase25-manual-acceptance.md`.

## Patterns Deep Dive (Phase 26; shared module, desktop and website)

`shared/deepdive/` is the host-agnostic part of the Deep Dive (one strategy studied across marked days, with **tags** marked valid / not valid and frequency percentages). Nothing in it knows a chart library or a transport.

- `types.ts`: the shapes of `/api/deep-dive` and `DeepDiveApi`, the injectable client every screen takes (like `BehaviorApi`).
- `client.ts`: `createDeepDiveClient(request)` builds every call from one list of `deep-dive/...` paths. The website passes a fetch over `${BACKEND_URL}/api/` (`deepDiveApi` in `frontend/src/services/api.ts`, errors read from `detail`); the desktop reuses its patterns transport (`createPatternsClient(...).deepDive`, which the Rust and TS allowlists already cover). Because the paths are shared, a test asserts that `validPatternsPath` accepts every path the client builds.
- `calendar.ts`: month grids (Monday first, no time zone), `shiftMonth`, `pickableDay` (a weekday before today; holidays are the server's call), `lastPickableDay`.
- `model.ts`: pure logic: `orderSetups` (date ascending, Buy before Sell), `dayMarksByDate`, `removalImpact` (what un-marking a side throws away), `toDiveSetup` / `withSetups` (local updates after a save), tag states (`tagState`, `toggleTag`, `restNotValid`), gaps (`gaps`, `isComplete`, `nextGapIndex`, `unmarkedDaysForTag`), `validateTagName`, position and date labels, and the percentage wording (`formatPct`, `tagLine` "Double top: 70% (n=14)", `thinNote`, `successLine`, `findStats`, `defaultSideForTrade`). An archived tag never counts as missing.
- Tests: `windowsapp/src/deepDive.test.ts` (the desktop vitest is the only runner that reaches `shared/`).
- **Desktop screens** (`windowsapp/src/tools/deepdive/`, a third **Deep dive** tab in the Pattern Library next to Annotate and Saved charts): `DeepDive.tsx` (list, then one dive), `DiveHome.tsx` (the dives and the start form: category and strategy through `PatternNameSelect`, symbol), `DateMarking.tsx` with `DiveCalendar.tsx` (step 1: each day has its own **B** and **S** buttons, so a click can never swap a side; the day number shows that day's KLine chart; removing a side that has tag marks, chart marks, an outcome or notes asks first; a shared dive is read-only). Tests: `tools/deepdive/deepDiveScreens.test.tsx`.
- The website mode, the in-depth step, the results and the label-form panel come in later sprints; see `docs/spec-phase26-implementation-plan.md`.

## Games (Phase 25; desktop window, website and webapp)

One shared codebase, `shared/games/`, used by the separate desktop **Games window**, the website and the webapp. Everything is client side; the only server contact is `GET`/`PUT /api/desktop/v1/games/state` (progress) and, for the market games only, the cache-only `GET availability` and `GET window` (`docs/architecture-backend.md`). Games never touch order, session, broker, stream, guardrail, strategy or analysis code (import-boundary test, below).

```
shared/games/
  core/    ids.ts (31 ids, catalogue, categories), rng.ts (xmur3 + mulberry32, session seed), difficulty.ts (anchors + step
           parameters, level rule), scoring.ts, types.ts (GameDefinition / TrialGameDefinition, `kind` discriminant),
           registry.ts, progress.ts (records and `buildSessionPut`), client.ts (typed state calls, GamesHttpError),
           paths.ts (`validGamesPath`), settings.ts, shell.ts (session state machine), uid.ts, dates.ts, dashboard.ts (rows, streak, trend panels),
           warmup.ts (`buildWarmup`)
  data/    idb.ts + outbox.ts (IndexedDB queue of finished sessions, memory fallback), sync.ts (flush with re-apply on 409),
           sessionLog.ts (sessions kept on this device for Review and trends, never sent)
  ui/      GamesApp.tsx (hub: Brain, Market, Dashboard, Warm-up, Review, Settings), GameShell.tsx, Dashboard.tsx, Warmup.tsx,
           ReviewTab.tsx, SettingsPanel.tsx, Sparkline.tsx, sound.ts, useProgress.ts, useSessionLog.ts, games.css
  games/   index.ts: one registration line per game (empty until Sprint B1; the hub lists the rest as "Coming soon")
```

- **Transports (injected `GamesRequest`).** Desktop: `windowsapp/src/gamesApi.ts` calls the Rust command `desktop_games_request` (bearer held by the host; allowlist `valid_games_path` in `lib.rs` mirrored by `validGamesPath` in `shared/games/core/paths.ts`, parity cases in `gamesApi.test.ts` and the cargo test `games_allowlist_is_exact_and_method_scoped`; only GET and PUT, only `availability`, `window`, `state`; only callable from the window labelled `games`). Website: `frontend/src/services/gamesRequest.ts` uses `fetch` with `X-User-Id`.
- **Desktop window.** The toolbar button (shown only when `GET capabilities` lists `games`) calls `open_games_window` (main window only). The window loads `index.html?window=games`; `windowsapp/src/main.tsx` mounts `GamesWindow` (lazy) instead of the trading `App`. It shares no React tree or state with trading and is destroyed when the main window is. Needs a desktop rebuild.
- **Website and webapp.** `frontend/src/components/games/GamesWorkspace.tsx` is a lazy fixed overlay under the header (z-index 20, the same as Browse, below every modal, popup and notification). Header icon `games` toggles `showGames` in `App.tsx`; opening Games closes Browse (and the reverse), opening Analysis closes Games. **The trading layout is never unmounted or hidden while a session runs**: it is unmounted only when idle and Browse or Games covers it, as for Browse. `App.tsx` passes one prop, `sessionKind` (`none | sim | paper | real`), for a banner; the workspace imports nothing from trading.
- **Progress.** Every finished session goes into the outbox first (`recordSession`), then is sent: the body is rebuilt from the latest server state (`buildSessionPut`), so a 409 re-reads and re-applies; a session the server already holds (`last_mutation_id`) is dropped; a 422 is dropped and reported; offline or server errors leave it queued and `online` triggers a retry. Practice sessions only bump the practice counter. The month record is updated on each Progress session (a deviation from "roll up at month change", see the plan).
- **Session shell.** `shell.ts` is a pure state machine (instructions, Practice or Progress, 3-2-1, play, result; Esc asks to quit; quitting or a void records nothing; a timed block cannot be paused; focus lost for 10 s voids the block). Keys are handled on the shell's own focused element only.
- **Tests.** `shared/games/**/*.test.ts` run in the desktop vitest (`windowsapp/vite.config.ts` `test.include`), including `boundary.test.ts`. `fake-indexeddb` (dev dependency) stands in for IndexedDB, which plain-node vitest does not have; nothing of it ships.
- **Brain games (Track B, `shared/games/brain/`).** Trial-based games, one folder per game under `brain/games/<id>/` (`engine.ts` pure and seeded, `View.tsx`, `index.ts` the `TrialGameDefinition`), registered with one line in `shared/games/games/index.ts`. Playable so far: **Quick Match, Colour Clash, Green Light** (Speed), **Grid Recall, Sequence Echo, N-Back Stream** (Memory), **Flanker Flock, Needle Finder, Track the Dots** (Attention), **Rule Switch, Card Sorter, Flip Map** (Flexibility), **Number Sprint, Equation Drop, Make Target** (Math), **Pattern Matrix, Number Series, Code Breaker** (Reasoning), **Anagram Dash, Letter Grid, Word Ladder** (Word).
- **Market games (Track G, `shared/games/market/` and `shared/games/chart/`, G3b).** Brain games never import these folders (boundary test). `market/engine/` is pure: `series.ts` (paise to points, epoch-aligned 5 s and 15 s aggregation, rebase, efficiency ratio, coverage), `volUnit.ts` (median 5 s range of the previous 5 minutes, floored at 0.004 % of the price), `costModel.ts` (`2 x slippage x level multiplier + rupees per lot / lot size`), `windows.ts` (decision points on a 30 s grid, never in the first 10 or last 5 minutes, no repeat), `roundSource.ts` (draws a window, fetches it, builds the round, up to 3 candidates per round, 3 failures in a row end the session). `market/data/` has `marketData.ts` (the two routes through the injected transport: one request in flight, 250 ms apart, a 404 is `NotCachedError`), `windowCache.ts` (IndexedDB stores `windows` and `windowMeta`, database version 3, least recently used, 300 MB or 150 MB in low memory mode, typed arrays; memory fallback) and `seenWindows.ts` (local no-repeat memory per user and game, 30 days). `chart/` is the games' own canvas chart: `chartModel.ts` (geometry), `drawChart.ts` (paints candles, a line, levels, zones, markers and a replay clock; hollow bodies for up candles so colour is not the only cue), `GameChart.tsx` (repaints once per animation frame when props change). A market game's View receives `market: { data, cost, userId, today }` from `GameShell`; `GamesApp` builds one `createMarketData` per launch. **Tick Reader**, **Entry Sniper**, **Exit Discipline**, **Risk Calculator**, **Hotkey Drill**, **Strike Picker**, **Regime Switch**, **Level Recall**, **Spot the Trap** and **No-Trade Day** are `market/games/<id>/` (pure engines in `market/engine/`: `optionPricing.ts` Black-Scholes, `regime.ts`, `levels.ts` with the swing zig-zag; Level Recall fetches two whole-day 60 second windows per round and draws a click-to-place price ladder; `patterns.ts` holds Spot the Trap's four deterministic pattern detectors, the breakout finder and the hunt F1, and the chart's `timeAt` turns a click into a bar; No-Trade Day keeps its segment simulation, rules and opportunity in its own `engine.ts` and fetches a segment in chunks of at most 900 seconds) (Entry Sniper and Exit Discipline share `market/engine/tradeSim.ts`: a trade on 1 s bars in R, with an open-trade stepper for the replay; a definition may carry its own `levelRules`) (the last two need no market data; `market/ui/frameClock.ts` is the shared cancellable frame clock, `market/engine/hotkeys.ts` the key map); Tick Reader is `market/games/tick_reader/` (`engine.ts` rounds and scoring, `View.tsx`, `index.ts`, `fixture.windows.json` real test windows).
- **Hub screens (B6).** Dashboard, Warm-up, Review and Settings are in `shared/games/ui/`; their rules are pure functions in `core/` (`dashboard.ts`, `warmup.ts`). Everything the player did on this device (seed, stats, trial rows) is in IndexedDB database `tradematangi-games` version 2, store `sessions`; the server still sees only `GET`/`PUT state` (`warmupDone` on the day record counts finished warm-up steps). The Warm-up plan and its step marks are in `localStorage` (`tm-games-warmplan:*`, `tm-games-warmup:*`), so they survive a reload without a server field. Palette is applied by mutating the hex of the shared `PALETTE` objects (`applyPalette`), reduce motion by the games' optional `reducedMotionParams`.
  - `engine/rt.ts`: the timing rules (response under 150 ms is an anticipation: an error with no RT; a frame over 100 ms or a display that missed its time by more than 2 frames discards and replaces the trial). `engine/trialEngine.ts`: `createBlock` (clock-free block runner that applies those rules and logs each trial). `engine/scoringBrain.ts`: chance-corrected skill (choice and detection), speed factor, volume check. `engine/simPlayers.ts`: simulated players on a virtual clock. `engine/generatorHost.ts`: inline and Web Worker hosts for heavy generators (none yet; the 8 ms main-thread budget lives here).
  - `ui/useTrialBlock.ts`: runs a block in the browser. Onset is the rAF timestamp of the frame in which the stimulus is painted (the DOM is updated with `flushSync` inside that frame's callback); RT is `event.timeStamp - onset`; display and window deadlines are checked on the frame clock; losing focus or an open quit dialog discards the trial and pauses the block clock. `ui/Stimulus.tsx` draws shapes with colour **and** pattern; `ui/palette.ts` is the Okabe-Ito set; `ui/ResponsePad.tsx` answers on pointer down with the event's own timestamp.
  - Parameters: `brain/config/difficulty.brain.ts` (typed TypeScript tables, anchors from the Sprint B0 plan, step parameters for categorical levers). Every brain table carries `rtFast` and `rtSlow`.
  - The result screen shows the stats and a per-trial review (`ui/TrialReview.tsx`); the review stays on the device. Market games log one row per round through `market/review.ts` (market, day and time, what you did, the right answer); Review lists them without a replay. Practice lets you pick the level; Progress plays at your level.
  - **B2 additions (Memory and Attention):** `ui/useStagedRounds.ts` runs games made of rounds with stages (Grid Recall, Sequence Echo, Track the Dots): stages are timed on the rAF clock, presentation stages are `critical` (a frame over 100 ms discards and replaces the round), and the answer stage has no time limit. `useTrialBlock` now takes `combine` for trials with `timing.fixedCadence` (N-Back keeps its pace; inputs are gathered during the window and judged together, a press under 150 ms is ignored), and an optional block length with `maxTrials` (Needle Finder). `engine/span.ts` is the span tracker both span games share (success raises the span, three strikes or the trial cap or the ceiling end it). Engines of fixed-count games count **judged** rounds, so a discarded round is replaced for free. Track the Dots computes its trajectories ahead on a fixed 120 Hz step from the seed (`frames`), so a session can be replayed exactly; the view only reads positions by elapsed time.
  - **B3 additions (Flexibility and Math):** `TrialEngine.gapAfter(trial, outcome)` lets a pause depend on the outcome (Number Sprint shows a wrong answer for 1 s); `useTrialBlock` returns `last`, the entry just judged, so a view can show feedback during the pause (Card Sorter, Flip Map's red flash, Number Sprint). `engine/arithmetic.ts` makes the seeded problems for Number Sprint and Equation Drop. Equation Drop is real-time: `createDropSim` (pure, clock-free) is stepped by the view with the frame time (clamped to 100 ms, paused while away) and by tests on a virtual clock. **Make Target uses the Web Worker:** `make_target/solver.ts` (BFS solver and generator), `makeTarget.worker.ts` (module worker entry, built by Vite as its own small chunk) and `host.ts` (`buildPuzzles` builds the whole set before the block starts, in the worker, and falls back to the calling thread when there is no Worker or it fails). Number Sprint and Equation Drop type into a real `<input>`; the key handlers stay on the game's own element.
  - **B4 additions (Reasoning):** the puzzle sets are built before the block by `engine/puzzleHost.ts` (`buildPuzzleSet`: module Web Worker, or the calling thread when there is none or it fails); the three generators share one worker (`games/reasoning/reasoning.worker.ts`, registry in `reasoning/registry.ts`, `reasoning/host.ts` exposes `buildMatrices`, `buildSeries`, `buildCodes`). Each game has a generator that proves its puzzle is unambiguous with a small rule solver (`pattern_matrix/generator.ts` `predictions`, `number_series/generator.ts` `fits`) or checks par with a simple solver (`code_breaker/solver.ts`). Pattern Matrix figures are drawn in SVG by `pattern_matrix/FigureView.tsx`; Code Breaker plays several guesses inside one round and reports the whole game to the block at the end.
  - **B5 additions (Word):** word lists are lazy assets in `brain/assets/words/` (front-coded `valid.fc.txt` and tiered `common.fc.txt`, `exclude.txt`, `NOTICE`), built by `scripts/build-word-lists.py`; `brain/words/loader.ts` is the only importer (dynamic `import('...?raw')`), `wordlist.ts` decodes them and builds the typed-array trie. The three games build their puzzle sets in the words worker (`games/words/`), which loads the lists itself, so the main thread never holds the lists and the main bundle contains none. Judging stays synchronous: each puzzle carries what the View needs (an Anagram Dash puzzle its accepted answers, a Letter Grid every valid word with a path, a Word Ladder the valid and common words of its length). `TrialTiming.tolerateStalls` marks the long puzzle games, so one slow frame does not discard the puzzle. Vite builds workers as ES modules (`worker.format: "es"` in both Vite configs) because the words worker uses `import()`.
- Plan, as-built notes and acceptance: `docs/spec-phase25-implementation-plan.md`, `docs/phase25-manual-acceptance.md`.

## SSE Consumption (`useSSE.ts`)

Wraps `EventSource` with exponential backoff reconnect (1 s → 30 s cap). The `onMessage` callback in `App.tsx` dispatches by `event.type`:

| `event.type` | Handler |
|---|---|
| `tick` | `sim.setLatestTick(tick)` → routes to `latestEquityTick/CETick/PETick` |
| `new_trade` | `sim.addTradeFromSSE(trade)` → deduplicates + stamps `underlying_price` for CE/PE |
| `order_filled` | `sim.handleOrderFilled(order_id, right)` → removes from `openOrders` |
| `order_placed` | `sim.addOpenOrder(order)` → deduplicates, adds to `openOrders` (strategy-placed) |
| `order_cancelled` | `sim.handleOrderCancelled(order_id)` → removes from `openOrders` |
| `strategy_completed` | removes from `runningStrategies` |
| `guardrail_activated` | sets `guardrailPopup` (type, reason) |
| `broker_error` | sets `brokerError` toast |
| `session_ended` | `sim.handleSessionEnded()` → state → `ended` |

---

## API Layer (`services/api.ts`)

A single exported object containing all REST calls. All trading calls include `X-User-Id` from `localStorage`.

| Category | Functions |
|---|---|
| Session | `startSimulation`, `stopSimulation`, `pauseSimulation`, `resumeSimulation`, `updatePaneStrike` |
| Trading | `buy`, `sell`, `getPosition`, `getTrades`, `getTradesByContext` |
| Orders | `placeOrder`, `updateOrder`, `cancelOrder`, `getOpenOrders` |
| Data | `getHistorical`, `getOptionsHistorical`, `getPreSession`, `getSymbols`, `getAvailableDates`, `getPriceAt`, `getExpiry` |
| Strategies | `startStrategy`, `cancelAllStrategies`, `getStrategies` |
| Guardrails | `blockTrading`, `getGuardRailStatus`, `getGuardRailSettings`, `updateGuardRailSettings` |
| Analysis | `getAnalysisSessions`, `getAnalysisSession` |
| Auth | `login`, `register`, `getMe`, `changePassword` |
| Wallet | `getWallet`, `resetWallet` |
| Settings | `getUserSettings`, `updateUserSettings` |
| AI Helper | `aiChat`, `aiGetDecisions`, `aiGetStrategies`, `aiDeleteStrategy`, `aiGetCommands`, `aiCancelCommand` |

---

## Layout System

The `panes` array holds 1–4 `PaneConfig` objects. `layoutPreset` (1–4) controls the DOM arrangement:

| Preset | Layout |
|--------|--------|
| 1 | Single full-height pane |
| 2 | Two stacked equal-height panes |
| 3 | Top pane (full width) + two side-by-side panes below |
| 4 | Four equal-height panes |

**Options session default (preset 3):**
```
panes[0]: equity 3m  (NIFTY underlying)
panes[1]: options CE (current CE strike)
panes[2]: options PE (current PE strike)
```

Panes are never unmounted when hidden via `display:none` (maximise mode) — `liveWindowRef` is preserved, so the live candle state is not lost.

**Tick routing** — each pane receives its tick via `getTickForPane(pane)`:
- `equity` pane → `sim.latestEquityTick`
- `CE` pane → `sim.latestCETick` (null if `pane.strike !== sim.sessionStrikeCE`)
- `PE` pane → `sim.latestPETick` (null if `pane.strike !== sim.sessionStrikePE`)

**Trades routing** — each pane receives only its own trades via `getTradesForPane(pane)`:
- `equity` pane → all `Trade[]` (equity trades + CE/PE trades that have `underlying_price`)
- `options` pane → trades matching `t.right === pane.right && t.strike === pane.strike`

---

## Settings Persistence

| Setting | Storage | Persisted via |
|---------|---------|--------------|
| Funds ratio mode (on/off) | `localStorage` | — |
| Funds ratio L/M/H % | `localStorage` + DynamoDB | `api.updateUserSettings` |
| Historical days | `localStorage` + DynamoDB | `api.updateUserSettings` |
| Analysis price source (`options`/`underlying`) | DynamoDB only | `api.updateUserSettings` |
| Target deviation % | `localStorage` | — |
| Brokerage per order | `localStorage` | — |
| P&L display mode (₹/%) | `localStorage` | — |
| Strategy settings | `localStorage` | — |
| Guardrail settings | `localStorage` + DynamoDB | `api.updateGuardRailSettings` |

On `SettingsModal` open, backend values are fetched and used to overwrite `localStorage` (backend is authoritative for persisted settings).

---

## Configuration

Vite environment variables in `.env` / `frontend/.env.local`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_API_BASE_URL` | `""` (same origin) | Backend base URL (e.g. `http://ec2-ip:8700`) |
| `VITE_AI_HELPER_URL` | `http://localhost:8701` | aihelper base URL |

Both are re-exported from `src/config.ts`. The frontend calls the backend directly (no proxy in production).

---

## Start Commands

```bash
# WSL
bash scripts/start-frontend.sh    # Vite dev server at http://localhost:5173

# Stop
bash scripts/stop-frontend.sh
```

TypeScript check (no emit):
```bash
cd frontend && node node_modules/typescript/bin/tsc --noEmit
```
