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
- `model.ts`: pure logic: `orderSetups` (date ascending, Buy before Sell), `dayMarksByDate`, `removalImpact` (what un-marking a side throws away), `toDiveSetup` / `withSetups` (local updates after a save), tag states (`tagState`, `toggleTag`, `restNotValid`), gaps (`gaps`, `isComplete`, `nextGapIndex`, `unmarkedDaysForTag`), `validateTagName`, position and date labels, and the percentage wording (`formatPct`, `tagLine` "Double top: 70% (n=14)", `thinNote`, `successLine`, `findStats`, `setupSideOfTrade` / `defaultSideForTrade`). An archived tag never counts as missing.
- Tests: `windowsapp/src/deepDive.test.ts` (the desktop vitest is the only runner that reaches `shared/`).
- **Screens** (`shared/deepdive/ui/`, one set for the Windows app and the website). `DeepDive.tsx` takes a **host** (`ui/host.tsx`, `DeepDiveHost`): the Deep Dive API, the category and strategy names, `expiry` and `resolveStrikes`, the account settings and the `Chart` component; every screen reads it with `useDeepDiveHost()`. The Windows host is `windowsapp/src/tools/deepdive/desktopHost.ts` (the patterns transport and the KLine Analysis chart); the website host is `frontend/src/components/deepdive/WebsiteDeepDive.tsx`. Shared helpers used by both: `shared/deepdive/marking.ts` (mark tools, `toggleAnnotation`) and `strikes.ts` (`resolveStrikes` over a three-method `StrikeLookup`; the desktop's `patternLibraryModel` re-exports them). Styles: `ui/deepdive.css`. **Symbols:** the symbol dropdown (start form and marking step) lists the Pattern Library's symbols, `shared/deepdive/symbols.ts` (`NIFTY`, `BSESEN` = SENSEX, `RELIND`, `TATMOT`, `TATPOW`; a test keeps it equal to the website page's `SUPPORTED_SYMBOLS`); every one gets an option chart (`STRIKE_INTERVALS` in `strikes.ts` carries the gaps, 50 / 100 / 5), Max Price strikes are for the two indices and the stocks use OTM. **Layout of the in-depth day:** `useFillWindow` sizes the day area from where it starts to the bottom of the window (refitting on resize and when the content above changes), the underlying chart sits above the option chart and the two share that height, half each, with each at least 260px so a KLine chart's time axis is never clipped (a short window scrolls instead); under 1000px wide they stack at a fixed height. The calendar keeps the cells of neighbouring months in their grid slots (`visibility: hidden`, not `display: none`), otherwise the whole month slides left and every date sits under the wrong weekday. On the desktop it is a third **Deep dive** tab in the Pattern Library next to Annotate and Saved charts: `DeepDive.tsx` (list, then one dive), `DiveHome.tsx` (the dives and the start form: category and strategy through `PatternNameSelect`, symbol), `DateMarking.tsx` with `DiveCalendar.tsx` (step 1: each day has its own **B** and **S** buttons, so a click can never swap a side; the day number shows that day's KLine chart; removing a side that has tag marks, chart marks, an outcome or notes asks first; a shared dive is read-only). Tests (desktop vitest, with a stub host in `tools/deepdive/testHost.tsx`): `tools/deepdive/*.test.tsx`.
- **In-depth step** (step 2, `InDepth.tsx`): walks the marked days (date ascending, a day's Buy before its Sell). Prev / Next always work; a `DayStrip` chip per day is green when every active tag is marked and amber otherwise, a banner says how many tags the day has open, **Next unmarked day** jumps, and a "Needs marking" list (`GapsPanel`) names every open day (a tag added later is open on all earlier days). `DayWorkspace.tsx` (mounted with a key per day): the underlying KLine chart and the option chart of the setup's side (Buy on the CE, Sell on the PE, indices only) with the mark tools of `patternLibraryModel` (strategy fixed to the dive's), Outcome (Success / Failed), `TagPanel.tsx` (each tag Valid / Not valid / nothing selected, a second tap clears, **Mark the rest not valid**, add, archive and restore) and Notes (saved on blur). Strikes come once from the account strike setting (`useDayStrikes`, which waits for `PatternSettings.loaded`; OTM from the 09:15 price or Max Price at 09:30) and are saved with the day, so the option chart never moves; "Pick strikes again" re-resolves. `DayIntervalBridge` restores the day's saved candle interval and saves a change, ignoring the charts until they have taken the saved interval.
- **Saving:** every change shows at once and is saved in the background through `SaveQueue` (one at a time, in the order made; the header shows Saving… / Saved / the error with **Retry**). Pure helpers are in `ui/inDepthModel.ts`. A shared dive (`can_edit` false) shows everything and edits nothing.
- Browser check: `scripts/desktop-deepdive-check.mjs` runs the built app against an in-memory fake server.
- **Results step** (step 3, `Results.tsx`): All / Buy / Sell filter, success rate, per tag a bar with `valid% (n=…)` and a thin-sample note, a row per day (opens it in the in-depth step), and Save to Patterns per day or for all marked days. Percentages are computed on screen by `computeStats` (the server's arithmetic, including ties to even). **Buy and Sell are the direction a position profits from**: `setupSideOfTrade({ right, action })` gives long equity = Buy, short = Sell, CE bought = Buy, PE bought = Sell, and selling flips both; `SIDE_MEANING` is the wording on the screens.
- **Website and webapp** (`frontend/src/components/deepdive/`): the Pattern Library page (`pages/PatternLibrary.tsx`) has a third mode, **🔍 Deep dive**, next to Create and View (the webapp shows the same page). `WebsiteDeepDive.tsx` is the page's host, wrapped in `withWebsiteAnalysis` so it gets the Analysis environment and follows the **Analysis & Patterns chart renderer** setting: in **KLine** the chart is `environment.charts.AnalysisChart` (the shared Analysis chart, as in Analysis); in **Lightweight** it is `DeepDiveLightChart.tsx` (minute candles from `/api/pattern/ohlc/...`, EMA 9 and 21, the day's pattern marks through `buildMarkers`, a click that reports candle and price in pick mode, a candle-interval select bound to the shared Analysis interval). Names come from `api.pattern*`, strikes from `api.getExpiry/getPriceAt/findStrikeByPrice` on minute data, settings from `SettingsModal`'s loaders. Base styles for the shared screens live in `deepDiveWeb.css`, scoped to `.dd-web` with `:where()` so the Deep Dive's own colours win. Test: `frontend/tests/phase22/deep-dive.spec.ts` (Playwright, both renderers, mocked backend).
- **Compare (Phase 27 S4)** (`shared/deepdive/ui/Compare.tsx`): the Pattern Library's Compare tab, two read-only panes behind the same `DeepDiveHost` as the Deep dive (desktop tab, website `compare` mode). A pane reads one deep dive (`listDives`, `getDive`), shows one of its days with that day's marks on the Underlying, CE or PE (`useViewStrikes`: the day's saved strikes, else the Mark days preview pick) and has its own Maximize (`ChartFrame`). Each pane sits in an `AnalysisIntervalScope` (`shared/analysis/environment.tsx`), a provider that gives it a candle interval of its own, so two panes never fight over the one shared Analysis interval; nothing is saved.
- **Group (Phase 27 S3)** (`shared/deepdive/ui/GroupView.tsx`, `computeGroupStats`): two tags together over the days where both are marked, with the conditional rates and four cells. Results gets a Group button beside All / Buy / Sell; `StatsPanel` (label forms and the live popups) gets a compact Group button when `stats/all` sends `days`.
- **Percentages in Label Trades** (`shared/deepdive/ui/StatsPanel.tsx`): under the **Expected Pattern** row of the shared `RoundTripLabelForm`, once an expected category and strategy that has a deep dive are chosen, a compact panel shows the top tags (`valid% (n=…)`, a thin-sample note under 5 days), the success rate and an **All / Buy / Sell** switch. It opens on the side the position profits from (`defaultSideForTrade({ right, action })`, with the round trip's option right and the side of its first entry order: long equity, CE bought and PE sold = Buy; short equity, PE bought and CE sold = Sell; unknown = All). `TradeLabeling` loads the data once through the optional `AnalysisApi.getDeepDiveStats` (website: `api.getDeepDiveStats` = `GET /api/deep-dive/stats/all`; desktop and phone: the analysis transport route `deep-dive/stats/all`, allowlisted in `desktop_analysis.py`, `analysisApi.ts` and `lib.rs`), never blocks the labels, and shows nothing on an older server or without data. Own data wins over a dive shared with the user (the panel says "shared with you"). Used by every host that mounts Label Trades: website, webapp, desktop and phone. **Live label popups** show the same panel, **entry popups only** (the Expected Pattern; the exit popup's Actual Pattern has none), once an expected category and strategy are chosen. Website: `PendingLabelPanel.tsx` (replay, paper and real share it; `App.tsx` adds the opening side to each open leg: a long position was bought, a short one sold) and `StepwiseLabelPopup.tsx` (one panel per round trip, under its Expected Pattern; the opening side comes from `api.getRoundTrips`, fetched only when the user has deep dives). Desktop: `DesktopLabelPopup` in `App.tsx`, fed by `deep_dive` on the `trading/trade-labels/metadata` response (the round trip's `entry_trades[0].side` gives the direction). **Safe by construction:** read-only and additive; the stats are loaded on their own (website: `api.getDeepDiveStats`, never awaited by the label values or the save; desktop: bounded to 2 seconds on the server, an error or timeout gives an empty list); the label payloads are unchanged; a failure, a slow call or an older server shows no panel. No trading route, order path or allowlist gained anything (the desktop trading allowlist is untouched).
- The label-form panel in live sessions comes in a later sprint; see `docs/spec-phase26-implementation-plan.md`.

## Phase 26: review changes (2026-11-17)

- **Analysis day card Maximize** (Phase 27 S2, `shared/analysis/TradeAnalysis.tsx`): `GroupCard` holds one `maximized` state for its four tabs (Trades, Label Trades, Walkthrough, What If). Maximized, the card's detail div (tab bar, videos, the tab) is a fixed container over the window (`maximize.css`; `inset: 42px 0 0` on the Windows app) and provides `CardMaximizeContext` (`labeling/useRoundTripView.ts`); the three tabs read it with `useCardMaximized()` and pass it to `RoundTripSplitLayout`, which stacks the charts and fills the card (it has no fixed wrapper of its own). Esc or Restore returns to the day list, which stays mounted. A tab rendered without a card (the phone overlays) is never maximized and has no button.
- **Maximize per chart** (`shared/deepdive/ui/ChartFrame.tsx`): every chart of the Deep Dive's in-depth step and of "From your trades" sits in a frame with a thin bar holding its name and a **Maximize / Restore** button. Maximizing one hides the other (it stays mounted, so nothing reloads) and gives the chosen one the whole chart area; `useMaximizedChart` remembers the choice per screen while the app is open, so stepping to the next day or trade keeps the chosen chart big, and a choice that the next day or trade does not have counts as none.
- **From your trades**: the two charts are side by side (the Deep Dive's in-depth step is stacked by default and can be switched to side by side: see "in-depth side by side" below).
- **Deep Dive header in the library's own row** (`ui/HeaderPortal.tsx`, `DeepDiveHost.headerSlot`): the back button ("← All"), the deep dive's name (truncated when long), the three steps and, in the in-depth step, the day walk (‹, "1 / 21 · 5 Oct · BUY", ›, "Next unmarked day", the save state) are a portal into the Pattern Library's header row, so they take no rows of their own and the charts get that height. The website page and the desktop Pattern Library each provide the slot while the Deep dive tab is open; the header wraps when the window is too narrow (the whole row fits on one line from about 1500px). Without a slot the controls render in their own row as before. The day label leaves out the year when it is the current year (`positionLabel(..., omitYear)`).

## Phase 26: Strategy Practice on the Windows app (S16)

- **Practice tab** in the desktop Pattern Library (`tools/PatternLibrary.tsx`, shown when the Tools view provides `onStartPractice`): the shared `Practice` screens over `useDesktopPracticeHost` (`tools/practice/desktopPractice.tsx`): the patterns client's `practice` API, the KLine Analysis chart, and the desktop's own speed list (0.25× to 10×, a multiplier). The new paths (`deep-dive/practice/strategies|runs|evaluate`, `POST deep-dive/practice/pick`) are in the Rust `valid_patterns_path` and the TS `ALLOWED` mirror, with parity tests (**a desktop rebuild is needed**).
- **Start** resolves the day's contracts in the Tools view (`practiceStartConfig`: the saved CE and PE strikes, else the ATM at the start time from the patterns client's price and expiry lookups) and hands a `PracticeLaunch` (`tools/practice/launch.ts`) up through `ToolsView` to the root `App`, which gives it to the **visible workspace screen** (`launchPractice` / `settlePractice`; the Start in the Tools view awaits the result and shows the screen's own sentence on a refusal).
- **The workspace screen** (`ScreenController`): step 1 takes the launch (a screen that is running or starting something refuses with "A session is running on this screen. Stop it before you start a practice run."), replaces the screen's charts with the practice charts (`practiceTiles`: the underlying and the saved CE and PE, on the day's interval), switches to **Replay** and sets the date, start time and speed in the ordinary run controls; step 2 starts the ordinary `startRun` once that state is in place. For a practice start `startRun` sends the `practice` marker with `trading/start`, asks **no candidate question and shows no prompt**, and never sets `override`; it now also returns `{committed, failure}` so the Tools view can report the outcome. On success the view switches to the Workspace.
- **Toolbar:** "Practice: strategy" while it runs (from `session.practice`, never the recorded side or marks); after Stop, **Review practice** takes you to the Tools view, Pattern Library > Practice, straight into that run's review (`practiceReviewId`).
- Browser check: `scripts/desktop-practice-check.mjs` (the whole path on the built app with a faked native layer and server).

## Phase 26: Lightweight chart tools in the Deep Dive (2026-11-17)

The website's Lightweight renderer for the Deep Dive and the Practice review (`components/deepdive/DeepDiveLightChart.tsx`) now has the same two menus as the Analysis Lightweight charts (`useLightweightTools`, `LightweightChartTools`):
- **Indicators ▾**: one indicator, **EMA 9/21**, on by default; the choice is remembered per account (`analysis-lw-ema`) like on the Analysis charts. VWAP and Volume are not offered (the Deep Dive feeds no volume).
- **Draw ▾**: the usual tools (Horizontal Line, Trend Line, Fib Retracement, Rectangle, **Text**, Buy and Sell Marker, Risk:Reward), a **Clear** for the last drawing. Drawings are kept per account, instrument **and day**, so each Deep Dive day starts clean and keeps what was drawn on it.
- **Marks and drawings do not mix:** while a drawing tool is active a click on the chart draws and is never also an Entry / Exit mark (the chart's own click handler is registered before the drawing tools', so it still sees the tool as active on the click that finishes the drawing). A tool draws once and switches itself off; the next click is a mark again.
- The KLine mode already had its own Draw and Indicators in the toolbar.

## Phase 26: Mark days fills the window (2026-11-17)

In **Mark days** the row of the calendar, the list of marked days and the day's chart is sized to the bottom of the window (`useFillWindow`, as in the in-depth step), and the chart box inside it has its own explicit height (`FilledChart`): with many days marked (21 in the owner's report) the chart ran past the window and its time axis fell out of view on the KLine chart. The calendar and the list of days beside the chart scroll on their own (`.dd-mark-left`), the page does not scroll, and the chart always ends inside the window. A narrow window (under 1000px) is left to the stylesheet. Check: `frontend/tests/phase22/deep-dive-markdays-axis.spec.ts` (21 days, three window sizes, both renderers).

## Phase 26: Strategy Practice screens (S15)

- **Shared module** `shared/practice/` (host-injected like `shared/deepdive`): `types.ts`, `client.ts` (`createPracticeClient(request)` over the `deep-dive/practice/...` paths), `model.ts` (grade filters, wording of the review, your trades as gold marks), `startConfig.ts` (the instrument settings of a practice replay), `ui/` (`Practice` container with **Start practice** and **History** tabs, `PracticeStart`, `PracticeHistory`, `PracticeReview`, `host.tsx`, `practice.css`). Tests: `windowsapp/src/practice.test.ts`.
- **Start:** strategies of your own Deep Dive with at least one Entry-marked day (day counts), an optional symbol, grades to include (Ideal / Average / Poor / Success not graded / Failed / No outcome; all ticked sends no filter), the host's own speed control, **Start practice** (disabled while a session runs, with the reason). It calls `practice/pick`, then `host.startPractice(plan, speed)`. The plan has no side and no marks.
- **Starting the replay on the website** (`App.tsx` `startPractice`): `practiceStartConfig` gives the saved CE and PE strikes (a strike never saved is the ATM strike at the start time, as a normal replay would pick; the expiry is the server's), then the ordinary `handleStart` with `session_type: 'sim'` and `practice: {category, strategy, start_offset_min}`; **no `override`**. The Pattern Library page then closes onto the normal replay trading screen. `useSimulation` keeps `practice` from the start response, and does **not** load the day's earlier trades as history for a practice run.
- **On the trading screen:** the header shows **Practice: strategy**; after Stop it also shows **Review practice**, which opens the Pattern Library on the Practice tab straight into that run's review.
- **Review** (`practice/evaluate`; refused with the server's 409 sentence while the session runs, with Try again): the recorded side, grade, entry and exit times; what the recorded marks would have made (best pair, per instrument, or why not); your trades with minutes early or late, points, P&L, "You kept n% of the +x pts on offer" and the amount on offer at your size; the underlying and the option chart side by side (Maximize on each) with your orders as gold ⚑ marks and your recorded marks in their normal colours; a Buy / Sell setup switch when the day has both; trades that matched no recorded setup listed apart.
- **No-setup days (S15b):** when the strategy has days you reviewed without marking (`negative_days`), Start shows **Include no-setup days** (off by default, with the number of days it adds; about 1 run in 4 is one). It sends `include_negatives`. The review of such a run (`negative: true`) has no recorded setup: it says "No setup", then "you stayed out, the right call" or "you traded (n pts), no trade was wanted" with the trades you took; the start offset line is left out. History says the same in one line.
- **History:** your runs, newest first; a run in progress cannot be reviewed; an ended one shows its one-line result ("6 min late · kept 50%").
- Website and webapp share one implementation (`frontend/src/components/deepdive/WebsitePractice.tsx`, a `practice` mode of `pages/PatternLibrary.tsx`); the Windows app follows in S16. Browser checks: `frontend/tests/phase22/practice.spec.ts` on both chart renderers.

## Phase 26: strength and entry / exit times (2026-11-17)

- **Strength:** the day's outcome buttons are now **Ideal / Average / Poor / Failed** (one choice per day; the same button again clears it). Ideal, Average and Poor are all successes; Failed has no grade. A success saved before grades shows one extra pressed button, "Success (not graded)", that you replace by picking a grade or clear by clicking it. Results shows the grade in each day's Outcome cell and a summary line "Ideal 3 · Average 2 · Poor 1 · not graded 1"; the label forms' "Your deep dive" panel adds the same line to its success line. `computeStats` mirrors the server (`strength` counts over successful days; a stray grade on a failed day never counts).
- **Entry / Exit times:** the in-depth side panel shows "Entry 09:45 · Exit 10:30 (from the marks)" under the outcome, updating as marks are placed, and Results has **Entry** and **Exit** columns. They come from the day's Entry and Exit marks (`setupTimings`, the same rule as the server's `entry_exit_times`: earliest entry, latest exit, the underlying first), so nothing is stored twice and removing a mark removes the time.

## Phase 26: rename a tag (2026-11-17)

- **✎ on every active tag** (`TagPanel`, `onRename` → `DeepDiveApi.updateTag`, the existing `POST /tags/{id}/update`): the name becomes an input with Save / Cancel (Enter saves, Escape cancels). The same checks as adding run first (not empty, 140 characters, no other active tag with that name, case-insensitive; changing only the case is allowed), and the server repeats them.
- **Older days follow with no migration:** day marks are stored by tag id (`tag_values`), and a name is read from the one tag record, so every day, the Results bars, the Needs marking list and (after the 20-second stats cache is dropped by the write) the percentages in label forms show the new name. No marks change, so no day becomes open or complete by a rename. Archived tags are restored before they can be renamed; a name an archived tag held can be reused.
- The KLine chart's pick-mode Escape listener now ignores Escape pressed in a text field, so cancelling a rename never cancels a chart pick.

## Phase 26 hardening (S11)

- `shared/deepdive/ui/errors.ts` (`friendlyError`): every Deep Dive and traded-patterns screen words transport errors plainly (a route an older backend lacks, a connection that did not get through) and passes the server's own sentences through. The start screen loads its names and the list of dives independently so one failure never empties the other.
- `DayStrip` is a tab list with a single tab stop and arrow, Home and End keys.
- `shared/liveFeedNotice.ts` (`feedNotice`): the live-feed status line ("Feed kite · connected") shows only when the feed needs attention (connecting, reconnecting, unavailable, or a fallback provider). Used by `frontend/src/App.tsx` (paper and replay screens; the row no longer takes chart height while the feed is healthy) and the desktop toolbar.
- Tests: `deepDiveErrors.test.ts`, `liveFeedNotice.test.ts`, website `hardening.spec.ts` and the keyboard steps of `deep-dive.spec.ts`.

## Pattern Library: From your trades (Phase 26, S10; desktop, website and webapp)

The strategies the user labels on trades (as the one expected or the one it turned out to be) are pattern material. `shared/traded/` holds it, like the Deep Dive: `types.ts`, `client.ts` (`createTradedClient`, one client for both transports over `pattern/traded/...`), `model.ts` (pure: `tradedMarks`, wording helpers) and `ui/TradedPatterns.tsx` with a `TradedHost` (`ui/host.tsx`: the API, the `Chart`, `historicalDays`, `onEdit`).

- **Screen:** a fourth Pattern Library tab (desktop: **From your trades**; website and webapp: **🧾 From your trades**). Left, every labelled strategy with its counts (trades, expected, actual, last day) and a filter. Choose one: the trades behind it (day, instrument with strike, position, time range, P&L, whether the strategy was the expected or the actual one, session type). Choose a trade: its charts, **side by side** (the underlying, and the option contract it traded, CE or PE with its own strike), each the full height of the viewer, centred on the entry (`focusTime`), and the viewer filling the window like the Deep Dive's day (under 1000px wide they stack).
- **The "traded" look:** the trade's entry and exit are drawn as **gold ⚑ BUY / ⚑ SELL** marks (the order really placed: a short trade shows SELL at entry and BUY at exit), on the 3-minute bar they happened in. They are `PatternAnnotation`s with `source: 'traded'` and an `action`, which `buildMarkers` renders gold, named by the order and never dimmed, so they cannot be mistaken for the ideal marks of a marked pattern. They are display only and never sent anywhere.
- **Saving:** **Save as pattern chart** asks the server to copy the trade's entry and exit into the day's pattern chart as ordinary entry / exit marks of that strategy (merged with an existing chart for the day, or a new one; a chart on other strikes is refused). **Save and edit** does that and opens the chart in Annotate (desktop: the existing `openSaved`; website: the page's `handleGalleryLoad`, then Create mode).
- **Hosts:** desktop `PatternLibrary.tsx` (`tradedHost`, the KLine Analysis chart); website `components/deepdive/WebsiteTradedPatterns.tsx` (follows the Analysis & Patterns renderer: KLine = the shared Analysis chart, Lightweight = `DeepDiveLightChart`, which now also honours `focusTime`). `DiveChartProps` gained the optional `focusTime`.
- Tests: `windowsapp/src/tradedModel.test.ts`, `tradedClient.test.ts`; browser: `frontend/tests/phase22/traded-patterns.spec.ts` (both renderers) and the last section of `scripts/desktop-deepdive-check.mjs`.

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

## Phase 26: Strategy Practice in Analysis (S17)

- **Badge, and a group of its own.** A practice run has `session_type: 'sim'`, so `groupSessions` now puts the practice marker in the group key: a practice run never merges into an ordinary replay of the same day (and two runs of one strategy on one day stay together). A practice run with **no trade** is listed too (staying out of a no-setup day is a result). The card shows **Practice: strategy** (website, `TradeAnalysis`), the desktop navigator's day button shows it (`SessionDayButton`), the phone row has a **Practice** badge.
- **Filter:** website modal "Practice: Include / Exclude / Only", the desktop session header the same, the phone Filters sheet "Practice runs" (applied on the client; the server has no parameter). The **header totals** (Days, Win Rate, Total Trades, Total P&L; the desktop navigator's "groups · P&L") **leave practice runs out**, as the Performance dashboard does, unless only practice runs are shown.
- **Practice review** from a card: `AnalysisEnvironment.practice` (`{api, Chart, historicalDays}`; absent = no button) supplies the read-only API and a chart; the shared `AnalysisPracticeReview` (`shared/practice/ui`) shows the same review as the Pattern Library. Website: button **🎯 Practice review** on the card, a full-window dialog (the Lightweight chart in Lightweight mode, KLine otherwise); desktop: the same on the Sessions card (`DesktopAnalysis` builds `practice` over the analysis transport, `createAnalysisPracticeApi`); phone: a **Practice review** item in the session's View menu and a full-screen overlay (`phone-practice`, charts stacked). The review is refused with the server's sentence while the run is not ended.
- **History** (Pattern Library > Practice > History) gains a summary line from `historySummary`: "6 reviewed · entered early 1, late 1, on time 1 · kept 60% on average · no-setup days: stayed out 1 of 2".
- Checks: `frontend/tests/phase22/analysis-practice.spec.ts` (website, both renderers), `windowsapp/src/practice.test.ts`, `mobile` `filters.test.ts` and the landscape UI suite.

## Phase 26: Strategy Practice hardening (S18)

The Start screen remembers the days a start could not use: when the day was picked but the replay could not start for a reason about the day (its data could not be loaded), the day goes into a skipped list, the screen says "That day could not be started: ... Press Start practice again for another day.", shows "n days skipped", and sends the list as `exclude` with the next pick. A refusal about the session (one is already running: `isDayProblem` is false) skips nothing. Choosing another strategy forgets the list. The Start button has `aria-busy` while starting and `aria-describedby` for its hint.

## Phase 26: Strategy Practice, Stepwise on the website (S20)

- **Mode switch on Start:** when the host offers two modes (`PracticeHost.modes`; the website lists Replay and Stepwise, the Windows app only Replay until S21) the Start screen shows a **Mode** radio group, default Replay, remembered in `localStorage` (`practice-mode`, optional). Stepwise hides the speed control and says to press Next Bar; `host.startPractice(plan, {mode, speed})`.
- **Website start** (`App.tsx` `startPractice`): a Stepwise run is `session_type: 'stepwise'` (speed 1) with the user's own Stepwise bar (`stratIntervalSecs`) and the start **snapped down to a bar boundary** (`snapStartTime`, the twin of the server's `snap_start`, never before 09:15), so the first bar is a full one; the server snaps the same way and records the start it used. The ordinary Next Bar control and the Stepwise label popup work as in normal Stepwise. The header badge reads "Practice: strategy · Stepwise".
- **History** shows each run's mode ("09:33 · Replay" / "09:40 · Stepwise") from `PracticeRun.session_type`; Analysis already separated the two by session type and labels a Stepwise practice run "Stepwise".

## Phase 26: Strategy Practice, Stepwise on the Windows app (S21)

- The desktop Practice tab offers **Replay and Stepwise** (`useDesktopPracticeHost`: `modes: ['replay', 'stepwise']`, the same Mode switch as the website; the speed list shows for Replay only). `PracticeLaunch.mode` carries the choice up to the workspace.
- `ScreenController`: the launch switches the screen to **Stepwise** or **Replay** (`switchMode`), the second effect waits for that mode, `tradingStartBody` sends the `practice` marker for either historical mode, and **inside `startRun`** (where the preference is known) a Stepwise practice start is snapped to a bar boundary of `strategy_interval_secs` (`snapStartTime`, never before 09:15) for the trading session and the chart replay alike; the run controls show the start used. No candidate prompt, no override. The ordinary Next bar button, the coordinated `replay/{run}/next-bar` and the chart sync are reused. The toolbar badge reads "Practice: strategy · Stepwise" and Review practice appears after Stop, as for Replay.
- As in normal desktop Stepwise, the chart tiles keep their own interval (the Deep Dive day's, here) while the simulator's bar is the preference; the chart follows the simulator clock.
- Check: `PRACTICE_MODE=stepwise node scripts/desktop-practice-check.mjs` (5 minute bar, 09:34 start, snapped to 09:30) beside the Replay run of the same script.

## Phase 26: the Pattern Library page fits its frame (2026-11-18)

The owner's second report that the Mark days chart's time axis was not visible (a screenshot at what looks like 80% browser zoom) had two causes that the earlier harness could not show, because it had no header above the page:
- **The page was taller than its frame.** `PatternLibrary`'s root was `height: 100vh`, but `App.tsx` puts a 38px header above it in a `100vh` column, so the page ended 38px below the window and every tab's bottom (a chart's time axis, the end of a list) was clipped by the frame. The root is now `flex: 1; min-height: 0; height: 100%` of the frame's body (a flex column), and has `data-testid="pattern-library"`.
- **`useFillWindow` measured once.** It sized a box to the window bottom from where the box started when it mounted; a header filled afterwards (a portal, fonts) moved the box down without resizing anything the helper observed, leaving a stale height. It now checks the box's position every frame while mounted (one `getBoundingClientRect`, a layout only when something changed) and refits when the position or the window height changed. This is used by Mark days, the in-depth step, the Practice review and From your trades.
- **Test:** the Deep Dive harness (`tests/phase22/deep-dive.tsx`) now always renders the page inside the app's real frame (a 38px header, a clipped body), and `deep-dive-markdays-axis.spec.ts` checks Mark days at 1920x1080, 2400x1350 (80% zoom), 1366x700 and 1200x600 and the in-depth step at the first two: the chart, its canvases, the row and the page all end inside the window.

## KLine Fib Retracement draws segments (2026-11-18)

The built-in klinecharts `fibonacciLine` runs every level across the whole pane. The tool "Fib Retracement" now maps (through `overlayName`, `shared/charts/klineDrawingModel.ts`) to our own overlay `tmFibSegment` (`shared/charts/klineFibSegment.ts`):
- each level (100, 78.6, 61.8, 50, 38.2, 23.6, 0 %) is a line **segment from the earlier click to the later click, plus an overrun** of a quarter of the span (at least 28 px) past the later click; the price and percent label sits just left of the segment, so it never hides the line; a dashed line joins the two clicked points.
- saved drawings store the tool name, not the overlay name, so **every existing Fib drawing is drawn as segments too**; nothing is migrated. Every KLine host (website and webapp, Windows app Trading and Swing charts, Analysis, Browse, Patterns) goes through `overlayName`, so the change is the same everywhere.
- registration is by `registerFibSegmentOverlay()`, called where a KLine chart is created (`KLineChart.tsx` `ensureExtensions`, `AnalysisChart.tsx`); the overlay name constant lives in `klineFibSegment-name.ts` so the pure drawing model stays free of a browser import. The Lightweight chart's own Fib tool is a separate implementation and is unchanged.
- test: `tests/phase22/kline-fib-segment.spec.ts` draws a Fib on the KLine chart and checks the overlay; `analysisDrawing.test.ts` pins the name mapping.

## Phase 26: in-depth side by side, and CE / PE on Mark days (2026-11-19)

Two screens of the shared Deep Dive (`shared/deepdive/ui`, so website, webapp and Windows app alike):
- **In-depth layout.** A **Charts: Stacked / Side by side** switch at the right end of the **Mark:** row (`DayWorkspace`; the same row as the marker buttons, to save height; it is the only thing in that row when the day cannot be edited; hook `useChartLayout`, remembered in `localStorage` key `tm.deepdive.chartLayout`, with try/catch). `.dd-charts[data-layout="side"]` is a row; a narrow window (<= 1000 px) is stacked either way. The default is stacked as before. Only shown when the symbol has an option chart.
- **Mark days: Underlying / CE / PE.** A tab row above the day's chart (`DateMarking`, `OptionPreview`, hook `usePreviewStrikes`). The default is the underlying. CE and PE show the day's option chart at the strike of the **Max Price pick at 09:30 with a premium cap of 75 for both sides** (`previewStrikeSettings` and `PREVIEW_STRIKE_CAP` in `inDepthModel.ts`; the owner chose 75 over 50 and may change it later: one constant), whatever the account's strike setting is. It is only there to give an idea of the option chart: nothing is saved, a marked day's own strikes are not touched, the strikes are cached per symbol and day while the app is open. Max Price is for the indices (NIFTY, SENSEX); the stocks get an ATM strike (`patternStrikeRule`). The chosen view stays when another day is selected. The host's `resolveStrikes` takes the settings it is given on both hosts, so no host changed.
- **Tests:** `tests/phase22/deep-dive-views.spec.ts` (both renderers: tabs, the strike lookup with `max_price=75` at `09:30:00`, the layout switch and that it is remembered), `inDepth.test.tsx` (the preview settings).
- **KLine pattern marks look like the Lightweight markers (same PR).** The `analysisAnnotation` overlay of the shared Analysis chart (`shared/analysis/kline/AnalysisChart.tsx`; every KLine pattern screen on every host: Deep Dive in-depth, From your trades, Patterns, Practice review) used to be one text figure, `↑`/`↓` in the string, drawn at the clicked price on klinecharts' default blue `#1677FF` text box. Now `annotationFigures` (`shared/analysis/kline/annotationFigures.ts`, pure) draws an **arrow polygon just outside the marked candle** (an Entry below its low with the text under the arrow, an Exit above its high with the text over it) and the text with `backgroundColor: 'transparent'` and no border, in the mark's colour. The overlay's point is the candle's low or high (the click price when the candle is not loaded). A dimmed mark (a different strategy) has no text and keeps its arrow. When marks exist the candle pane's bottom gap is 20% (10% default) so an Entry's text under the day's low is not cut off at the plot's edge. The Windows app uses the same component, so it changes with the website. The execution (trade) markers of Analysis are a separate overlay and are unchanged.
- **Tests:** `annotationFigures.test.ts` (geometry, no box, empty text), `tests/phase22/deep-dive-kline-marks.spec.ts` (places an Entry and an Exit on the KLine in-depth chart and checks that no pixel of the chart canvases is the default blue box; screenshot reviewed). The `analysis-tools` KLine "left rail draws, saves ... restores after reload" test fails intermittently in the full website suite on unmodified `dev` too (drawing count stays 1 after the delete); it is not related to this work.
- **Marking starts with no marker selected (Phase 26).** In Deep Dive in-depth (`DayWorkspace`), the website Pattern Library create mode (`frontend/src/pages/PatternLibrary.tsx`) and the Windows Pattern Library (`windowsapp/src/tools/PatternLibrary.tsx`) the selected marker used to default to Entry (UL or CE), so any click on a chart added a mark. The selection is now `null` to begin with: a chart click marks nothing (no error either), a marker button selects it, and clicking the selected button again puts it down (`aria-pressed` false, tooltip "Click again to stop marking"). The toolbar says "no marker selected" while none is. In the website Pattern Library the tool check runs before the category and strategy checks, so a stray click does not flash those errors. Tests: `deep-dive.spec.ts` (both renderers) and `desktop-deepdive-check.mjs`.

### Text drawing on KLine and Lightweight charts (Phase 26)
- **What it is.** A **Text** drawing tool (the `T` button in the KLine tools, `T Text` in the Lightweight Draw menu): one click on the chart, a small box beside the point (`shared/charts/ChartTextPrompt.tsx`, drawn into `document.body`) asks for the text (up to 80 characters), Enter or OK keeps it, Escape / Cancel / an empty text drops it, and the text is drawn at that time and price, bold, with no box behind it.
- **KLine (saved to the database).** The tool is in `shared/charts/catalogue.ts`, so every KLine host has it: the trading charts (`KLineChart.tsx`, website and Windows app) and the Analysis / Patterns / Deep Dive charts (`useKLineDrawings.ts`). A Text drawing is the ordinary persisted drawing `{tool: "Text", points: [one point], text, style: {color}, visible, locked}` through `/api/desktop/v1/drawings` (the backend stores the drawing dict as it is; no backend change). It is saved when its text is confirmed (nothing is saved before), is shared across the screens of the same instrument like every drawing, can be moved (drag), locked, hidden and deleted with the usual controls, and a **double click** on it changes the text (a PUT). Its overlay is `tmText` (`klineText.ts`, registered where a chart is created; `klineText-name.ts` and `overlayName` are pure so vitest never imports klinecharts). The colour is the drawing line colour of the chart settings.
- **Lightweight (saved to the database too, see "Lightweight drawings are saved and shared with KLine" below).** `TextPrimitive` (`frontend/src/indicators/textPrimitive.ts`) is a series primitive like the rectangle; it is part of `LightweightDrawingController` (Analysis, Patterns, Deep Dive charts), so it is saved with the other Lightweight drawings, survives a reload and maximize, and is removed with **Clear** (the last drawing). Its text is changed, and it can be deleted on its own, like any Lightweight drawing (next section). The Lightweight trading chart (`Chart.tsx`) joined later (Phase 27 S1, below).
- **Tests:** `analysis-tools.spec.ts` (KLine: Cancel saves nothing, Enter saves with the text, restore after reload, double click changes it with a PUT; Lightweight: prompt, saved record, Clear), `kline-text-drawing.spec.ts` (the trading KLine chart), `analysisDrawing.test.ts`, `test_desktop_persistence.py` (the text field survives create, update and reload).

### Lightweight drawings: pick, delete, change a text (Phase 26)
- **Why it is custom.** Lightweight reports a chart click only as pixel coordinates (`param.point`) and has no selection, drag or double click event for drawings (it also swallows the second click of a double click). `LightweightDrawingController` therefore turns each drawing into pixel geometry (`timeToCoordinate`, `priceToCoordinate`) and matches the click to the nearest one; the geometry is pure in `lightweightHit.ts` (unit tests `lightweightHit.test.mjs`, run with `node --test`).
- **Behaviour (Analysis, Patterns and Deep Dive Lightweight charts).** With no drawing tool on, a click within 7 px of a drawing **picks** it: lines and the Fib / Risk:Reward levels get thicker, a rectangle and a text get an orange outline, and a small bar beside the click names it with **Delete** (and **Edit text** for a Text). **Delete** or the Delete / Backspace key removes just that drawing, Escape or a click on empty chart drops the pick, and the saved drawings are updated (a soft delete in the database). A **double click on a Text** (the browser's `dblclick` on the chart element) opens its text box; an empty text leaves it as it was. The pick look is always undone before anything is saved, so a thick line is never stored. Drawings cannot be moved. The nearest drawing wins, the one drawn last wins a tie, a click inside a rectangle is the lowest priority (a line across it wins).
- **Deep Dive marks.** The mark click handler asks `hitsDrawing` first, so with a marker selected a click on a drawing picks the drawing and is not also an Entry / Exit mark.
- **Tests:** `analysis-tools.spec.ts` (draws a horizontal line, trend line, rectangle and text; picks each, deletes them on their own with the button and the Delete key, Escape, empty click, Edit text, double click and Cancel), `deep-dive-chart-tools.spec.ts` (a click on a drawing is not also a mark). Playwright note: the chart needs the pointer to move over it before a press (move, short wait, then down / up), as a person does.

### KLine Risk : Reward and Buy / Sell marker drawings (Phase 26)
- **Why.** The Lightweight pattern charts had three tools KLine lacked (Risk:Reward, Buy marker, Sell marker). To share saved drawings between the two chart types (plan: `docs/spec-phase26-implementation-plan.md`, "Shared drawings"), KLine now has them too. They are in the shared tool list (`shared/charts/catalogue.ts`: **RR**, **▲** Buy marker, **▼** Sell marker), so every KLine host has them: the trading charts (website, webapp, Windows app) and the Analysis / Patterns / Deep Dive charts.
- **Risk : Reward** (`klineRiskReward.ts`, pure levels in `klineRiskRewardModel.ts`, overlay `tmRiskReward`, `totalStep: 3`). **Two clicks: the stop first, then the entry** (the built-in Long Position needs entry, target and stop in that order). The levels are the entry plus 1, 1.5 and 2 times the stop-to-entry distance (upward when the stop is below the entry, a buy; downward otherwise): lines from the earlier to the later click with `label price` at the right end, over a faint red risk zone and a green reward zone, in the Lightweight colours. The saved drawing is `{tool: "Risk Reward", points: [stop, entry]}`.
- **Buy / Sell markers** (`klineMarker.ts`, names and defaults in `klineMarker-name.ts`, overlays `tmBuyMarker` / `tmSellMarker`, `totalStep: 2`). One click: the same arrow and plain text as the pattern marks (`annotationFigures`, made selectable for a drawing): Buy a blue up arrow below the point, Sell an orange down arrow above it, text `Buy UL` / `Sell UL` stored in the drawing's `text`. The colour is the marker's own, not the drawing line colour.
- **Wiring.** `overlayName()` maps the three tool names; `drawingExtendData()` and `newDrawingFields()` (`klineDrawingModel.ts`, pure) give the overlays their text; both overlay registrations are called wherever a chart is created (`KLineChart.tsx` `ensureExtensions`, `AnalysisChart.tsx`); `KLineChart.tsx` and `useKLineDrawings.ts` (which duplicate the placement logic) both use the helpers. No backend change (the drawing is stored as given).
- **Tests:** `analysisDrawing.test.ts` (levels for a buy and a sell, colours, overlay names, marker text and colour), `tests/phase22/kline-risk-reward.spec.ts` (trading chart), `analysis-tools.spec.ts` (Analysis chart: POST bodies with the stop first, restore after reload, delete; the rail shows 18 tools).

### Lightweight drawings are saved and shared with KLine (Phase 26)
- **What changed.** The Lightweight Analysis, Patterns and Deep Dive charts no longer keep their drawings in `localStorage`: each drawing is the same database record a KLine drawing is (`/api/desktop/v1/drawings`, the `PersistedDrawing` of `shared/charts/klineDrawingModel.ts`), under the same instrument identity (`analysisDrawingInstrument`, no date, no scope), so **the two chart types show, change and delete the same drawings** and a delete in one stays deleted in the other (delete is a soft delete). The Windows app (KLine only) shows them after a rebuild. No backend change.
- **Common tools** (`lightweightPersist.ts`, pure, `node --test`): Horizontal, Trend, Fib Retracement, rectangle, Text, Buy Marker, Sell Marker, Risk Reward (stop first, then entry; KLine has the last three since PR #902). Only points, text and a Text's colour are shared: each chart draws them in its own style (the Lightweight Fib has 5 levels, the KLine one 7). A KLine-only tool (ray, arrow, brush, Long / Short position, ...), a record with the wrong number of points and a drawing hidden in KLine are not drawn in Lightweight and are never touched by it; a drawing locked in KLine is drawn but cannot be picked.
- **Controller** (`lightweightDrawings.ts`): each drawing carries its `spec` (kind, clicks in order, text) and its saved record id and revision. Make = POST, delete (pick and Delete, or **Clear** for the last) = DELETE with the revision, change of a text = PUT; a delete or change waits for a save still in flight. After each save it announces the change (`shared/charts/drawingEvents.ts`) and it watches for changes from the other chart on the page: it then replaces its drawings with what the database has (not while a save is in flight or a drawing is being placed; it tries again shortly). A failed save or delete shows a red notice in the toolbar and the chart is refreshed from the database. Records are shown in the order they were last saved, so **Clear** removes the one saved most recently. A second browser tab, or a switch of the chart setting, picks changes up when the chart next opens, as KLine does.
- **Identity on the website.** `useLightweightStore` (`frontend/src/components/analysis/useLightweightStore.ts`) takes the drawings service and symbol lookup from the Analysis environment (`lightweightEnvironment` in `frontend/src/services/analysisEnvironment.tsx` now has `drawingRequest` and `resolveSymbolInstrument`, as the KLine one) and builds the instrument like `AnalysisChart.tsx` (option, or `{kind, exchange, symbol}` from the catalogue). Without a service or a resolved symbol the drawings stay on the chart only. **Deep Dive** no longer keeps drawings per day: like KLine they belong to the instrument, and the time of a drawing places it (a drawing from a day inside the chart's history window shows on the neighbouring day too).
- **Copying the old drawings.** When an instrument's chart opens, its browser-only drawings (`analysis-lw-drawings:<account>:<symbol>:<right>:<strike>:<expiry>` and the Deep Dive per-day `...:deepdive:<date>` keys) are copied to the database once (`legacyToSpecs`; a horizontal line, which had no time, takes the last candle's), skipping any drawing the database already has (copied from another browser), then flagged `analysis-lw-migrated:<key>` on that browser. The local copy is left in place.
- **Tests:** `lightweightPersist.test.mjs` (every tool round trip, the saved shape, skipped records, the old localStorage shapes), `analysis-tools.spec.ts` (Lightweight tests read the saved records; a cross-renderer test draws every common tool on the Lightweight chart, sees all eight on KLine, deletes the trend line in KLine and the rectangle in Lightweight and checks both stay deleted in the other; the one-time copy of old drawings, not repeated on reload).

- **The trading charts too (Phase 27, S1; real-trading chart, `dev` only until the owner's real-session try).** Browse, Day, Swing and live charts in Lightweight mode use `Chart.tsx`, which until now kept its drawings in `localStorage` only (Browse and Swing: `browse-drawings:` / `swing-drawings:` plus the candle interval; Day: an in-memory handoff), so a line drawn in KLine never showed there. Found on 2026-11-20 in Browse. Now `TradingChartHost` builds the drawings store (`useChartDrawingStore.ts`: `desktopDrawingRequest`, the instrument, the old local key) and passes `persistDrawings` and `drawingStore` to `Chart.tsx`. With `persistDrawings`, `Chart.tsx` attaches the same `LightweightDrawingController` the Analysis charts use (`useLightweightDrawing` in `LightweightChartTools.tsx`, now split out of `useLightweightTools`) and shows its Draw menu (`LightweightDrawControls`, with the chart's own button style) instead of its inline Draw dropdown; its own inline drawing code, its `localStorage` save and its loader are skipped, and the candle update path is untouched. Without the prop the chart behaves as before. Tools are the common ones, with Text and picking / deleting a single drawing as on the Analysis charts.
  - **One identity for both chart types.** `chartDrawingInstrument` (`frontend/src/components/chartDrawingInstrument.ts`, pure) is the object `WebsiteKLineChart` used to build inline (option; swing option with NFO / BFO; future; underlying with the catalogue kind); both charts call it, so the backend's exact-JSON match finds the same records. `drawingIdentity(..., shareDayDrawings = true)` then shares Day and Swing and reads the older feed-venue records; the store's `legacyScope` (the Swing chart's `drawingScope`) is passed as the legacy scope, as `WebsiteKLineChart` does, so Swing records saved under the old private scope are still read.
  - **Copying the old local drawings.** `legacyBase` is the old key without its interval suffix (`:5` in Browse, `:3m`, `:1h`, `:1D` in Swing; `isLegacyKeyOf` in `lightweightPersist.ts`), so every interval's drawings are copied up once and then dedupe by shape; the local copy stays. The Day chart has no local key, so nothing to copy.
  - **Tests:** `chartDrawingInstrument.test.mjs` (`node --test`: identity table, the swing key shared with Day and the legacy keys it still reads, interval suffixes), `windowsapp/src/lightweightDrawingIdentity.test.ts` (same key as the Analysis chart for a contract and an underlying), `charts.spec.ts` (a KLine line shows in Lightweight, a Lightweight trend line shows in KLine, Clear in Lightweight deletes for both; the Swing Lightweight chart reads the shared and the old scoped record and writes unscoped; old local Swing drawings are copied once). The seven per-tool "survives switching and Clear" tests now run through the database.

- **Phone, read-only.** `drawingsReadOnly` in the Analysis environment (`shared/analysis/environment.tsx`) makes the shared KLine chart show saved drawings locked with no tools, no selection and no shortcuts; the phone sets it with a read-only drawings service (`mobile/src/env/drawingReader.ts`). See `docs/architecture-phone.md`.

### Day Notes tab (Phase 27, S5)
`shared/analysis/notes/` (`DayNotes.tsx`, `OpenTodosBanner.tsx`, `model.ts`, `source.ts`, `types.ts`, `notes.css`). The Analysis day card (`GroupCard`) has a fifth **Notes** tab, offered when the environment has a `dayNotes` source (`DayNotesSource`, built by `createDayNotesSource(request)` over any transport: the website's authenticated fetch in `analysisEnvironment.tsx`, the desktop's analysis command in `DesktopAnalysis.tsx`) and hidden on a day shared with the user (the notes are the user's own). The tab shows the day's TODOs on top (carried ones marked "from 14 Oct", status buttons Open / Working on it / Done / Improved, a delete, the history), the note with four parts that **autosaves** 800 ms after typing stops and once more when the tab is left, and a collapsed **Review** (totals now, a week table of TODOs written and closed by the day they were closed, every TODO with its history; `weeklyReview` in `model.ts`). Label Trades shows `OpenTodosBanner` above the form: the TODOs open or working on that day, read only. The phone has no day card (its Label trades, Walkthrough and What If are overlays) and so no Notes tab yet. Tests: `windowsapp/src/dayNotes.test.ts`, website Playwright `analysis-notes.spec.ts`.

### Day score screens (Phase 27, S7)
`shared/analysis/dayScore/` (`types.ts`, `source.ts`, `model.ts`, `useDayScore.ts`, `DayScoreBadge.tsx`, `DayScoreBreakdown.tsx`, `dayScore.css`). `environment.dayScore` (`DayScoreSource`: `day(date)` and `range(start, end, compute)`) is built by `createDayScoreSource` over the same request as the notes; the website's request adds the `analysis/` prefix for `day-score*` (`/api/analysis/day-score`, `/day-scores`), the desktop's analysis command adds its own. `GroupCard` shows the chip (`TradeAnalysis` reads the stored scores of the searched range once, with no compute, for closed cards; an open card reads the full score with `useDayScore`, again on a tab change or data revision) and passes the full score to `DayNotes`, which starts with the breakdown. `DayPathBehavior` has a **Day score (0 to 100)** metric (`day-scores?compute=true` in up to four rounds). The Habits screens know the `system` habit kind (`HabitKind`, `LedgerQuestion`, `kindLabel` in `habits/types.ts`; a System filter in `HabitsView`). Tests: `windowsapp/src/dayScore.test.ts`, website Playwright `analysis-notes.spec.ts` and `day-score-trend.spec.ts`.
