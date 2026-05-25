# Frontend Technical Constraints

## Development Environment

- **npm must use `--no-bin-links`** — `.bin/` symlinks fail on the Windows filesystem. Scripts already handle this; don't add a plain `npm install` step.

## Lightweight Charts Library

- **No teardown for layout changes**: calling `chart.remove()` discards all series data. Height/width changes must go through `chart.applyOptions(...)`. The chart init `useEffect` must use `[]` deps (mount only); a separate `useEffect([height])` calls `applyOptions` for height changes.
- **"Cannot update oldest data"**: `series.setData(candles)` sets the minimum acceptable timestamp. Any subsequent `series.update(tick)` with `time <= candles[-1].time` throws. For options historical pre-load, filter to `time < startWindowTs`. For equity pre-session, never use `series.update()` to append pre-session candles — combine everything (historical + pre-session) into a single `series.setData()` call so live ticks can only arrive at times strictly after the last pre-session candle.
- **"Object is disposed"**: async `.then()` callbacks fire after chart teardown if a pane unmounts. Guard all three Chart `useEffect` async paths with `let cancelled = false` + `return () => { cancelled = true }` cleanup.
- **Pane wrapper flex shrink**: Lightweight Charts sets an explicit pixel `width` on the canvas. Pane wrapper divs must have `minWidth: 0` or flex siblings cannot shrink below that canvas width after a pane is removed.
- **Chart toolbar paddingRight for remove button**: The pane remove `✕` button in `App.tsx` is `position: absolute, top: 8, right: 8`. Chart.tsx toolbar must have `paddingRight: 36` so the bar-close countdown (which uses `marginLeft: 'auto'`) does not render under the button.
- **Chart price-pick guard**: `chart.subscribeClick` must NOT check `!param.time` before the price-pick branch. `param.time` is null when clicking in empty chart areas (no candle under cursor), but price-pick only needs `param.point.y` for the y-coordinate→price mapping. Move `if (!param.time) return` to after the price-pick handler; drawing modes still need it.

## Trade Markers & Price Lines

- **Trade markers use a transparent Line series, not candlestick `setMarkers`**: `candlestickSeries.setMarkers()` places shapes above/below bars — cannot target an exact price. Instead, a dedicated `Line` series with `lineVisible: false`, `crosshairMarkerVisible: false`, `lastValueVisible: false`, `priceLineVisible: false` holds one data point per executed trade at `{time: alignedSlot, value: tradePrice}`. `setMarkers` on this series with `position: 'inBar'` renders circles at the line's own Y value = the exact execution price. Marker color on options panes is **raw side**: BUY = white `#FFFFFF`, SELL = bright blue `#00AAFF`. On the underlying/analysis chart, color is **directional** via `effectiveSideForChart`: CE BUY → White, CE SELL → Blue, PE BUY → Blue (bearish), PE SELL → White (bullish). Marker text still shows `B`/`S` for instrument-level side. Size is always `1` (smallest Lightweight Charts supports).
- **SELL marker color**: bright blue `#00AAFF` (not `#FFE600` yellow — that was an intermediate state). See `Chart.tsx` and `TradeAnalysis.tsx`.
- **Open order price lines tracked by `Map<orderId, IPriceLine>`**: `createPriceLine` returns an `IPriceLine` that must be explicitly removed via `removePriceLine`. Tracked in `orderPriceLinesRef` (a `Map`). The effect rebuilds all lines on every `openOrders` change — clears the whole map then re-creates. Label = side prefix (`B`/`S`) + type suffix (`L` = LIMIT, `T` = TARGET or STOPLOSS). Price = `limit_price` for LIMIT, `trigger_price` for TARGET/STOPLOSS. Color `#AAAAAA`, `LineStyle.Dashed`.
- **Trade marker / open-order price line pane filtering**: `getTradesForPane` (App.tsx) filters `t.right === pane.right && t.strike === pane.strike` for options panes. `getOrdersForPane` filters `o.right === pane.right && (o.strike == null || o.strike === pane.strike)` — the null guard handles old orders. Chart.tsx `paneTrades` filter mirrors App.tsx with `t.right === right && t.strike === strike`.

## Timestamp Display

- **IST timestamps**: data uses the IST-as-UTC convention — timestamps encode IST wall-clock time as fake-UTC. `toLocaleTimeString` in `TradeHistory.tsx` must use `timeZone: 'UTC'` (not `'Asia/Kolkata'`) to display the correct chart time. Using `'Asia/Kolkata'` adds an extra +5:30, showing times 5.5 hours ahead.
- **3-min candle boundaries**: frontend uses `Math.floor(time / 180) * 180` — must stay in sync with backend `pandas resample("3min")`.

## State Management

- **React setState batching**: multiple `setState` calls in one synchronous burst → only last call wins. For multi-field tick routing, use a single `setState(s => { const update = {}; ...; return {...s, ...update} })` keyed by field, NOT separate `setState` calls per field.
- **Frontend `runningStrategies` is optimistic, not polled**: The list is updated client-side on start (append) and cancel-all (clear). BreakEven/AggressiveStoploss that self-complete server-side remain in the list until the user cancels or starts a new session. Future improvement: reconcile with `GET /api/strategies` on tab open.

## Session Controls & Trading UI

- **`options_only` symbols**: `OPTIONS_ONLY_SYMBOLS` set auto-selects options mode and disables the equity toggle for NIFTY and BSESEN. Frontend must not allow starting an equity session for these symbols.
- **SENSEX strike interval**: 100 points (vs NIFTY 50). Configured in `SessionControls.STRIKE_INTERVALS`. Must also be in the inline map in `addPane` — see below.
- **OTM offset is direction-aware**: CE strike = `ATM + N × interval`; PE strike = `ATM − N × interval`. Applies to both initial session panes (via `SessionControls.fetchOptionsData`) and mid-session `addPane`. UI label is "OTM", not "Offset".
- **Options tick routing uses per-right session strike**: `getTickForPane` in `App.tsx` checks CE panes against `sim.sessionStrikeCE` and PE panes against `sim.sessionStrikePE`. CE and PE may stream at different strikes when OTM offset ≠ 0. Panes with a non-matching strike return `null` (history only).
- **`liveFromTs` for mid-session panes**: When a pane is added mid-session, `PaneConfig.liveFromTs` is set to the latest equity tick's timestamp. `Chart.tsx` uses this as the `cutoffTs` for the options-historical filter (`floor(liveFromTs / intervalSecs) * intervalSecs`) so the pane shows all candles up to the current sim time, not just pre-session candles.
- **Mid-session ATM uses live equity price**: `addPane` in `App.tsx` computes ATM from `sim.currentPrice` (live equity LTP during session) with fallback to `optionsReady.underlyingPrice` (pre-session fetch). Do NOT use session-start ATM for mid-session panes — the underlying may have moved significantly.
- **SENSEX OTM strike interval in `addPane`**: The inline strike interval map in `addPane` must include `BSESEN: 100`. If omitted, `?? 50` fallback applies and CE/PE strikes are computed at the wrong interval (50 instead of 100).
- **Market tab routes as LIMIT with 1% deviation**: The Mkt tab in `OrderPanel.tsx` places a LIMIT order at `currentPrice × 1.01` (BUY) or `currentPrice × 0.99` (SELL). `OrderTypeFull` includes `'MARKET'` as a UI-only state; it is always converted to `'LIMIT'` before calling `onPlaceOrder`. The backend never sees `order_type='MARKET'`.
- **`OrderTypeFull` union + `handlePlace` guard**: Adding `'STRAT'` to the tab union type means `handlePlace` sees it as a possible `orderType`. Add `if (orderType === 'STRAT') return` at the top before any `onPlaceOrder` calls to narrow the type. Without it TypeScript errors on branches that pass `orderType` directly.
- **Price pick ⊕ button on placement form**: The `'__new__'` sentinel in `onRequestPricePick` targets the placement price input (not an open order edit row). `injectedEditPrice.orderId === '__new__'` injects the picked price into the `price` state in `OrderPanel`. The same chart-pick flow works for both new orders and edits.
- **Pause disabled in paper mode**: `isPaperMode` → Pause button is `disabled` in the frontend. Live Kite stream cannot be paused; ticks pile up in `paper_tick_queue` (maxsize=3000) but the frontend simply doesn't display them while paused.
- **Paper trading auto-detection**: frontend sets `session_type = "paper"` when `currentDate === todayIST()` (`new Date().toLocaleDateString('en-CA', {timeZone:'Asia/Kolkata'})`).

## SSE Event Handling

- **Cancel order 404 = already gone**: `api.cancelOrder` treats HTTP 404 as success (returns `null`). This handles the SSE race where an order fills on the backend but the frontend hasn't received the `order_filled` event yet — user clicks ✕, backend returns 404 (order is FILLED not PENDING), UI removes the order cleanly. Any non-404 error still throws.
- **`order_filled` SSE event carries `right`**: The frontend reads `right` directly from the event — never infer it by looking up the order in `openOrders`. Strategy-placed orders (AutoStop) are never in `openOrders` before they fill, so a lookup returns `undefined` and the wrong position type gets refreshed.
- **`order_placed` SSE event for strategy orders**: Frontend handles `order_placed` by calling `addOpenOrder` — strategy-placed orders appear in the open orders panel and `openOrders` is populated before the eventual `order_filled` fires.
- **`order_cancelled` SSE event**: Frontend handles `order_cancelled` by calling `sim.handleOrderCancelled(order_id)` which filters the order from `openOrders` and increments `walletRefreshKey`.
- **Options historical cutoff on refresh**: Chart.tsx uses `latestTickRef.current?.time` (a ref updated every render without triggering re-effects) as the options historical `cutoffTs` when ticks are flowing. This loads all completed candles up to "now" on refresh instead of stopping at `startWindowTs` (09:15 for paper mode), preventing blank CE/PE charts after refresh.

## FundsRatio

- **FundsRatio localStorage keys**: `fundsRatioMode` (boolean string) and `fundsRatios` (JSON `{l, m, h}` with percentage 0–100). Exported helpers `loadFundsRatioMode()` / `loadFundsRatios()` in `SettingsModal.tsx` for App-level init.

## Trade Analysis

- **Analysis chart needs both historical + pre-session for trading day**: `GET /api/data/historical` returns ONLY the 2 prior trading days (not the session date). For the analysis chart to show the actual session's candles (and place trade markers correctly), fetch `getHistorical` (prior context) + `getPreSession(symbol, date, '15:30:00')` (full trading day) in parallel, merge by timestamp, deduplicate, sort, then call `series.setData()` once.
- **Analysis chart aspect ratio**: height = `max(300, floor(containerWidth × 0.45))`, computed from ResizeObserver entries. Apply both width and height changes via `chart.applyOptions({width, height})` in the same ResizeObserver callback.
- **`pnl_pct` is stored as percentage**: `analysis_service.compute_session_summary` returns `pnl_pct` as e.g. `9.70` meaning 9.70%, not `0.097`. Display as `{value.toFixed(2)}%` — do NOT multiply by 100.
- **Trade Analysis options markers use underlying price**: `AnalysisChart` in `TradeAnalysis.tsx` shows the equity (underlying) chart. Options trade prices (~₹150) are off-scale for a NIFTY chart (~24000). The marker Y for options trades = `close` of the underlying's 3-min candle at `floor(trade.timestamp/180)*180`. Candles are held in `useState<CandlestickData[]>` (not a ref) so the markers `useEffect([trades, candles])` re-runs once the async candle load completes. Marker text: `CE B`, `CE S`, `PE B`, `PE S`.

## User Isolation & Auth

- **Frontend `X-User-Id` header**: `api.ts` helper `_authHeaders()` reads `localStorage.auth_user` and returns `{'X-User-Id': userId}`. Must be spread into `headers` on every authenticated fetch (simulation, trading, orders, wallet, analysis). Login/register requests do not need it.
- **`Order.strike` null backward-compat**: Old DDB records have no `strike` attribute; frontend receives `undefined`. Use `o.strike == null` (loose equality, catches both `undefined` and `null`) in filter guards so old records pass through without a migration.

## Admin & Settings UI

- **Settings modal tab structure**: admin users see `[General] [Admin]` tabs (state `activeTab`). Non-admin users see no tabs (same single-column layout). Admin tab content: BROKER TOKENS, LIVE STREAMING SOURCE toggle, REAL TRADING ACCESS whitelist, BROKER CONNECTION. General tab: all existing trading/wallet/strategy settings + BROKER section for real trading users. `api.getStreamSource()` / `api.setStreamSource()` → `GET/PUT /api/admin/stream-source`.
