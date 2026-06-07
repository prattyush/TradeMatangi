#### Trade Practice Tools

##### Trade Stepwise Replayer.
This feature requires to have a replayer similar to what trading view has. That is once a symbol is selected and options OTM etc are selected and time and other details. When user presses start only 1 bar is moved, only one new bar is added. Then user has to keep pressing on next button to get new bars. The trading panel and all other panels remains the same. AIHelper will be applicable in this mode. But, all other trade types should work. Strategies should work etc. Guardrails may or may not work. The idea is imagine we are pausing simulation and starting it after each bar. The UI can play it like a fast speed of streaming like in simulation, as fast as is allowed provided that all trades types should function, i.e target/limit and stoploss orders. The overall idea is waiting for 3 mins for a bar takes lot of time, for mental practice. This would be a quick mental practice for users to try their strategies on data with exact all order types as in papertrading or real trading.

You can ask questions if required.


##### Trade Pattern Logger
This feature would a separate window, in which user can select older date, option or equity, OTM value, symbol and then select display. Upon display the entire chart would be displayed till days end for equity and options. For Options the OTM strike price chart would be displayed. The user can delete any options chart and re-display it with different OTM similar to what is present in simulation, real or paper trading. What this window will help is user to define entry and exit points in the chart and provide a name for this strategy. This strategy is saved, a drop-down can be provided for strategies which are already defined. Keep saving strategy names as we go. And then the user can click on save. These stragies with entry and exit points, can also be viewed with some other window or in the same window with the charts. 
The idea is user can save on charts possible entry and exit points for a strategy that he defines, and during trading user would want to see all possible charts for the strategies he labelled. As every day is different, every chart is different, even same strategy needs of have variations to be successful in real environments. one strategy could be marked on more than 15 charts. So plan on how to display them. For options, better to view both underlying and ce/pe charts. Not sure how should the display handle it. But, user can say this is entry for CE in underlying and exit for CE. Be creative.

You can ask questions if required.

---

##### LargeOrders
1. Go over scenario and suggest the best approach. The scenario is I enter a position at 100.0 with quantity 20, and setup stoploss at 60.0 with quantity 20. Now, after 6 minutes market went down, so I added another 20, Now, I have 2 options, either create another stoploss order, or cancel the previous one and create one order for 40. First problem is that if I want to create new SL Order, when I click on SL, full 40 quantity comes, instead of 20 as 20 already has a stoploss. 2nd, I ccan't modify open order stoploss quantity.
Now, if I have 2 orders of stoploss, another problem comes is that if market suddenly movves or bounches to 130 (happens on expiiry days with options), I want to quickly increase stoploss. With 1 order pressing LTP does great, but with 2 or more orders, I have to do that with every order.
Possible solutions are:- 
a) new strategy "Lock Profit" -> This strategy take a price and instead of exiting position at a given price, it setups up stoploss similar to Aggresive SL and Breakeven strategy. This strategy take input of price either through chart click or LTP. Also, it can get percentage like Take Profit. It monitors every tick like Breakeven strategy and set stoploss as Breakeven or Aggresive SL does. Now, this strategy should update stoploss values for all open stoploss orders for that symbol. Quantity may be 2,3, ... or 1.
b) Option in stoploss to increase quantity. Open to discussion.

2. Supporting max contracts per options (index or equity). Now, for index options, NIFTY and SENSEX there is a max limit of contracts per order, NIFTY (1800), SENSEX (1000). So, I buy at market for CE with % of 20 for a wallet funds of 20L at CE price 50. So, I will be buying with 4L money for 50 rupees price which is 8000 contracts. So, this would be  5 orders for NIFTY and 8 orders for SENSEX. Then we would automatically need 5 SL orders for NIFTY and 8 SL orders for SENSEX. So, now back to saame problem of updating soo many orders, then a lock profit strategy makes sense, in which I can also change the price after it is triggered. Also, when creating stoploss orders, it should show remaining buy quantity which doesn't have a stoploss order maxed to the max contracts per order. Or maybe take the entire order size in this case, ilke 8000 when I create on SL it automatically creates 5 orders for NIFTY and 8 orders for SENSEX for stoploss.

3. Supporting of change targets of Take Profit and Lock Profit (to be implemented) strategies prices after it is triggered. Otherwise it would require cancel them and re-create them. Also, cancellation of individual strategies if required.

4. Support multi stoploss order support for all strategies, like breakeven, aggresive  SL, Take Profit and also AIHelper commands etc. Make a cross swipe across all features if anything needs to handle multiple stoplosss orders.

##### Recording
1. This requirement is for providing a feature in which users can record their trading sessions, screen recording. Only applicable for simulations, real and paper trading. User can pause and resume recording, stop and start recording. Recording would take browser permissions, and I think when it is finished it would ask where to store in the computer.
 



## Implementation Status

### Sprint 1 — Trade Stepwise Replayer ✅ COMPLETE

**Backend changes:**
- `SimulationSession`: added `stepwise`, `step_event`, `current_bar_index`, `total_bars` fields
- `_count_total_bars()`: counts distinct bar slots in the day's equity data
- `create_session()`: accepts `stepwise=True`, computes total_bars, stores step_event
- `_run_session()`: bar-boundary detection across all 3 loops (dual-stream, single-right options, equity); `step_event.wait()` parks loop after each bar; ticks stream at max speed (no sleep) in stepwise mode
- `stop_session()`: sets `step_event` on stop so parked loop unblocks cleanly
- New endpoint: `POST /api/simulation/{session_id}/next-bar`
- `session_type="stepwise"` stored as "sim" internally; `stepwise=True` flag distinguishes it
- `SimulationStartRequest`: added `stepwise: bool = False`
- `SimulationStartResponse`: added `stepwise: bool`, `total_bars: Optional[int]`

**Frontend changes:**
- `api.ts`: `SimulationStartRequest` allows `session_type='stepwise'`; `SimulationStartResponse` has `stepwise`, `total_bars`; added `nextBar(sessionId)` function
- `useSimulation.ts`: added `stepwise`, `barPaused`, `barIndex`, `totalBars` to state; added `handleBarPaused()` and `nextBar()` callbacks
- `SessionControls.tsx`: added Stepwise toggle button; "Start Stepwise" label; "▶ Next Bar (N of M)" button replaces Pause when in stepwise mode and bar is paused
- `App.tsx`: handles `bar_paused` SSE event; passes stepwise props to SessionControls

**Tests:** 16 new tests in `tests/test_stepwise_replayer.py` — all pass.

---

### Sprint 2 — Pattern Library ✅ COMPLETE

**New files:**
- `backend/app/services/pattern_logger_service.py`: DynamoDB CRUD for `PatternAnnotations` table
- `backend/app/routers/pattern_logger.py`: REST endpoints (prefix `/api/pattern`)
- `backend/tests/test_pattern_logger.py`: 21 tests — all pass

**DynamoDB table: `PatternAnnotations`**
- One record per (user, symbol, date, instrument_type[, right])
- Annotations carry per-annotation `strategy_name` — multiple strategies co-exist on one chart
- PK: `chart_id` (UUID)

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/pattern/strategies` | List unique strategy names for user |
| GET | `/api/pattern/charts[?strategy=X]` | List chart metadata (optionally filtered) |
| GET | `/api/pattern/chart/by-date` | Find existing chart by date/symbol/instrument |
| GET | `/api/pattern/chart/{id}` | Full chart with all annotations |
| POST | `/api/pattern/chart` | Create chart |
| PUT | `/api/pattern/chart/{id}` | Update annotations/notes |
| DELETE | `/api/pattern/chart/{id}` | Delete chart |
| GET | `/api/pattern/ohlc/equity` | Full-day equity OHLC candles |
| GET | `/api/pattern/ohlc/options` | Full-day options OHLC candles |

**Reuses:** `data_loader.resample_to_candles()`, `data_loader.candles_to_records()`, `options_service.load_options_dataframe()`

---

#### Frontend

**New file:** `frontend/src/pages/PatternLibrary.tsx`

**Access:** "📚 Patterns" button in main app header → full-screen Pattern Library page with "← Back to Trading" nav.

**Features:**
- Load form: symbol, date, equity/options toggle, OTM offset → Load Chart
- Auto-loads existing annotations when navigating to a previously-annotated date
- Annotation toolbar: active strategy selector (dropdown + new strategy name field) + 6 tool buttons (Entry/Exit × Underlying/CE/PE)
- Click-to-annotate: click a candle to place the selected marker; click same spot again to remove
- Multi-strategy per chart: each annotation carries its own `strategy_name`; active strategy's markers are full opacity, others dimmed
- Options mode: stacked underlying pane (top) + options CE/PE pane (bottom); each pane only shows annotations for its instrument type
- Save/update: saves to backend, refreshes strategy list
- Gallery: scrollable grid of saved charts filtered by strategy dropdown; 6 per page with pagination; cards show date, symbol, instrument badge, entry/exit counts, all strategy names on chart
- Load from gallery: loads full chart + annotations, pre-selects strategy
- Delete from gallery: with one-click confirmation

**api.ts additions:** `patternListStrategies()`, `patternListCharts()`, `patternGetChartByDate()`, `patternGetChart()`, `patternCreateChart()`, `patternUpdateChart()`, `patternDeleteChart()`, `patternOhlcEquity()`, `patternOhlcOptions()` + `PatternAnnotation`, `PatternChartMeta`, `PatternChart`, `PatternOHLCResponse` types

---

### Sprint 3 — LargeOrders ✅ COMPLETE

**Sprints 1-3 (Multi-SL, LockProfit, MaxContracts) implemented together.**

**Problem addressed:** Pyramiding into large index-options positions creates multiple SL orders that strategies and the SL form couldn't handle. New SEBI-mandated per-order contract limits (NIFTY 1800, SENSEX 1000) require auto-splitting large orders.

**Backend changes:**

*Multi-SL Foundation (`strategy_service.py`):*
- Removed `quantity` filter from `_find_open_exit_orders()` — now returns ALL pending exit orders matching side + right (not just qty-matched ones)
- `AggressiveStoploss`, `BreakEven`, `TargetProfit` — all updated to iterate over all returned SL orders

*Lock Profit strategy (`strategy_service.py`, `schemas.py`, `routers/strategies.py`):*
- New `StrategyType.LOCK_PROFIT = "LockProfit"` enum value
- `StartStrategyRequest` fields: `lock_profit_value`, `lock_profit_is_pct`
- `_on_tick_lock_profit()`: fires once when price crosses lock_price, moves ALL open SL orders to `lock_price - buffer` (LONG) or `+ buffer` (SHORT), sets `triggered=True` in metadata
- Strategy stays RUNNING after trigger so price can be re-armed
- `cancel_strategy()`: individual strategy cancellation
- `update_strategy_price()`: updates `lock_profit_price` or `target_profit_value`, resets `triggered=False` for re-arming
- New endpoints: `POST /api/strategies/{id}/cancel`, `PATCH /api/strategies/{id}/price`
- `StrategyResponse.triggered: bool` added

*Batch Update SL (`routers/orders.py`):*
- `PATCH /api/orders/bulk-update-sl` — updates ALL pending SL orders for a session/right to the same trigger price
- Route registered BEFORE `/{order_id}` to avoid FastAPI parameterized-route match
- Real trading: calls Kotak `modify_sl_order` for each order with `kotak_order_id`

*Max Contracts Auto-Split (`config.py`, `order_service.py`, `routers/orders.py`):*
- `MAX_CONTRACTS_PER_ORDER` dict: NIFTY=1800, SENSEX=1000, BANKEX/BANKNIFTY=900, FINNIFTY=1800, MIDCPNIFTY=2800
- `get_max_contracts(symbol)` and `split_quantity(symbol, qty)` helpers in `order_service.py`
- `POST /api/orders` auto-splits large SL options orders; each chunk placed as separate order; extra chunks pushed via SSE `order_placed` events
- Real trading: each split chunk registered with Kotak via `_register_kotak_sl_for_order()`

**Frontend changes:**

*Smart SL default qty (`OrderPanel.tsx`):*
- When SL tab selected, defaults qty to `position.quantity - coveredQty` (uncovered portion only)
- `coveredQty` = sum of all pending SL orders for the same side+right

*Lock Profit UI (`OrderPanel.tsx`):*
- New section under Exit Strategies: price input + LTP + chart-pick + % checkbox + "▶ Start Lock Profit" button (purple theme)
- Running strategies list: `(triggered)` badge, individual ✕ cancel, inline price edit for LockProfit/TargetProfit

*Batch Update SL UI (`OrderPanel.tsx`):*
- Shown when 2+ pending SL orders exist for active right
- Price input + LTP + "Update All [CE/PE/equity] SLs" button (orange theme)

*Max contracts hint (`OrderPanel.tsx`):*
- Below SL qty input: "Will create N orders (max M/order)" when qty exceeds limit

*API (`api.ts`):*
- `cancelStrategy()`, `updateStrategyPrice()`, `bulkUpdateSL()` methods
- `StrategyResponse.triggered: boolean`, `StartStrategyRequest` lock profit fields

**New test files:**
- `backend/tests/test_max_contracts.py` — 15 tests: `get_max_contracts()` and `split_quantity()` coverage
- 23 new tests added to `test_strategy_service.py`: multi-SL AggressiveStoploss/BreakEven, LockProfit (long/short trigger, no re-trigger, multi-SL, re-arm, cancel)

---

### Sprint 4 — AIHelper Multi-SL ✅ COMPLETE

**Problem addressed:** The AIHelper's `update_or_create_stoploss()` used `next()` to find and update only ONE SL order. With pyramiding and max-contracts auto-split, a position can have multiple SL orders (e.g. 3 SL orders for 5400 NIFTY contracts split across 3 chunks). The old code silently left the other chunks at the original SL price.

**AIHelper changes (`aihelper/services/backend_client.py`):**
- New `bulk_update_stoploss(session_id, right, trigger_price)` — calls `PATCH /api/orders/bulk-update-sl` to update ALL pending SL orders in one request; rounds trigger price
- `update_or_create_stoploss()` rewritten: collects ALL SL orders matching `right` → if any exist, calls `bulk_update_stoploss`; if none, creates a new SL order; falls back to create when `get_open_orders` fails

**Tests (`aihelper/tests/test_backend_client_exit.py`):**
- New `TestBulkUpdateStoploss` class (3 tests): correct endpoint, equity right omitted, price rounding
- `TestUpdateOrCreateStoploss` expanded to 6 tests: single-SL bulk-update, multi-SL bulk-update, cross-right isolation (PE SLs don't block CE update), create-when-none, short-position BUY side, create-on-get-open-orders-failure

---

### Sprint 5 — Recording ✅ COMPLETE

**Problem addressed:** Users wanted to record their trading sessions for review, study, and upload to YouTube.

**Approach:** Pure browser-side screen recording using `navigator.mediaDevices.getDisplayMedia()` + `MediaRecorder` API. No backend changes required.

**Format:** WebM with VP9+Opus (`video/webm;codecs=vp9,opus`), falling back to VP8+Opus then plain WebM. WebM is directly accepted by YouTube. The browser's screen-share dialog also offers an optional system/tab audio checkbox (Chrome).

**New file: `frontend/src/hooks/useRecording.ts`**
- `RecordingState` type: `'idle' | 'requesting' | 'recording' | 'paused'`
- MIME priority: `vp9,opus` → `vp8,opus` → `video/webm` (via `MediaRecorder.isTypeSupported`)
- `startRecording(filename)`: calls `getDisplayMedia`, creates `MediaRecorder`, collects 1-second chunks
- `stopRecording()`: stops recorder; `onstop` handler creates `Blob`, triggers browser "Save As" download via hidden `<a>` click
- `pauseRecording()` / `resumeRecording()`: delegates to `mediaRecorder.pause()` / `.resume()`
- Video-track `ended` listener: auto-stops recording when user clicks browser "Stop sharing" button
- Cleanup on unmount: stops any active recorder

**Modified files:**
- `frontend/src/hooks/useRecording.ts` — new file (see above)
- `frontend/src/App.tsx` — imports `useRecording`; calls hook in `AppInner`; adds recording controls to header bar between Patterns button and SettingsModal
- `frontend/src/index.css` — adds `@keyframes recBlink` for the animated ● recording indicator

**Header UI:**
- Hidden when `sessionState === 'idle'` (no active session)
- `● REC` button (dark red) when idle but session active
- `Requesting…` (disabled) while browser permission dialog is open
- `● Pause ⏹ Stop` row when recording (● blinks red at 1 Hz)
- `⏸ Resume ⏹ Stop` row when paused (⏸ shown in yellow)
- Filename: `TradeMatangi_<symbol>_<date>_<sessionType>.webm`

**No backend changes. No new tests** (browser API only — not unit-testable without mocking `getDisplayMedia`).

**Follow-up fix (direct commit to dev + main):** `getDisplayMedia` errors were previously swallowed silently — clicking `● REC` appeared to do nothing. Fixed by checking `window.isSecureContext && navigator.mediaDevices?.getDisplayMedia` upfront (shows "Screen recording requires HTTPS or localhost" on plain HTTP) and surfacing non-cancellation errors in `recordingError`. `NotAllowedError` (user dismissed picker) still shows nothing. Note: EC2 can be unlocked via `chrome://flags` → "Insecure origins treated as secure".

---

## Test Counts

| Phase | Backend Tests | AIHelper Tests | Notes |
|-------|--------------|----------------|-------|
| Before Phase XII | 534 | 279 | |
| After Sprint 1 | 550 | 279 | +16 stepwise tests |
| After Sprint 2 | 571 | 285 | +21 pattern logger tests (backend); frontend no new tests |
| After Sprint 3 (LargeOrders) | 601 | 285 | +30 multi-SL/LockProfit/max-contracts tests |
| After Sprint 4 (AIHelper Multi-SL) | 601 | 291 | +6 aihelper bulk-SL tests |
| After PR #185 (AI Analysis drill-down) | 624 | 305 | +14 aihelper pattern instance tests |
| After PR #190 (date range fix + chart enhancements) | 624 | 305 | No new tests (prompt + frontend-only changes) |
| After PR #192 (CE/PE marker colors + stale marker fix + marker size) | 624 | 305 | No new tests (frontend-only changes) |
| After PR #195 (EMA 9/21 on CE/PE charts + marker size 0.6) | 624 | 305 | No new tests (frontend-only changes) |
| After PR #197 (Trade Analysis chart height ratio 0.6) | 624 | 305 | No new tests (frontend-only changes) |
| After PR #199 (Underlying chart CE/PE marker filter) | 624 | 305 | No new tests (frontend-only changes) |
| After Sprint 5 (Recording) | 624 | 305 | No new tests (browser API, frontend-only) |

## PR Log

| Sprint | Branch | Status |
|--------|--------|--------|
| Sprint 1 — Stepwise Replayer | feature/phase12-stepwise | Merged to dev |
| Sprint 2 — Pattern Library | feature/phase12-pattern-library | Merged to dev |
| Sprint 3 — LargeOrders | feature/phase12-large-orders | PR #173 merged to dev |
| Sprint 4 — AIHelper Multi-SL | feature/phase12-large-orders-sprint2 | PR #174 merged to dev |
| AI Analysis: pattern drill-down + panel resize/font | feature/pattern-drill-down | PR #185 merged to dev |
| AI Analysis: show date+time in flagged trade rows | feature/ai-analysis-show-date | PR #187 merged to dev |
| AI analysis date range fix + Trade Analysis chart enhancements (EMA 9/21, split options layout, maximize, historicalDays) | fix/ai-analysis-date-range | PR #190 merged to dev |
| CE/PE marker colors (white/cyan), stale marker fix (key prop), marker size 0.5 | fix/trade-analysis-marker-colors-and-stale | PR #192 merged to dev |
| EMA 9/21 on CE/PE OptionsChart + marker size bumped to 0.6 | fix/options-chart-ema | PR #195 merged to dev |
| Trade Analysis chart height ratio increased from 0.45 to 0.6 | fix/trade-analysis-chart-height | PR #197 merged to dev |
| CE/PE marker filter toggle [All/CE/PE] on Underlying chart | fix/underlying-chart-marker-filter | PR #199 merged to dev |
| Sprint 5 — Recording (screen record sessions as WebM/YouTube-compatible) | feature/phase12-recording | PR #201 merged to dev + main |
| Recording fix — surface getDisplayMedia errors; guard on isSecureContext | dev (direct commit) | Merged to dev + main |

---

### Pattern Library Enhancements — PR #167 (feature/phase12-bugfixes)

All changes are on `feature/phase12-bugfixes`, open PR targeting `dev`.

**Bug fixes:**
- Options mode previously only loaded one side (CE or PE based on OTM offset sign); now always loads **both CE and PE** as a symmetric OTM pair (CE = ATM + offset×interval, PE = ATM − offset×interval)
- Newly-added option pane was invisible when another pane was present — root cause: flex `min-width: auto` on pane wrappers prevented the existing pane from shrinking, leaving 0px for the new pane. Fixed with `minWidth: 0` on option pane wrapper divs
- `addPaneError` was rendered inside a `flexWrap` row and could be clipped by outer `overflow: hidden`, making failures invisible. Moved to a dedicated full-width div below the controls

**New features:**

*Data:*
- Backend `/api/pattern/ohlc/equity` and `/api/pattern/ohlc/options` now accept `days_back` param (default 2, max 5); prepends prior trading days so EMA warmup candles and prior-day context are visible
- `api.ts`: `patternOhlcEquity` and `patternOhlcOptions` accept `daysBack?` param

*Chart panes:*
- **EMA 9/21** overlay on every pane (orange EMA9, blue EMA21) with per-pane toggle button
- **Drawing tools** on every pane: horizontal line, trend line, Fibonacci retracement, parallel channel — same implementation as live trading charts (`Chart.tsx`); per-pane Draw dropdown + Clear button + step instructions
- **Maximize/restore** (⤢/⤡) button on every pane (underlying + all option panes); non-maximized panes hidden via `display: none` keeping chart state intact
- **Remove** (✕) button on each option pane to delete it individually; underlying cannot be removed

*Dynamic panes:*
- Option panes stored as a dynamic `OptionPane[]` array instead of fixed CE/PE states; each pane has a unique numeric ID
- **"Add Pane" strip** below chart area (create mode, options only): CE/PE toggle, strike input, ATM hint, snap-to-interval preview; loads that contract's OHLC and adds a new pane alongside existing ones — supports e.g. UL + CE 23500 + CE 23400 + PE 23500 simultaneously
- **Success feedback**: green "✓ CE 23500 pane added" toast for 2.5 s after successful add

*Create vs View modes:*
- Mode toggle button in header (✏ Create / 👁 View)
- **Create mode**: load controls + annotation toolbar + charts + "Add Pane" strip + compact gallery strip
- **View mode**: 2-column gallery grid (click card to expand read-only chart above gallery; all panes shown with `readonly=true`; annotation toolbar and drawing tools hidden); "✕ Close" returns to full gallery

*Gallery:*
- Reorganised to CSS `grid, gridTemplateColumns: repeat(2, 1fr)` in both modes

**PR #167 merged to dev.**

---

### Bug Fix — PR #168 (feature/pattern-view-annotated-panes-only)

**Fix:** Pattern Library View mode — only show option panes for instruments that have annotations.

Previously, when loading a chart in View mode, both CE and PE panes were rendered whenever a strike was present (i.e. OHLC data could be fetched), even if no annotations existed for one side. A user who only marked Underlying + PE would still see an empty CE pane.

**Root cause:** `handleGalleryLoad` added a pane for every `right` whose OHLC fetch succeeded, without checking whether any annotation referenced that instrument.

**Fix:** Compute `annotatedRights = new Set(chart.annotations.map(a => a.instrument))` after loading chart data; gate each option pane on `annotatedRights.has('CE')` / `annotatedRights.has('PE')`. Change is one additional `Set` + two extra `&&` guards in `handleGalleryLoad` (`PatternLibrary.tsx`).

Applies in both View and Create modes (correct for both — panes without annotations shouldn't auto-appear; use "Add Pane" strip to add new ones).

**PR #168 merged to dev.**

---

### AI Analysis Enhancements — PR #185 (feature/pattern-drill-down)

Two features shipped together:

#### 1. Per-Pattern Flagged Trade Drill-Down

**Problem:** The AI analysis card showed pattern summaries (e.g. "✗ Scared Exits on Losers — 6 of 8 losing trades") but gave no way to see *which* specific trades were flagged.

**Backend changes:**
- `aihelper/services/pattern_detector.py` — `aggregate_findings()` now produces an `instances[]` list for all 5 pattern types (`scared_exits`, `early_exits`, `entry_deviation`, `buying_on_top`, `panic_entries`). Each instance: `{group_id, direction, pnl, entry_time, exit_time, symbol, detected, detail}` where `detail` is a one-line human-readable metric (e.g. "₹245 loss, price reversed", "+2.1% from bar open"). Capped at 10 per pattern.
- `aihelper/services/analysis_service.py` — `_run_pattern_analysis()` now includes `entry_time`, `exit_time`, `symbol` in every group finding. New `_extract_pattern_instances()` helper filters to `detected=True` only. `run_analysis()` merges a `pattern_instances` dict into the returned result.

**Frontend changes (`frontend/src/services/api.ts`):** Added `PatternInstance`, `PatternInstances` interfaces; `AnalysisResult` gains `pattern_instances?: PatternInstances`.

**Frontend changes (`frontend/src/components/AIChatPanel.tsx`):** Analysis card gets a collapsible **FLAGGED TRADES** section at the bottom. Clicking the toggle reveals per-pattern sub-tables (Scared Exits / Early Exits / Chasing Entries / Buying on Top / Panic Entries) with entry time (HH:MM), direction (colored LONG/SHORT), P&L (colored), and the key metric detail.

**Tests:** 14 new aihelper tests across `test_pattern_detector.py` (instances cap, per-pattern instance assertions) and `test_analysis.py` (`TestExtractPatternInstances`, `TestRunAnalysisIncludesPatternInstances`).

#### 2. Resizable Panel Width + Font Size Toggle

**Problem:** The AI chat panel had a fixed 480px width and small fixed font sizes, making analysis cards hard to read.

**Changes (AIChatPanel.tsx only):**
- **Left-edge drag handle** — 6px transparent strip on the left edge of the panel (cursor `ew-resize`, blue tint on hover). Dragging left widens the panel (max 900px); dragging right narrows it (min 360px). The panel's right edge stays anchored and the left edge shifts.
- **Font size toggle (`A` / `A+` / `A++`)** — Small button in the header that cycles through three font scales (1×, 1.2×, 1.45×). Scales message text and all analysis card text (summary, patterns, suggestions, stats, flagged-trades table). Header chrome and input box are unaffected.

**PR #185 merged to dev.**

---

### AI Analysis Date+Time Fix — PR #187 (feature/ai-analysis-show-date)

**Problem:** Flagged trade rows in AI analysis drill-down showed only HH:MM. When analyzing trades across multiple days, users could not tell which day each trade belonged to.

**Changes (`AIChatPanel.tsx` only):**
- Column header renamed "Time" → "Date/Time"
- Time cell now formats as `DD/MM HH:MM` (e.g. `29/05 10:06`) — date derived from `entry_time` Unix timestamp which already encodes IST wall-clock date via the IST-as-UTC trick.

No backend or API changes needed.

**PR #187 merged to dev.**

---

### AI Analysis Date Range Fix + Trade Analysis Chart Enhancements — PR #190 (fix/ai-analysis-date-range)

Two fixes shipped together:

#### 1. AI Helper Trade Analysis Date Range Bug

**Problem:** When asking the AI Helper to analyze trades over a multi-day range (e.g. "analyze my trades for this week, starting and including 2026-06-01"), only today's data was returned.

**Root cause:** The LLM system prompt in `extract_analysis_params` (`aihelper/services/llm_service.py`) had a single vague date rule that only hinted at `from_date` calculation and never specified `to_date`. Compare with `extract_date_range` (same file) which had complete `from=X, to=Y` rules.

**Fix (`aihelper/services/llm_service.py` only):** Replaced the vague one-liner with explicit `from = ..., to = ...` rules for every pattern — matching the working format in `extract_date_range` — and added new patterns: "this week" (→ most recent Monday to today) and "starting from/since YYYY-MM-DD" (→ that date to today).

No backend, frontend, or test changes.

#### 2. Trade Analysis Chart Enhancements

**Problem:** The Trade Analysis window's single underlying chart lacked EMA lines, had no way to view individual option strikes, and had no maximize option.

**Changes (`frontend/src/components/TradeAnalysis.tsx`, `frontend/src/App.tsx`):**

*EMA 9 & 21 on underlying chart:*
- `computeEMA` / `nextEMA` helpers copied from `Chart.tsx`
- Two line series added to `AnalysisChart`: EMA 9 (#f0883e orange), EMA 21 (#79c0ff blue), both `lineWidth: 1`, no price line / last-value label
- Computed and set after candle data loads

*Side-by-side split layout for options sessions:*
- New `OptionsChart` component: loads options OHLC via `api.getOptionsHistorical()`, shows trade markers at option trade price (green BUY / red SELL)
- New `AnalysisChartPanel` component: derives unique option tabs from `allTrades` (keyed by `right-strike-expiry`, sorted CE first then by strike). For equity sessions: single underlying chart unchanged. For options sessions: `display: flex` split — underlying (left 50%) + tab bar + active option chart (right 50%)
- Tab bar: pill buttons with `#58a6ff` active highlight; switching tabs remounts the `OptionsChart` for that strike
- New `ChartToolbar` sub-component: title label + ⤢/⤡ maximize button

*Per-chart maximize (fullscreen overlay):*
- `AnalysisChartPanel` tracks `maximizedChart: 'underlying' | string | null` state
- When set, renders a `position: fixed; inset: 0; z-index: 2000` overlay with a header bar (title + ⤡ Restore button) and the maximized chart filling the remaining height
- Escape key also dismisses the overlay

*`historicalDays` wired through:*
- `TradeAnalysis` now accepts `historicalDays?: number` prop; `App.tsx` passes the existing `historicalDays` state
- Flows down: `TradeAnalysis` → `GroupCard` → `AnalysisChartPanel` → `AnalysisChart` + `OptionsChart`
- Both chart data fetches use `historicalDays` so paper/real sessions correctly trigger the backend's stale-data re-fetch from the broker API

**PR #190 merged to dev.**

---

### CE/PE Marker Colors + Stale Marker Fix + Marker Size — PR #192 (fix/trade-analysis-marker-colors-and-stale)

**Problem 1:** `OptionsChart` in Trade Analysis used green/red markers for BUY/SELL, inconsistent with simulation/paper/real trading options panes which use white/cyan.

**Fix:** Changed `OptionsChart` marker colors to `#FFFFFF` (BUY) / `#00AAFF` (SELL), matching `AnalysisChart` (underlying) and `Chart.tsx` options-pane conventions.

**Problem 2:** Switching between CE/PE strike tabs left markers from the previous strike visible on the new chart (stale state due to chart instance reuse).

**Fix:** Added `key={activeTab}` to `OptionsChart` in `AnalysisChartPanel`, forcing a fresh chart mount on every tab switch.

**Additional:** Reduced marker size from `1` to `0.5` in all charts (`Chart.tsx`, `AnalysisChart`, `OptionsChart`) for less visual clutter.

**PR #192 merged to dev.**

---

### EMA 9/21 on CE/PE OptionsChart + Marker Size 0.6 — PR #195 (fix/options-chart-ema)

**EMA overlays:** Added EMA 9 (orange `#f0883e`) and EMA 21 (blue `#79c0ff`) to `OptionsChart` in Trade Analysis, mirroring the identical pattern already on `AnalysisChart` (underlying). Uses the same `computeEMA()` function; EMAs computed from candle closes after each data load; refs nulled on unmount.

**Marker size:** Bumped from `0.5` to `0.6` across all charts (`Chart.tsx`, `AnalysisChart`, `OptionsChart`).

**PR #195 merged to dev.**

---

### Trade Analysis Chart Height Ratio 0.6 — PR #197 (fix/trade-analysis-chart-height)

**Change:** Increased chart height multiplier from `width * 0.45` to `width * 0.6` in both `AnalysisChart` (Underlying) and `OptionsChart` (CE/PE). Applied to both initial mount height and ResizeObserver dynamic resize (4 occurrences). Fullscreen view unaffected.

**PR #197 merged to dev.**

---

### CE/PE Marker Filter on Underlying Chart — PR #199 (fix/underlying-chart-marker-filter)

**Change:** Added `[All] [CE] [PE]` toggle buttons to `AnalysisChart` (Underlying) in Trade Analysis. Buttons appear only when the session contains options trades. Default is `All` (unchanged behaviour). `CE` hides PE markers; `PE` hides CE markers. Equity trades (no `right` field) always pass the filter. State is self-contained inside `AnalysisChart`; works in both normal and fullscreen view.

**PR #199 merged to dev.**

---

### CE/PE Markers on Underlying Chart in Live Trading Views — PR #204 (fix/ce-pe-markers-on-underlying-live)

**Problem:** In Simulation, Real, Paper, and Stepwise trading views, Buy/Sell markers from CE/PE options orders appeared on the CE/PE charts but not on the underlying (NIFTY/BANKNIFTY) chart.

**Root cause:** `getTradesForPane` in `App.tsx` filtered equity panes to `!t.right` only, preventing CE/PE trades from reaching the Chart component. `Chart.tsx` already had `crossChartMarkerStyle()` and the full rendering logic; `useSimulation.ts` already captured `underlying_price` at trade time — only the filter needed fixing.

**Fix:** Changed equity-pane filter in `App.tsx` to `!t.right || t.underlying_price !== undefined`, passing CE/PE trades with an underlying price snapshot through to the underlying chart.

**Color alignment:** Updated `crossChartMarkerStyle()` to use the same white/blue palette as the CE/PE chart itself, so colors are consistent across charts:

| Order | Label | Color |
|-------|-------|-------|
| CE Buy | CB | White `#FFFFFF` — matches CE chart Buy |
| CE Sell | CS | Blue `#00AAFF` — matches CE chart Sell |
| PE Sell | PB | White `#FFFFFF` — bullish direction, same as CE Buy |
| PE Buy | PS | Blue `#00AAFF` — bearish direction, same as CE Sell |

**PR #204 merged to dev.**

---

### CE/PE Underlying Markers — Order-Fill Stamping Fix — PR #206 (fix/underlying-marker-order-fill)

**Problem:** Even after PR #204, markers still didn't appear on the underlying chart because `underlying_price` was never actually being set on trades in the normal UI flow.

**Root cause:** The UI places orders via `placeOrder()` (limit/target/stoploss), not `buy()`/`sell()`. Trades enter state only when the order fills via the `order_filled` SSE event. `handleOrderFilled` fetches trades fresh from the backend, which never sets `underlying_price` (frontend-only field). So the filter `t.underlying_price !== undefined` always failed silently.

**Three fixes in `useSimulation.ts`:**

1. **`setLatestTick`** — moved `latestEquityTickRef.current = tick` outside the `setState` updater so it is set synchronously the moment each equity tick arrives (React 18 batching could delay it when inside an updater).

2. **`handleOrderFilled`** — captures equity price before the async `api.getTrades()` fetch, then stamps `underlying_price` on newly-seen CE/PE trade IDs after the fetch.

3. **`setTrades`** — same stamp logic for the Kotak reconciliation refresh path (real-trading only): missed stoploss fills that surface when the user clicks Refresh in TradeHistory get `underlying_price` stamped with the current live price.

**Coverage:**

| Mode | Fill path | Fixed by |
|------|-----------|----------|
| Simulation / Stepwise | `order_filled` SSE → `handleOrderFilled` | Fix 2 |
| Paper / Real trading | `order_filled` SSE → `handleOrderFilled` | Fix 2 |
| Real trading (missed fills) | Manual Refresh → `setTrades` | Fix 3 |
| AI-placed orders | `new_trade` SSE → `addTradeFromSSE` | Already correct |

**PR #206 merged to dev.**
