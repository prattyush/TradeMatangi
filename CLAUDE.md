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
- **ICICI Direct symbol codes**: The canonical symbol keys in `SUPPORTED_SYMBOLS` match ICICI Direct / Breeze API codes exactly: `NIFTY`, `TATPOW`, `TATMOT`, `RELIND`. Do not use NSE display names (TATAPOWER, TATAMOTORS, RELIANCE) as symbol keys.
- **Breeze API record limit**: `get_historical_data_v2(interval="1second")` silently truncates to ~1000 records per call (~16 min). A full trading day (22 500 rows) requires pagination. Use `broker_service._fetch_day_paginated` which splits the day into 15-min chunks. Never make a single full-day call for 1-second data.
- **Lightweight Charts — no teardown for layout changes**: calling `chart.remove()` discards all series data. Height/width changes must go through `chart.applyOptions(...)`. The chart init `useEffect` must use `[]` deps (mount only); a separate `useEffect([height])` calls `applyOptions` for height changes.
- **Options cache path**: options parquet files are stored as `data/ohlcdata/{SYMBOL}-{CE|PE}-{STRIKE}-{EXPIRY}-{DD-MM-YYYY}.parquet`. Equity files remain `data/ohlcdata/{SYMBOL}-{DD-MM-YYYY}.parquet`.
- **Options lot sizes (hardcoded, current)**: NIFTY=65, RELIND=250, TATMOT=1400, TATPOW=2700. No historical lot size tracking — always use current values.
- **NSE options expiry**: date-aware helper required. From 2025-09-01: weekly and monthly expiry on Tuesday (Monday if holiday). Before 2025-09-01: Thursday (Wednesday if holiday). Monthly = last occurrence of that weekday in the month.
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
- **Market tab routes as LIMIT**: The Mkt tab in `OrderPanel.tsx` places a LIMIT order at `currentPrice` with `funds_ratio_pct`. `OrderTypeFull` includes `'MARKET'` as a UI-only state; it is always converted to `'LIMIT'` before calling `onPlaceOrder`. The backend never sees `order_type='MARKET'`.
- **Commission is frontend-only**: `commissionPerTrade` (localStorage key `commissionPerTrade`, default ₹10) is loaded in `App.tsx` via `loadCommissionPerTrade()`. `netDayPnl = sim.dayPnl - commission × trades.length`. Backend P&L remains gross. Session P&L in TradePanel uses `netDayPnl`.
- **Chart toolbar paddingRight for remove button**: The pane remove `✕` button in `App.tsx` is `position: absolute, top: 8, right: 8`. Chart.tsx toolbar must have `paddingRight: 36` so the bar-close countdown (which uses `marginLeft: 'auto'`) does not render under the button.

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

### Phase IV — BetaMinorUpdates ✅ COMPLETE (271 tests passing) — PR #14 open, in user testing

All 9 UI-Upgrade features + Options-HistoricalData + TradeP&L shipped:
1. **Edit open orders** — click any open order row to edit its trigger/limit price inline
2. **Pick price from chart** — ⊕ button in edit row captures price from a chart click (active pane only)
3. **Configurable TARGET deviation %** — Settings → "TARGET ORDER DEVIATION"; default 1%; stored in localStorage; passed as `target_deviation_pct` to backend on each order placement or update
4. **Trade markers on charts** — BUY (green ↑) and SELL (red ↓) arrow markers on the candlestick series of each relevant pane; markers carry text label `SIDE qty@price`
5. **Bar close countdown** — each chart toolbar shows `Bar close: M:SS`; turns orange in the last minute; toolbar has `paddingRight: 36` to avoid overlap with the pane ✕ button
6. **Day P&L** — header widget shows realized + unrealized P&L minus commission; updates on every tick
7. **Market tab (Mkt)** — Mkt/Tgt/Lmt/SL tabs in OrderPanel; Mkt always uses L/M/H ratio for sizing, executes as LIMIT at current price; BUY/SELL buttons removed from TradePanel
8. **Position P&L + Session P&L** — TradePanel shows "Pos P&L" (unrealized) and "Session P&L" (realized + unrealized − commission) below LTP
9. **Trade history expand popup** — ⛶ icon beside "Trade History" opens a full modal with all columns (Time, Symbol, Side, Qty, Price, Right, Strike, Trade ID)
10. **Options Historical Data (2 days + trading date)** — `GET /api/data/options-historical` fetches `prior_trading_days(n=2) + [date]` (3 dates total); prior 2 days = context; trading date filtered by frontend to `time < startWindowTs` = pre-session candles
11. **Broker commission in P&L** — Settings → "BROKER COMMISSION"; default ₹10/trade; deducted from Session P&L and Day P&L header; stored in localStorage

**Backend**: `PATCH /api/orders/{id}`, `target_deviation_pct` on order schemas, options historical 3-date fetch.

### Phase IV Post-Merge Bugs Fixed

- **Bug #1 — Options pre-session candles missing**: When options-historical was updated to fetch prior 2 days using `prior_trading_days(n=2)`, the trading date itself was dropped, so CE/PE charts no longer showed 09:15–startTime candles. Fix: append `+ [date]` so the trading date is always included; frontend's existing `c.time < startWindowTs` filter handles clipping.
- **Bug #2 — Bar countdown overlaps ✕ button**: Bar-close countdown used `marginLeft: 'auto'` pushing it flush to the right edge, directly behind the absolute-positioned pane remove button. Fix: `paddingRight: 36` on the Chart toolbar div.

### Phase IV Lessons Learned

- **Options historical needs trading date + prior days**: Unlike equity (which has a separate `/api/data/pre-session` endpoint for the trading day), options historical must include the trading date itself to show pre-session candles. Pattern: `prior_trading_days(n=2) + [date]`.
- **Market orders via LIMIT**: The simplest "market order" in simulation is a LIMIT order at the current price. LIMIT BUY fills when `price <= limit` — placing at current price fills on the next tick. No new order type or backend endpoint needed.
- **Commission is frontend-only**: Broker commission is a display-only deduction (`commission × trades.length`) applied to `dayPnl` in App.tsx. The backend P&L calculations remain gross (no commission). This keeps backend/frontend concerns separated.
- **Absolute-positioned overlays need toolbar padding**: Any absolute-positioned element (like the ✕ pane-remove button) that sits over a flexbox toolbar needs `paddingRight` on the toolbar, not `marginRight` on the last item, because `marginLeft: 'auto'` makes the last item butt against the container edge.
- **`onPlaceOrder` type in OrderPanel**: The internal `OrderTypeFull` union (`TARGET | LIMIT | STOPLOSS | MARKET`) is broader than what the backend accepts. MARKET is converted to LIMIT internally before calling `onPlaceOrder`, so the prop type for `onPlaceOrder` stays as `TARGET | LIMIT | STOPLOSS`.

**Next: Phase V Strategies** (see `docs/spec-phase5.md`)
