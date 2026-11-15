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

- **Position P&L levels use a candlestick series primitive**: `PositionPnlPrimitive` draws five-bar segments and their labels directly in Lightweight Charts 4.2. Calculate coordinates inside the canvas draw callback so historical loads, live autoscale, vertical scale dragging, scrolling, and resizing all use the current transform. An absent fill timestamp falls back to the nearest available candle; do not hide all levels when `timeToCoordinate` returns null. Attach once at chart initialization, update level inputs through `setLevels`, and detach at teardown. The primitive uses the pane's media size, excluding axes. Levels do not expand autoscale; off-screen target prices require zooming out. Empty/flat positions or invalid session capital produce no levels.

- **Trade markers use a transparent Line series, not candlestick `setMarkers`**: `candlestickSeries.setMarkers()` places shapes above/below bars — cannot target an exact price. Instead, a dedicated `Line` series with `lineVisible: false`, `crosshairMarkerVisible: false`, `lastValueVisible: false`, `priceLineVisible: false` holds one data point per executed trade at `{time: alignedSlot, value: tradePrice}`. `setMarkers` on this series with `position: 'inBar'` renders circles at the line's own Y value = the exact execution price. Marker color on options panes is **raw side**: BUY = white `#FFFFFF`, SELL = bright blue `#00AAFF`. On the underlying/analysis chart, color is **directional** via `effectiveSideForChart`: CE BUY → White, CE SELL → Blue, PE BUY → Blue (bearish), PE SELL → White (bullish). Marker text still shows `B`/`S` for instrument-level side. Size is always `1` (smallest Lightweight Charts supports).
- **Trading marker visibility**: show the current open position cycles by default; remove a contract's cycle when it becomes flat. Partial exits remain until full closure. The per-pane All markers button toggles closed-fill history. Reconcile transparent marker series by trade ID; price-only renders must not recreate them. See [trading performance](trading-performance.md) for diagnostics and the browser soak harness.
- **SELL marker color**: bright blue `#00AAFF` (not `#FFE600` yellow — that was an intermediate state). See `Chart.tsx` and `TradeAnalysis.tsx`.
- **Open order price lines tracked by `Map<orderId, IPriceLine>`**: `createPriceLine` returns an `IPriceLine` that must be explicitly removed via `removePriceLine`. Tracked in `orderPriceLinesRef` (a `Map`). Reconcile lines by ID: remove absent orders, create new orders, and apply changed prices/labels to existing lines. Price-only renders must retain the same objects. Label = side prefix (`B`/`S`) + type suffix (`L` = LIMIT, `T` = TARGET or STOPLOSS). Price = `limit_price` for LIMIT, `trigger_price` for TARGET/STOPLOSS. Color `#AAAAAA`, `LineStyle.Dashed`.
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
- **Settings → Display tab (website, 2026-11-01)**: the chart-appearance settings were moved out of General into a dedicated `display` tab (state `activeTab` in `frontend/src/components/SettingsModal.tsx`, nav order `general, display, trading, ...`): the **Trading chart** renderer select (Lightweight / KLine), `WebsiteChartAppearanceSettings`, and **TRADING CHART INDICATORS** (ROC ratio mode). P&L Display Mode, Historical Days, Wallet etc. stay in General. Values and persistence are unchanged; only their location moved.

- **Historical request mode**: paper/real chart, indicator and strike-selection requests pass `history_mode=live`; replay, stepwise, analysis and ordinary Browse use the default `replay`. Include mode in frontend chart/indicator cache keys so minute chart history cannot leak into replay after a mode switch.

## Website header notifications

- Reserve a stable, single-line error area in the existing header between Add
  Session and Day P&L. Do not add/remove banner rows or float automatic cards over
  trading controls. Use `services/notifications.ts` for the error-only FIFO and
  NotificationCenter for manual full history. Each active error gets eight seconds;
  queued errors do not expire before display. All severities remain journaled.
  Critical pattern alerts enter the error queue; other pattern alerts are history
  only. Guardrail interventions retain their existing blocking semantics;
  notifications do not imply a broker acknowledgement.
- Website API failures are journaled at the API boundary and rethrown unchanged.
  Local error state uses `useFlashError`; duplicate reporting is suppressed.
  Capture account/session context when an asynchronous request starts, and suppress
  reporting into a different account after completion. Expected optional 404s and
  aborts must not flash.
- History contains actual browser receipt timestamps, unlike IST-as-UTC candle
  timestamps: format notification milliseconds in Asia/Kolkata. Persist at most
  100 records per account/backend, expire after seven days, and never replay old
  flashes on reload. No backend audit or cross-device sync is implied.

- Per-pane "Re-select strike" (CE/PE charts): the start-time rule (`strikeRule.ts`,
  carried on `OptionsReadyConfig.strikeRule`) is re-applied server-side by
  `POST /api/simulation/{id}/reselect-strike` at the session clock (replay/stepwise) or
  wall clock (paper/real). The server refuses (409) while that side has an open
  position, order or strategy, because the old contract stops receiving ticks. If the live-feed switch itself fails, the server restores the previous strike and price and answers 502 (managed feed: real and website-paper sessions), so the session never stays on a contract that has no ticks; the pane keeps its old strike. The
  App's workspace-reset effect is skipped for the resulting strike change
  (`skipWorkspaceResetKeyRef`, decided by `reselectOutcome` in `strikeRule.ts`) so the user's pane layout is not rebuilt.
- Adding a CE/PE pane at another strike (and the paper-resume workspace restore) calls
  `PUT /api/simulation/{id}/update-pane-strike`, which the server refuses (409) when the swap would strand
  an open position, order or strategy. `api.updatePaneStrike` surfaces the server's reason; add-pane then
  removes the pane it just added and restore keeps loading the workspace, both via
  `paneStrikeErrorMessage` in `strikeRule.ts` and the header error.
- Rectangle drawing (`indicators/rectanglePrimitive.ts`) is an `ISeriesPrimitive` that
  resolves pixel coordinates inside `draw()`; a corner time absent from the loaded
  candles (e.g. past the last bar) is extrapolated from bar spacing, never dropped.
  Its fill follows `indicators/rectangleStyle.ts`, which reads `drawingFillColor` /
  `drawingFillOpacity` from `/api/desktop/v1/chart-settings` (shared with the desktop
  app) and re-publishes on the `website-chart-appearance` window event. Settings ->
  Display must save with read-modify-write so other chart-settings keys survive.

## Analysis & Patterns charts

- Analysis charts get their renderer from `AnalysisEnvironment.charts`. On the website
  the map is chosen by the separate `website_analysis_chart_renderer` setting; never
  reuse the trading `website_chart_renderer` for it.
- KLine and Lightweight tool sets are intentionally different. KLine drawings persist
  to the backend under the same instrument identity as the trading charts
  (`analysisDrawingInstrument` + `drawingIdentity(..., shareDayDrawings=true)`); keep
  those two in lockstep with `WebsiteKLineChart.tsx` and desktop `App.tsx`, or
  Analysis drawings stop appearing on the trading chart. Lightweight Analysis drawings
  are local only.
- The Lightweight Analysis Rectangle uses the same `attachRectangle` primitive and `{type:'rect', p1, p2}` persisted shape as `Chart.tsx`; keep both in lockstep. Legacy `channel` entries are skipped on restore (an unhandled entry would abort the whole restore).
- Lightweight Analysis charts are recreated when maximized (`[isMaximized]`); anything
  drawn must be restorable from storage at chart creation.
- Website KLine Analysis styles live in `klineAnalysisSite.css`, scoped by
  `.kline-analysis-site`; do not import the desktop `desktopAnalysis.css` there.
- Label Trades (`shared/analysis/TradeLabeling.tsx` + `shared/analysis/labeling/`) is shared by website, webapp and desktop. Its layout is chosen by `AnalysisEnvironment.labelView` (user setting `analysis_label_view`; default one at a time); each host supplies `labelView`/`onLabelViewChange`. One-at-a-time mode auto-saves only edited trades through `LabelSaver` (never overlapping saves, flush before navigating); all-together mode keeps the explicit Save. Styling uses `tl-` classes with CSS variables, imported by the component itself, so it works without `desktopAnalysis.css`.
- Label Trades chart layout: one chart + switcher when not maximized, both charts when maximized (`LabelChartPanes` `maximized` prop on the website, `AnalysisPanels` `layout` prop and `.is-single` CSS on desktop). Keep the switcher DOM (`nav[aria-label="Chart pane"]`) and pane labels — the browser checks rely on them.
- Label Trades chart panes (`labeling/LabelChartPanes.tsx`): charts receive `focusTime`, `fill` and — for strike charts — `labelContractMarkers` (option-contract markers are unlabeled by default; do not change that for other screens). The phone bottom bar is `position: fixed`; do not return it to `sticky` (it does not engage inside the Analysis modal). The Analysis group card uses `overflow: clip` for the same reason.
- Behavior questions/marks (Phase 23): the manager and checklists are shared (`shared/analysis/behavior/`) and take an injected `BehaviorApi`; there are three transports (website `/api/behavior`, desktop Analysis proxy via `createAnalysisApi`, desktop trading routes via `createDesktopBehaviorApi`) — keep their method shapes identical. Marks are saved by `MarkSaver`, never by the Save Labels button, and must be flushed together with the label saver before navigating. An archived question is shown on a trade only when that trade already has its mark. The desktop proxy `behavior/*` routes are in all three allowlists (`desktop_analysis.py`, `analysisApi.ts`, `lib.rs`).
- In-session labels are keyed by `(session_id, round_trip_index)` and the backend numbers a round trip when it **opens** (`build_cycles`: `index = len(cycles)`). The website must assign the same number at open time and keep it until the leg closes (`hooks/roundTripIndexer.ts`; never renumber at close). The desktop takes its slots from the server. Behavior answers in the live popups are sent only after the label saved and only when changed (`diffAnswers`); the popup must stay open on failure.
- Habits (Stats → Habits): every statistic is computed in `shared/analysis/habits/habitStats.ts` from the backend ledger rows — never from the dashboard's paged `cycles`. A % total over trades with no P&L % is unavailable (null → "—"), not 0, and must sort last. Which value a column shows for the selected unit/statistic lives only in `metric()`. Verdicts use means and % of capital (₹ fallback); do not change thresholds without updating the in-app help text and spec §10.
- Habits charts (`MultiLineChart`, `DivergingBars`) draw in real pixels (viewBox = rendered width via `useWidth`), never a fixed 1000-unit viewBox scaled down — that makes text unreadable on a phone. Per-day series: counts/sums are 0 and averages/shares are gaps on days without the habit; never plot a gap as 0. Period-comparison tone/flag rules live only in `habitSeries.ts` (`toneFor`, `compareHabit`) and are documented in the UI footnote and spec §10.9 — change all three together.
- Do not name a `.ts` module and a `.tsx` component the same apart from case (e.g. `habitDeepDive.ts` vs `HabitDeepDive.tsx`): on the case-insensitive Windows/WSL `/mnt/d` filesystem the import resolves to the wrong file. Habits uses `deepDiveStats.ts` for the logic of `HabitDeepDive.tsx`.

## Volume on KLine charts (Phase 24)

- Candles may carry `volume` (optional). `mergeKLineTick` (website) and `aggregateLiveCandles` (desktop) add per-second tick volume only into a bar the stream itself started, and remember the last counted second, so a bar loaded from history is never doubled and a re-delivered tick is never counted twice.
- `VOL` and `VWAP` are created by the shared `KLineChart` only when the loaded candles contain volume; indices show neither. `sameCandle`/`sameCandles` compare volume, so a volume-only change redraws.
- KLine `VWAP` is created on the candle pane (`paneId: "candle_pane"`, stacked, like MA/EMA) via `overlayIndicators` in `shared/charts/catalogue.ts`; without a `paneId` the library gives it a sub-pane of its own. `indicatorUnavailable()` (same file) is the one place that decides an indicator draws nothing: volume indicators with no volume, and VWAP on `1D` bars (it restarts every day, so it would be each bar's typical price). Both KLine creation sites (`KLineChart.tsx`, `useKLineIndicators.ts`) use it. `VOL` keeps its own pane.
- Lightweight volume and VWAP (website and webapp only; the desktop and phone have KLine only): `indicators/vwap.ts` is the pure maths (`sum(HLC/3 x volume) / sum(volume)`, reset on `floor(time/86400)` = the IST date under the IST-as-UTC timestamps; typical price while the day's volume is 0, like the KLine library), and `indicators/volumeStudies.ts` owns the histogram and the VWAP line of one chart. `setData` takes the full history, `update` the forming bar: the forming bar is re-applied to the state *before* it, so ticks inside one bar never accumulate twice. Keep both for any new Lightweight chart; do not copy the maths again. The menu items appear only once the data has volume (`candlesHaveVolume`; indices report none). They default to off, unlike EMA.
- `Chart.tsx` keeps the forming bar's volume in `liveWindowRef` with the same rule as `mergeKLineTick` (tick volume only into a bar the stream started, `tickedThrough` de-duplicates). `bar_paused` carries no volume, so the stepwise correction keeps what the bar gathered. Saved state: `LightweightChartState.showVwap` / `showVolume` and the `:indicators` localStorage object. Analysis Lightweight charts (`AnalysisCharts.tsx`, `ComparisonCharts.tsx`) use `useLightweightTools`: call `tools.setVolumeData(toVolumeCandles(rows))` next to every `series.setData`, and `tools.setVolumeData([])` where the series is cleared; preferences `analysis-lw-vwap` / `analysis-lw-volume`. The Snapshot charts (`SnapshotCharts.tsx`) have no indicator menu and show no VWAP.
- Live ticks carry no volume yet (B2 / Track C of `docs/spec-phase24.md`), so on a live session a forming bar keeps its history volume and VWAP stays flat inside it.

## Phone app (`mobile/`, Phase 24)

- **Landscape only, about 740 to 960 by 340 to 440 CSS px.** Height is the scarce resource: no stacked headers, no modal-on-modal, no wide tables. Touch targets are at least 44 px (40 px in dense lists). Every screen is checked at 915x412, 851x393, 740x360 and 960x432 (`mobile/tests/`).
- **Safe areas.** Capacitor 8 injects the real inset values as `--safe-area-inset-top|right|bottom|left` CSS variables (edge-to-edge is enforced at target SDK 36); `env(safe-area-inset-*)` is only the fallback. `mobile/src/theme.css` exposes both as `--sai-*`. Use `100dvh`, never `100vh`.
- **Bearer only.** The phone sends `Authorization: Bearer` and never the website's `X-User-Id`. All calls go through `mobile/src/api/transport.ts` (timeout, one shared token refresh, one retry after a 401, retries for reads only). Never call `fetch` directly from a screen.
- **Server base URL is absolute.** The WebView origin is `https://<hostname>`, so a relative `/api` never works. Release builds accept `https` only.
- **Older servers.** A route a server does not have (`404` with detail `Not Found`) or a `403` is shown as "not available on this server" (`NotAvailable`), never as a crash. Use `isMissingEndpoint` / `isNotAvailable` from `mobile/src/api/errors.ts`.
- **Date-bounded requests.** `GET /api/analysis/sessions` has no pagination; the phone always sends `start_date` and `end_date`.
- **Secrets.** The refresh token lives in secure storage (Android Keystore); the access token only in memory; neither is ever logged (`diagnostics.redact`). In a plain browser nothing secret is persisted.
- **Shared code.** Phone layout components compose shared logic; edits to shared UI components must be additive props whose default is the current behavior (the website, webapp and desktop all use them).

## Patterns strike selection (Phase 24)

- `frontend/src/patternStrikes.ts` is the one place that decides OTM or Max Price for the Pattern Library: Max Price only for NIFTY and BSESEN when Settings has the Max Price option strike mode with a positive cap on both sides (stocks and every other case stay OTM). In Max Price mode the page shows the same dropdowns as the trading screen (`MaxPriceSelect`: `premiumPresetsFor(symbol)` plus a saved value as "(saved)"), one for CE and one for PE, starting from the Settings values and read again when the symbol changes; a change is saved to Settings (`max_price_threshold_ce` / `_pe`, like the trading screen) so both screens show the same value. Settings only decides OTM or Max Price. The ATM price comes from `getPriceAt(..., '09:15', 'replay', 'minute')` and the cap is checked at 09:30 through `findStrikeByPrice(..., 'replay', 'minute')`; a failed pick is shown, never replaced by ATM. A saved chart keeps CE in `strike` and PE in `strike_pe`; every reader (gallery reload, `shared/analysis/PatternVsTradeComparison.tsx`) uses `strike_pe ?? strike`.

## Games (Phase 25)

- **Isolation.** `shared/games/**` imports only React and files inside `shared/games/`; it must not import trading, order, session, stream, guardrail, strategy, broker, analysis or chart modules. `shared/games/boundary.test.ts` fails the build on a violation. The host glue (`windowsapp/src/GamesWindow.tsx`, `gamesApi.ts`, `frontend/src/services/gamesRequest.ts`, `components/games/GamesWorkspace.tsx`) is scanned too. Brain games may not import `market/**` or `chart/**`.
- **No direct network.** Games code does not call `fetch`, WebSocket, EventSource or `sendBeacon`; the host injects the `GamesRequest` transport.
- **Keys.** No `window` or `document` key listeners anywhere in Games (tested). A game handles keys on its own focused root element and stops propagation, so Escape and the rest never reach the trading handlers (`App.tsx` and `Chart.tsx` listen on `window` for Escape only).
- **Website overlay.** Same pattern as Browse: `position: fixed`, `z-index: 20`, under the header. Never `display: none` the trading screen and never unmount it while a session runs (streams, alerts and notifications must keep working). Modals and popups are at 1000 or above and must stay above Games.
- **Main thread (website).** Games share the renderer with live trading. No Games task may block the main thread for more than 8 ms while a session is active; heavy generators (Track B) run in a module Web Worker. The Games chunk is lazy: nothing loads until Games opens.
- **Rust changes need a desktop rebuild.** `desktop_games_request` and `open_games_window` are new commands; an older desktop build shows an unknown-command error when the Games button is used.
- **Parity.** `valid_games_path` (Rust), `validGamesPath` (shared TS) and their test cases must stay identical.
- **`data/` is gitignored.** The repo ignores `data/` (runtime data), so `.gitignore` carries `!shared/games/data/` for the Games outbox and sync code. Never rely on `git add <folder>` alone: check `git status` shows every new file. A test in `boundary.test.ts` fails if any file under `shared/games` or in the host glue matches an ignore rule. (This once left four files out of a PR and only CI's clean build noticed.)
- **Brain game timing (B1).** In `shared/games/brain/**` never call `Date.now()`, `setTimeout` or `setInterval` (a scan test fails on them): onset comes from the rAF timestamp, RT from `event.timeStamp`, deadlines from the frame clock. A stimulus must be painted inside the frame callback that records its onset (`flushSync`). A View that restarts (React StrictMode) must rebuild its engine from the session `seed`, not reuse the advanced `rng`.
- **Testing the website dev server.** The Vite dev client's HMR websocket points at `wss://tradematangi.co.in` here and fails every 60 s ("server connection lost"), which reloads the page. For any browser test longer than a minute (a 60 s game block) serve the built site: `vite build --outDir <dir>` then `vite preview --outDir <dir>`, as `scripts/start-frontend.sh` does.
- **Counting rounds (B2).** A game with a fixed number of rounds must count a round when it is judged (`evaluate`), never when it is handed out (`next`): the hook discards and replaces a round after a bad frame or a focus loss, and a replacement must not use up one of the rounds. Span games get this from the span tracker.
- **Workers and typed answers (B3).** A heavy generator goes behind `GeneratorHost` and runs in a module Web Worker (`new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`), with an inline fallback in `host.ts`: never assume a Worker exists (vitest runs in plain node; a desktop or CSP setup may refuse one). A game that needs a text answer uses an `<input>` inside the game's own element (Esc still reaches the shell); refocus it with `requestAnimationFrame`, not `setTimeout` (the brain scan test bans timers). A feedback delay is waited on the frame clock for the same reason.
- **Testing frame-driven games headless.** The brain games run on `requestAnimationFrame`; headless Chrome produces no frames while a test only sleeps, so the game appears frozen. Wait on page text (Playwright's text wait polls on frames) instead of a plain sleep, and drive the page from `evaluate` bots that read the DOM (a bot can also read canvas pixels).

