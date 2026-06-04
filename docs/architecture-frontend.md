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
    │       └── Drawing tools (H-Line, Trendline, Fibonacci, Channel)
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

User-drawn overlays stored in component state: H-Line, Trendline, Fibonacci retracement, Channel. Each is rendered as additional `LineSeries` or `PriceLine` elements.

---

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
