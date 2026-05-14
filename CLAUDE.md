# Trade Matangi Project

All development should be done in dev branch and finally merging to main branch will be done manually. When raising a PR please create a new branch and when it is reviewed merge to dev.

@docs/spec.md

## Development Environment

### Running the stack locally (WSL)

```bash
# Terminal 1 — backend at http://localhost:8700
bash scripts/start-backend.sh

# Terminal 2 — frontend at http://localhost:5173
bash scripts/start-frontend.sh
```

### Running backend tests

```bash
cd backend
source ~/venvs/tradematangi/bin/activate
python -m pytest tests/ -v
```

### TypeScript check

```bash
cd frontend
node node_modules/typescript/bin/tsc --noEmit
```

## Key Technical Constraints

- **Python venv must live outside `/mnt/d/`** — use `~/venvs/tradematangi`. The Windows filesystem does not support the `lib → lib64` symlink that `python -m venv` creates inside the repo.
- **npm must use `--no-bin-links`** — `.bin/` symlinks fail on the Windows filesystem. Scripts already handle this; don't add a plain `npm install` step.
- **IST timestamps**: data files (pickle and parquet) have tz-naive IST DatetimeIndex. The backend uses `df.index.tz_localize("UTC")` (NOT `tz_localize("Asia/Kolkata").tz_convert("UTC")`). This makes Unix timestamps encode IST wall-clock values so Lightweight Charts shows 09:15, not 03:45. Do not change this without updating all timestamp comparisons in `data_loader.py` and the frontend `CANDLE_INTERVAL_SECONDS` window math.
- **3-min candle boundaries**: both backend (`pandas resample("3min")`) and frontend (`Math.floor(time / 180) * 180`) must use the same epoch-aligned formula. These are intentionally kept in sync.
- **Data file lookup order**: `data_loader.load_dataframe` checks `data/ohlcdata/<symbol>-DD-MM-YYYY.parquet` first, then falls back to legacy `data/<symbol>-DD-MM-YYYY.pickle`. New Breeze-fetched data is always saved as parquet in `data/ohlcdata/`. Legacy pickles are auto-migrated to parquet on first access.
- **pyarrow required**: parquet support needs `pyarrow` installed (`pip install pyarrow`). It is in `requirements.txt`. The venv must have it.
- **DynamoDB Local credentials**: when `USE_DYNAMODB_LOCAL=true`, always use hardcoded dummy credentials (`fakeKey`/`fakeSecret`). Never pass real AWS credentials (ASIA* keys) to DynamoDB Local — it will reject them with `UnrecognizedClientException`.
- **ICICI Direct symbol codes**: The canonical symbol keys in `SUPPORTED_SYMBOLS` match ICICI Direct / Breeze API codes exactly: `NIFTY`, `BSESEN`, `TATPOW`, `TATMOT`, `RELIND`. Do not use NSE display names (TATAPOWER, TATAMOTORS, RELIANCE) as symbol keys.
- **Breeze API record limit**: `get_historical_data_v2(interval="1second")` silently truncates to ~1000 records per call (~16 min). A full trading day (22 500 rows) requires pagination. Use `broker_service._fetch_day_paginated` which splits the day into 15-min chunks. Never make a single full-day call for 1-second data.
- **Lightweight Charts — no teardown for layout changes**: calling `chart.remove()` discards all series data. Height/width changes must go through `chart.applyOptions(...)`. The chart init `useEffect` must use `[]` deps (mount only); a separate `useEffect([height])` calls `applyOptions` for height changes.
- **Options cache path**: options parquet files are stored as `data/ohlcdata/{SYMBOL}-{CE|PE}-{STRIKE}-{EXPIRY}-{DD-MM-YYYY}.parquet`. Equity files remain `data/ohlcdata/{SYMBOL}-{DD-MM-YYYY}.parquet`.
- **Options lot sizes (hardcoded, current)**: NIFTY=65, BSESEN=20, RELIND=250, TATMOT=1400, TATPOW=2700. No historical lot size tracking — always use current values.
- **NSE options expiry**: date-aware helper required. From 2025-09-01: weekly and monthly expiry on Tuesday (Monday if holiday). Before 2025-09-01: Thursday (Wednesday if holiday). Monthly = last occurrence of that weekday in the month.
- **BSE SENSEX expiry**: always weekly Thursday regardless of the NSE cutoff date. `_expiry_weekday(date, symbol)` returns 3 unconditionally for `BSESEN`. Options fetched via `exchange_code="BFO"` (not NFO). Equity index data via `exchange_code="BSE"`.
- **`options_only` symbols**: `NIFTY` and `BSESEN` have `options_only: True` in `SUPPORTED_SYMBOLS`. Starting an equity session for these returns HTTP 400. Frontend `OPTIONS_ONLY_SYMBOLS` set auto-selects options mode and disables the equity toggle.
- **`options_exchange_code` in SUPPORTED_SYMBOLS**: each symbol carries `options_exchange_code` (`"NFO"` for NSE symbols, `"BFO"` for BSESEN). `_fetch_options_day_paginated` reads this instead of hardcoding `"NFO"`.
- **SENSEX strike interval**: 100 points (vs NIFTY 50). Configured in both `options_service.STRIKE_INTERVALS` and frontend `SessionControls.STRIKE_INTERVALS`.
- **FundsRatio capital base**: snapshotted from wallet at `POST /api/simulation/start`. Mid-session wallet changes do not affect l/m/h amounts for that session. Ratios: l=3%, m=6%, h=12% (user-overridable in settings).
- **Wallet carry-forward**: keyed per user + calendar date of the replay. Replaying an earlier date uses that date's prior end-of-day balance, not the most recent session's balance.
- **Wallet in-memory store**: `wallet_service._wallets` is a `dict[(user_id, date), float]`. In-memory is source of truth per process; DynamoDB is persistence. Carry-forward uses a DynamoDB `query` with `Key("date").lt(target_date), ScanIndexForward=False, Limit=1` — this is O(1) because `date` is the sort key.
- **Fixed user UUID**: `FIXED_USER_ID = "abc12300-0000-0000-0000-000000000001"` in `config.py`. Used by all services. Do not use `PLACEHOLDER_USER_ID` — that constant was removed in Phase III Sprint 1.
- **Wallet debit/credit coverage**: BUY order placement debits `qty × actual_limit`; BUY cancel credits back `order.reserved_amount`; SELL order fill credits `qty × filled_price`; direct TradePanel BUY debits `price × lot_size`, direct SELL credits `price × lot_size` (lot_size = `LOT_SIZES[symbol]` for options, 1 for equity). SL orders have **zero wallet impact** — no debit on placement, no credit on fill, no credit on cancel.
- **DynamoDB `list_tables()` returns `list[str]`**: `list_tables()["TableNames"]` is already a plain list of table name strings. Use `set(dynamodb.list_tables()["TableNames"])` — do not iterate with `t["TableName"]`.
- **DynamoDB lazy-import patch targets**: services import `get_dynamodb_resource` inside helper functions. In tests, patch `app.services.db.get_dynamodb_resource`, not the module that calls it.
- **`compute_funds_ratio_quantity` lot_size parameter**: takes explicit `lot_size: int = 1`, NOT auto-derived from `LOT_SIZES`. The router controls whether equity (lot_size=1) or options (lot_size from `LOT_SIZES`) semantics apply. Sprint 3 orders router passes `LOT_SIZES[symbol]` for options sessions, 1 for equity.
- **`PlaceOrderRequest.quantity` is now optional**: `int | None = None`. Required when `funds_ratio_pct` is None; computed server-side from `session_capital × funds_ratio_pct` when provided. Never send both.
- **FundsRatio localStorage keys**: `fundsRatioMode` (boolean string) and `fundsRatios` (JSON `{l, m, h}` with percentage 0–100). Exported helpers `loadFundsRatioMode()` / `loadFundsRatios()` in `SettingsModal.tsx` for App-level init.
- **STOPLOSS trigger logic**: identical to TARGET in `check_orders` — BUY fires when `price >= trigger`, SELL fires when `price <= trigger`. Difference from TARGET: `limit_price = trigger_price` (no 1% deviation) and zero wallet impact.
- **`InsufficientFundsError` constructor**: takes two positional floats `(balance: float, required: float)`, not a string. Use `InsufficientFundsError(current_wallet, unit_cost)`.
- **Options service lazy-import patch target**: `fetch_options_historical` imports `_get_breeze` and `_breeze_to_dataframe` from `broker_service` at call time. In tests, patch `app.services.broker_service._get_breeze`, NOT `app.services.options_service._get_breeze` (which doesn't exist as a module-level attribute).
- **Breeze options expiry format**: `expiry_date` parameter must be `"YYYY-MM-DDTHH:MM:SS.000Z"` with fixed `T06:00:00.000Z` suffix. Use `f"{expiry}T06:00:00.000Z"`.
- **Options gap-fill is lenient**: `_validate_options_gaps` uses bfill+ffill with no gap limit — far-OTM options may not trade from 09:15. Do NOT apply equity's 15-minute gap limit to options data.
- **Naked short margin**: checked in `routers/orders.py` for SELL orders in options sessions when position is not LONG. Uses `get_underlying_price_at(symbol, date, unix_ts)` to read equity price from parquet (not `session.last_price` which is the options price). Margin = `underlying_price × lot_size × 0.20`.
- **Options session also caches equity data**: `POST /api/simulation/start` with `instrument_type=options` calls both `_ensure_session_data` (equity parquet) and `_ensure_options_data` (options parquet). Both must be cached for margin checks and historical chart display.
- **Simulation wallet_service lazy import**: `create_session` imports `wallet_service` inside the function. In tests, patch `app.services.wallet_service.get_balance` directly, NOT `app.services.simulation.wallet_service`.
- **tz_localize guard**: always check `df.index.tzinfo` before applying timezone. Use `df.index.tz_localize("UTC")` only when `tzinfo is None`; use `df.index.tz_convert("UTC")` when already tz-aware. Applies to both `data_loader.load_dataframe` and `options_service.load_options_dataframe`.
- **Options gap-fill tz strip**: `_validate_options_gaps` must strip tz from `df.index` (set `df.index = df.index.tz_localize(None)`) before building tz-naive `pd.date_range` for `reindex`. Mismatched tz causes empty DataFrame after reindex.
- **Dual-stream options queue**: `SimulationSession.queue` maxsize is 3000 (not 500). `queue.put_nowait` must be wrapped in try/except `asyncio.QueueFull` — raises at high replay speeds otherwise crashing the session.
- **React setState batching**: multiple `setState` calls in one synchronous burst → only last call wins. For multi-field tick routing, use a single `setState(s => { const update = {}; ...; return {...s, ...update} })` keyed by field, NOT separate `setState` calls per field.
- **Lightweight Charts "Cannot update oldest data"**: `series.setData(candles)` sets the minimum acceptable timestamp. Any subsequent `series.update(tick)` with `time <= candles[-1].time` throws. For options historical pre-load, filter to `time < startWindowTs` (the first live tick's window start).
- **Lightweight Charts "Object is disposed"**: async `.then()` callbacks fire after chart teardown if a pane unmounts. Guard all three Chart `useEffect` async paths with `let cancelled = false` + `return () => { cancelled = true }` cleanup.
- **Pane wrapper flex shrink**: Lightweight Charts sets an explicit pixel `width` on the canvas. Pane wrapper divs must have `minWidth: 0` or flex siblings cannot shrink below that canvas width after a pane is removed.
- **Options tick routing uses per-right session strike**: `getTickForPane` in `App.tsx` checks CE panes against `sim.sessionStrikeCE` and PE panes against `sim.sessionStrikePE`. CE and PE may stream at different strikes when OTM offset ≠ 0. Panes with a non-matching strike return `null` (history only).
- **OTM offset is direction-aware**: CE strike = `ATM + N × interval`; PE strike = `ATM − N × interval`. Applies to both initial session panes (via `SessionControls.fetchOptionsData`) and mid-session `addPane`. UI label is "OTM", not "Offset".
- **`SimulationSession` carries `strike_ce` and `strike_pe`**: both default to `strike` when not provided (ATM sessions, backward compat). `_run_session` dual-stream loads CE ticks from `strike_ce`, PE ticks from `strike_pe`. `routers/trading.py` `_strike_for_right()` returns the correct per-right strike for trade recording.
- **Options historical includes trading date**: `GET /api/data/options-historical` fetches `prior_trading_days(date, n=2) + [date]` (3 dates). The trading date's candles represent the pre-session window; the frontend filters to `c.time < startWindowTs` to avoid "Cannot update oldest data". Never use `prior_trading_days(n=2)` alone for options — that drops the trading day's pre-session candles.
- **Market tab routes as LIMIT with 1% deviation**: The Mkt tab in `OrderPanel.tsx` places a LIMIT order at `currentPrice × 1.01` (BUY) or `currentPrice × 0.99` (SELL). The 1% deviation guarantees the order fills on the next tick even if price moves slightly. `OrderTypeFull` includes `'MARKET'` as a UI-only state; it is always converted to `'LIMIT'` before calling `onPlaceOrder`. The backend never sees `order_type='MARKET'`.
- **Trade history timestamps use `timeZone: 'UTC'`**: The IST-as-UTC convention means timestamps encode IST wall-clock time as fake-UTC. `toLocaleTimeString` in `TradeHistory.tsx` must use `timeZone: 'UTC'` (not `'Asia/Kolkata'`) to display the correct chart time. Using `'Asia/Kolkata'` adds an extra +5:30, showing times 5.5 hours ahead.
- **Cancel order 404 = already gone**: `api.cancelOrder` treats HTTP 404 as success (returns `null`). This handles the SSE race where an order fills on the backend but the frontend hasn't received the `order_filled` event yet — user clicks ✕, backend returns 404 (order is FILLED not PENDING), UI removes the order cleanly. Any non-404 error still throws.
- **Chart price-pick guard**: `chart.subscribeClick` must NOT check `!param.time` before the price-pick branch. `param.time` is null when clicking in empty chart areas (no candle under cursor), but price-pick only needs `param.point.y` for the y-coordinate→price mapping. Move `if (!param.time) return` to after the price-pick handler; drawing modes still need it.
- **Price pick ⊕ button on placement form**: The `'__new__'` sentinel in `onRequestPricePick` targets the placement price input (not an open order edit row). `injectedEditPrice.orderId === '__new__'` injects the picked price into the `price` state in `OrderPanel`. The same chart-pick flow works for both new orders and edits.
- **Brokerage is backend-computed per trade**: `brokeragePerOrder` (localStorage key `brokeragePerOrder`, default ₹1) is passed as `brokerage_per_order` in `POST /api/simulation/start`. `record_trade()` calls `compute_commission(side, price, qty, brokerage_per_order)` and stores the result in `Trade.commission`. `netDayPnl = sim.dayPnl - sum(t.commission for t in trades)`. Do not use a flat `commission × trades.length` formula — commissions differ per trade because value-based charges scale with price and quantity.
- **Commission formula (Indian markets)**: BUY side: `STT = value × 0.006803%`. SELL side: `STT = value × 0.0625% + exchange_txn_charge = value × 0.06% × 1.18 (GST)`. Plus flat `brokerage_per_order`. Implemented in `trading.py:compute_commission`.
- **Chart toolbar paddingRight for remove button**: The pane remove `✕` button in `App.tsx` is `position: absolute, top: 8, right: 8`. Chart.tsx toolbar must have `paddingRight: 36` so the bar-close countdown (which uses `marginLeft: 'auto'`) does not render under the button.
- **Mid-session pane strike update endpoint**: `PUT /api/simulation/{session_id}/update-pane-strike` with body `{right, strike}` must be called before `sim.updateSessionStrike` (frontend state). The endpoint calls `_ensure_options_data` to cache the new strike's parquet before updating `session.strike_ce` or `session.strike_pe`. The frontend calls it async after adding the pane so the pane renders immediately.
- **Dual-stream master-clock refactor**: `_run_session` iterates equity ticks as the master clock. CE and PE ticks are looked up by timestamp from `ce_by_time`/`pe_by_time` dicts (built via `_load_by_time`). On every equity tick, the loop checks if `session.strike_ce/pe` has changed since last tick and reloads the affected dict from that timestamp forward. This enables mid-session strike changes without restarting the session.
- **`liveFromTs` for mid-session panes**: When a pane is added mid-session, `PaneConfig.liveFromTs` is set to the latest equity tick's timestamp. `Chart.tsx` uses this as the `cutoffTs` for the options-historical filter (`floor(liveFromTs / intervalSecs) * intervalSecs`) so the pane shows all candles up to the current sim time, not just pre-session candles.
- **Mid-session ATM uses live equity price**: `addPane` in `App.tsx` computes ATM from `sim.currentPrice` (live equity LTP during session) with fallback to `optionsReady.underlyingPrice` (pre-session fetch). Do NOT use session-start ATM for mid-session panes — the underlying may have moved significantly.
- **SENSEX OTM strike interval in `addPane`**: The inline strike interval map in `addPane` must include `BSESEN: 100`. If omitted, `?? 50` fallback applies and CE/PE strikes are computed at the wrong interval (50 instead of 100).

## Phase-III Status

### Sprint 1 — User + Wallet ✅ COMPLETE (merged to dev, 128 tests passing)

All wallet mechanics are live. See `docs/spec-phase3.md` Sprint 1 section for full details.

### Sprint 2 — FundsRatio + Stoploss ✅ COMPLETE (merged to dev, 155 tests passing)

FundsRatio sizing and SL orders are live. See `docs/spec-phase3.md` Sprint 2 section for full details.

### Sprint 3 — Options Data Infrastructure (Backend) ✅ COMPLETE (merged to dev, 241 tests passing)

Options data fetch, expiry/strike calculation, options sessions, and naked short margin check are live. See `docs/spec-phase3.md` Sprint 3 section for full details.

### Sprint 4 — Layout + Options UI (Frontend) ✅ COMPLETE (merged to dev, 241 tests passing)

Multi-pane layout, dual-stream options replay, and lot-sized direct trades are live. Three post-merge fixes: wrong-strike tick routing (bug #9), OTM direction for mid-session addPane (bug #10), and full-stack direction-aware OTM strikes for initial session with per-right CE/PE streaming (bug #11). See Sprint 4 section in `docs/spec-phase3.md` for full details.

## Phase-IV Status

### Phase IV — BetaMinorUpdates ✅ COMPLETE (278 tests passing) — merged to dev; post-testing fixes in PR #15

All 9 UI-Upgrade features + Options-HistoricalData + TradeP&L shipped:
1. **Edit open orders** — click any open order row to edit its trigger/limit price inline
2. **Pick price from chart** — ⊕ button in edit row AND in placement form captures price from a chart click (active pane only); uses `'__new__'` sentinel for placement vs order-ID for edits
3. **Configurable TARGET deviation %** — Settings → "TARGET ORDER DEVIATION"; default 1%; stored in localStorage; passed as `target_deviation_pct` to backend on each order placement or update
4. **Trade markers on charts** — BUY (green ↑) and SELL (red ↓) arrow markers on the candlestick series of each relevant pane; markers carry text label `SIDE qty@price`
5. **Bar close countdown** — each chart toolbar shows `Bar close: M:SS`; turns orange in the last minute; toolbar has `paddingRight: 36` to avoid overlap with the pane ✕ button
6. **Day P&L** — header widget shows realized + unrealized P&L minus commission; updates on every tick
7. **Market tab (Mkt)** — Mkt/Tgt/Lmt/SL tabs in OrderPanel; Mkt uses L/M/H ratio for sizing, executes as LIMIT at `currentPrice × 1.01` (BUY) / `× 0.99` (SELL) for guaranteed fill; BUY/SELL buttons removed from TradePanel
8. **Position P&L + Session P&L** — TradePanel shows "Pos P&L" (unrealized) and "Session P&L" (realized + unrealized − commission) below LTP
9. **Trade history expand popup** — ⛶ icon beside "Trade History" opens a full modal with all columns (Time, Symbol, Side, Qty, Price, Right, Strike, Trade ID)
10. **Options Historical Data (2 days + trading date)** — `GET /api/data/options-historical` fetches `prior_trading_days(n=2) + [date]` (3 dates total); prior 2 days = context; trading date filtered by frontend to `time < startWindowTs` = pre-session candles
11. **Broker commission in P&L** — Settings → "BROKER COMMISSION"; default ₹10/trade; deducted from Session P&L and Day P&L header; stored in localStorage

**Backend**: `PATCH /api/orders/{id}`, `target_deviation_pct` on order schemas, options historical 3-date fetch.

**New symbol**: SENSEX (`BSESEN`) — BSE index, options only, BFO exchange, weekly Thursday expiry, lot size 20, strike interval 100.

### Phase IV Post-Merge Bugs Fixed

- **Bug #1 — Options pre-session candles missing**: When options-historical was updated to fetch prior 2 days using `prior_trading_days(n=2)`, the trading date itself was dropped, so CE/PE charts no longer showed 09:15–startTime candles. Fix: append `+ [date]` so the trading date is always included; frontend's existing `c.time < startWindowTs` filter handles clipping.
- **Bug #2 — Bar countdown overlaps ✕ button**: Bar-close countdown used `marginLeft: 'auto'` pushing it flush to the right edge, directly behind the absolute-positioned pane remove button. Fix: `paddingRight: 36` on the Chart toolbar div.
- **Bug #3 — Market order may not fill immediately**: Mkt tab was placing LIMIT at exact `currentPrice`. If price ticked up (BUY) or down (SELL) before the next evaluation, the order stayed open. Fix: place at `currentPrice × 1.01` (BUY) / `× 0.99` (SELL) — 1% deviation guarantees fill on the next tick.
- **Bug #4 — Chart price-pick fails on empty chart area**: `subscribeClick` checked `!param.time` (null when no candle under cursor) before the price-pick branch, causing early return. Fix: move `if (!param.time) return` to after the price-pick handler; price-pick only needs `param.point.y`.
- **Bug #5 — Trade history shows wrong time**: `toDate` in `TradeHistory.tsx` used `timeZone: 'Asia/Kolkata'`, adding +5:30 to IST-as-UTC timestamps and showing times 5.5 hours ahead of the chart. Fix: use `timeZone: 'UTC'` to read the wall-clock value directly.
- **Bug #6 — Cancel order shows 404 and stays in UI**: When replay runs fast, an order can fill on the backend before the `order_filled` SSE event reaches the frontend. If user clicks ✕ in that window, the backend returns 404 (order is FILLED, not PENDING) and `api.cancelOrder` throws, leaving the order stuck in the UI. Fix: treat HTTP 404 from DELETE as "already gone" — return `null` instead of throwing; `setState` still removes it from `openOrders`.
- **Bug #7 — Price pick only on edit row, not placement**: The ⊕ chart-pick button was only in the open-order edit row. Fix: added ⊕ next to the placement price input; uses sentinel `orderId = '__new__'` to route the injected price to the `price` state (not `editPrice`).

### Phase IV Minor Improvements

- **Edit order price step 0.5**: The price input in the open-order edit row now has `step={0.5}` so arrow keys increment/decrement by 0.5 instead of 1.

### Phase IV Post-Testing Bugs Fixed (PR #15)

- **Bug #8 — SENSEX replay missing 09:15 bar**: When `start_time` was 09:18, two separate `useEffect` hooks in `Chart.tsx` fired concurrently — `getHistorical` (slow for uncached BSE data) resolved after `getPreSession`, so `series.setData()` wiped the pre-session candle that `series.update()` had already placed. Fix: merged both into one sequential async IIFE so pre-session candles always load after historical `setData`.
- **Bug #9 — SENSEX OTM offset used wrong strike interval**: `addPane` in `App.tsx` used an inline interval map that was missing `BSESEN: 100`, causing the `?? 50` fallback to apply. CE/PE strikes were half the correct distance from ATM. Fix: add `BSESEN: 100` to the map.
- **Bug #10 — Mid-session pane addition showed no growing candle**: When removing a CE/PE pane and adding a new one with a different OTM value, the new pane showed only history (no live ticks). Three root causes: (1) ATM was computed from session-start price not live equity price; (2) backend dual-stream loop pre-loaded all ticks into a merged dict and could not change strikes mid-session; (3) options-historical cutoff only covered pre-session candles, leaving a gap between pre-session end and current sim time. Fix: refactored backend to equity-as-master-clock with per-tick CE/PE dict lookup and on-the-fly strike reload; added `liveFromTs` prop to Chart for the history cutoff; `addPane` now uses `sim.currentPrice` for ATM and calls `PUT /update-pane-strike` to update the session.

### Phase IV Post-Testing UX Changes (PR #15)

- **Brokerage renamed + formula-based**: Settings renamed from "BROKER COMMISSION" to "BROKERAGE"; default changed from ₹10 to ₹1. Commission is now computed backend-side per trade using Indian market charge formula (STT + exchange + GST) plus flat brokerage. `netDayPnl` uses `sum(t.commission)` from trade records instead of flat `commission × count`.
- **OTM control moved left of Start/Pause/Stop**: OTM input is always visible in the session controls row; disabled in equity mode. Removed separate second-row layout bar — layout/pane controls are injected inline via `SettingsModal.extraControls`.
- **Layout + Add Pane controls inlined**: The separate layout control bar row is removed. Layout preset selector and Add Pane controls appear inside the session controls row via the `extraControls` prop on `SessionControls`.

### Phase IV Lessons Learned

- **Options historical needs trading date + prior days**: Unlike equity (which has a separate `/api/data/pre-session` endpoint for the trading day), options historical must include the trading date itself to show pre-session candles. Pattern: `prior_trading_days(n=2) + [date]`.
- **Market orders via LIMIT + deviation**: Placing at exact current price risks not filling if price moves before the next tick. Use 1% above/below to guarantee fill. Still uses LIMIT type — no new backend order type needed.
- **Commission is frontend-only**: Broker commission is a display-only deduction (`commission × trades.length`) applied to `dayPnl` in App.tsx. The backend P&L calculations remain gross (no commission). This keeps backend/frontend concerns separated.
- **Absolute-positioned overlays need toolbar padding**: Any absolute-positioned element (like the ✕ pane-remove button) that sits over a flexbox toolbar needs `paddingRight` on the toolbar, not `marginRight` on the last item, because `marginLeft: 'auto'` makes the last item butt against the container edge.
- **`onPlaceOrder` type in OrderPanel**: The internal `OrderTypeFull` union (`TARGET | LIMIT | STOPLOSS | MARKET`) is broader than what the backend accepts. MARKET is converted to LIMIT internally before calling `onPlaceOrder`, so the prop type for `onPlaceOrder` stays as `TARGET | LIMIT | STOPLOSS`.
- **IST-as-UTC timestamp display**: Any frontend code formatting timestamps from the backend must use `timeZone: 'UTC'` in `toLocaleTimeString`. Using `'Asia/Kolkata'` incorrectly adds +5:30 to what are already IST wall-clock values.
- **Cancel 404 = SSE race, not a real error**: In fast replay, order fills and SSE delivery are async. Always treat 404 on a cancel request as "order is already gone" and remove from UI state. Propagating the error leaves the UI stale.
- **Chart click price-pick needs relaxed guard**: Lightweight Charts sets `param.time = undefined` when the user clicks in an empty area (no candle under cursor). Price-pick only needs the y-coordinate, so guard `!param.time` must come after the price-pick branch, not before it.
- **Shared pick flow via sentinel orderId**: To reuse the same chart price-pick infrastructure for both "edit open order" and "place new order", use a well-known sentinel string (`'__new__'`) as the orderId. A single `injectedEditPrice` state object routes to whichever consumer matches the orderId.
- **BSE vs NSE options exchange**: SENSEX options use `exchange_code="BFO"` (BSE Futures & Options), not `"NFO"`. Store `options_exchange_code` in `SUPPORTED_SYMBOLS` so the fetch function doesn't need symbol-specific if/else. Index equity data (for ATM price) uses `exchange_code="BSE"`.
- **`options_only` flag in config**: Indices (NIFTY, BSESEN) that cannot be traded directly need an `options_only: True` flag in `SUPPORTED_SYMBOLS`. Both backend (HTTP 400 on equity session start) and frontend (`OPTIONS_ONLY_SYMBOLS` set) enforce this. The flag prevents confusion from trying to fetch equity OHLC for an index and trade it directly.
- **React useEffect race for chart data**: Two separate async effects with overlapping data sources can fire concurrently, causing the slower one to overwrite data from the faster. For historical + pre-session data in Chart.tsx, use one sequential async IIFE so each phase only starts after the previous one completes.
- **Mid-session pane needs three coordinated changes**: Adding a live options pane mid-session requires: (1) backend session state updated for the new strike (`PUT /update-pane-strike`); (2) backend dual-stream loop can react to the strike change per-tick; (3) frontend historical filter uses `liveFromTs` as cutoff so the full history up to current sim time is shown. Missing any one of these produces either no history or no live ticks.
- **Brokerage as session-level config**: Storing `brokerage_per_order` on the session (not globally) means each session uses the rate the user had at session start. This avoids mid-session setting changes affecting open sessions. Pass it in `POST /api/simulation/start` and snapshot it into `SimulationSession`.
- **Backend commission vs frontend display**: Commission calculation was moved to the backend so trade analysis in Phase V can use accurate per-trade commission data. Frontend now reads `t.commission` from trade records. If future analysis features need commission, it is already in DynamoDB per trade.

**Next: Phase V TradeAnalysis** (see `docs/spec-phase5.md`)
