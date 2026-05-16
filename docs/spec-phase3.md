
#### Phase-III BetaStage
This phase should support options and futures. We only need to support options and futures for stocks and indexes. No need to support commodity or currency at this phase.

##### Wallet
1. Wallet should be supported for simulated trading. It will be prefilled with a default amount of 150000 rupees for now.
2. Every placed order, including limit and target orders which are just hanging and not placed yet, in run-time should reflect in the wallet. However, stoploss orders should be excluded. Please refer to the feature requirement below of Stoploss.
3. Every P&L should reflect in the wallet.
4. If at run-time the wallet goes negative then the orders should throw UI error and fail.
5. The wallet should be incremented and decremented with each days trades P&L and should carry forward. In Simulated environemnt where a user can replay 5th May 2026, incur a loss and then trade again at 4th May 2026, in that case the wallet should not include the loss of 5th May 2026.
6. There should be a settings option may be at top corner clicking on that we would have a popup screen, or any other way. I will leave the choice to you. The only requirement is to have a settings option where the wallet can be reset to default value of 150000 rupees or any amount. 
7. The wallet is per user.


##### User
1. Support of user should be added in the backend. For now use a hardcoded user with username abc123 and password abc123. No need for any sign in for now. Create a unique id for this user and use that id in all data persisted in the dynamo db w.r.t to trades, wallet have the userid in it to specify uniqueness. As going forward we would support multiple users thus fetching data per user, that is trades data and also wallet status.
2. You can use any mechanism to store the user in the browser, refreshing browser should not lose the user information. It may be harded for now as we have only 1 user, going forwward JWT Tokens can be used to persist user information.

##### FundsRatio    
1. This feature requires to shift from lots or quantity to funds ratio. The funds or capital available are defined as the money in the wallet when the trading session started. So, that fluctuations in the wallet during trading doesn't effect the percentage of capital at risk. 
2. We will have 3 different ratios configured. That is how much money to spend on this buy or sell which will a fixed ratio of the funds/capital available. The 3 ratios will be defined by "l, m and h". These signify the probabilities of success for that trade, l is low so by default only 3% of capital, m is medium probability so 6% of funds and h is high probability so 12% of funds.
3. The settings menu will have option to override these default % values for l, m and h for a specific user. 
4. When taking a trade if the funds % is lower than the money required to take the trade then it would default to 1 lot if the current wallet balance can afford it. Lets say 3% of 10,000 is 300 for buying an option at price 30 for lot size of 65 > 300, in that case just buy 1 lot that is 65. If the current wallet balance cannot afford even 1 lot, the order is blocked and a UI error is shown.
5. When the options of target and limit are selected, then again the quantity won't be present instead it would be the funds ratios l, m or h. Basically every new order will have l, m and h as parameters to select. However, when selecting stoploss the option would be actual quantity, and pre-selected would be the current open position quantity. More details in the stoploss feature info.
6. In Settings menu whether to have the fundsratio or the quantity will be an option. If fundsratio is selected then quantity won't be present in either equity or future or options trading. If fundsratio is not selected or quantity is selected, then fundsratios are not available.

##### Layout
1. This feature will be placed on top enabling layout of the panes, layout would be separate by counts, 3 panes or 2 or 1 or 4. I will leave choice to you whether the number 3 means maximum panes 3 or all the time 3. For example, initially we have only 1 pane covering all window. Then I click on add pane and choose layout of 2 in which 2 panes are vertically stacked. Next I click on Add Pane again and now choose layout of 3 in which 1 pane covers the entire width of window and 2 panes cover half the width and are parallel to each other, or the 2 extra panes also cover entire width and all panes are in vertical stack. Then the new pane should be added as mentioned either below or parallel. 
2. For equity trading, the panes for only that symbol can be added.
3. For options trading panes or charts can be added which can be either Call or Put with different strike prices but for that same symbol for which the replay is started.

##### OptionsTrading
1. User can choose whether to trade in symbol or options. Symbol Trading should not be allowed for NIFTY 50 of indices.
2. When option trading is selected, the panes which are to be added can be either the symbol different time intervals or Call or Put Charts for strike prices.
3. In option trading mode, user can chooose which option to buy/sell Put or Call. If an option is sold without any open buy position, then used the respective margin for sell and if wallet doesn't have that much money left, throw an error. For Sell options use the margin = 20% of (price of the symbol*lot size), for example for sell nifty50 with lot size 65. Use nifty50 current value lets say 23900, then use (23900*65)*(20/100) as total value. Lot sizes are always the current lot sizes — no historical lot size tracking. The supported current lot sizes are: NIFTY=75, RELIND=250, TATMOT=1400, TATPOW=2700. These are hardcoded and can be updated manually if SEBI revises them.
4. When options trading is selected, the default layout would be 3 with 1 horizontal covering full width and 2 below that covering half width and 50% height, basically, 2 panes horizontally and 1 on top of both of them. User can later delete or add panes. The top pane will show the symbol and the below panes will show Call And Put options for the respective symbol. The expiry would be next expiry would be weekly for index symbols like NIFTY50 and monthly for equity symbols like tata power or tata motor. The user would be free to delete a pane and add another pane with different strike price, or only have 2 PUTS with different time intervals etc.  Expiry day is date-dependent: from 2025-09-01 onwards, weekly contracts expire on Tuesdays (or Monday if Tuesday is a market holiday) and monthly contracts expire on the last Tuesday of the month (or Monday if that Tuesday is a holiday). Before 2025-09-01, weekly contracts expired on Thursdays (or Wednesday if Thursday was a holiday) and monthly contracts expired on the last Thursday of the month.
5. To choose strike price automatically, the UI provides one input: how many strikes above or below the symbol's current price (e.g. +2 = 2 strikes OTM, -2 = 2 strikes ITM). ATM strike is computed as round(underlying_price / strike_interval) * strike_interval where strike_interval is 50 for NIFTY and 5 for equity symbols. The offset is then applied. For choosing the symbol current price, use a dedicated lightweight price-lookup: for simulated trading the backend exposes GET /api/data/price-at?symbol=NIFTY&date=YYYY-MM-DD&time=HH:MM which reads the first available price from the cached parquet file at or after the given time (fetching from Breeze if not cached); This call is made when the user opens the options pane configurator, before clicking Start Replay, so that strike options are resolved and shown in the UI immediately. User while adding new panes can choose a different strike price. The "price range" strike selection method (e.g. find a strike priced between 24–36) is deferred to Phase 4, where it will be implemented using a short single-point Breeze fetch per candidate strike for simulated trading and the live options chain for paper trading.
6. For buying and selling, user has to choose the symbol Put or Call and if multiple strike prices are displayed then strike price, or better option would be for user to click on one chart highlight it and then click on Buy or Sell. Requirement is to have only UI pane of buy sell buttons and using that either Call or Put can be bought. Choose however, you want to handle that in UI no opinions.


##### Stoploss
1. Add one more tab in addition to Target and Limit, this tab will be SL for stoploss. The tab will be enabled only when an trade is running that is either a buy or a sell position is open. Based on the buy or sell position, when stoploss tab is selected, the opposite side i.e if already buy is open, sell would be selected and buy would be disabled and the quantity would be equal to the open position size of the current trade. But the quantity can be changed if required. The quantity field in this case would be shown whether user selected funds ratio or not, as for Stoploss it has to be quantity.
2. The user can change the quantity but cannot increase more than the open quantity.
3. Stoploss order added should not effect the wallet. However, one edge case is there, if the user didn't add stoploss order but added a target sell order which is in fact a stop limit order, should the wallet be substracted. I think it is ok to move with simple implementation now which can be complicated in future if required.


---

## Phase-III Sprint Plan

### Sprint 1 — User + Wallet ✅ COMPLETE (merged to dev)

**Goal:** Foundational user identity and wallet persistence. All other Phase-III features depend on these.

**What shipped:**
- `Users` DynamoDB table; `abc123` / UUID `abc12300-0000-0000-0000-000000000001` seeded via FastAPI lifespan hook on startup
- Renamed `PLACEHOLDER_USER_ID` → `FIXED_USER_ID` (new value) in `config.py`; updated all three services
- `Wallet` DynamoDB table (PK: `user_id` HASH, SK: `date` RANGE YYYY-MM-DD)
- `wallet_service.py`: in-memory `_wallets` dict, carry-forward via DynamoDB `query` with `Key("date").lt(target_date) + ScanIndexForward=False + Limit=1`, default ₹1,50,000 on no prior record
- `GET /api/wallet?date=YYYY-MM-DD`, `POST /api/wallet/reset?date=YYYY-MM-DD`
- Wallet debit on BUY order placement (`qty × actual_limit`), credit on BUY cancel, credit on SELL fill
- Wallet debit on direct BUY trade (TradePanel button), credit on direct SELL trade
- `POST /api/simulation/start` returns `session_capital` (wallet balance snapshotted at session start)
- Frontend: localStorage user init, `WalletWidget` in header (auto-refreshes via `walletRefreshKey` counter), `SettingsModal` (gear icon), red error banner on 402 insufficient-funds
- 128 backend tests passing, TypeScript clean

**Key implementation decisions:**
- Wallet in-memory dict is process-local source of truth; DynamoDB is persistence. Writes swallow failures same as all other DB writes.
- `reserved_amount` field added to `Order` model to store the debited amount at placement time (used for cancel credit without recomputing).
- Direct TradePanel buy/sell debits/credits `price × 1` (qty is always 1 for direct trades). Same 402 path as order panel.
- `InsufficientFundsError` raised in service, caught in routers, returned as HTTP 402.

**Bugs found and fixed during Sprint 1:**
- `setup-dynamodb-tables.py`: `list_tables()["TableNames"]` returns `list[str]` not `list[dict]` — was using `t["TableName"]` inside a set comprehension, causing `TypeError`. Fixed to `set(dynamodb.list_tables()["TableNames"])`.
- Direct TradePanel buy/sell did not touch wallet — wired up in `routers/trading.py` after initial PR.

---

### Sprint 2 — FundsRatio + Stoploss ✅ COMPLETE (merged to dev, 155 tests passing)

**Goal:** Replace quantity with capital-ratio sizing and add the SL tab to the order panel.

**What shipped:**
- `LOT_SIZES` dict in `config.py` (NIFTY=75, RELIND=250, TATMOT=1400, TATPOW=2700); `DEFAULT_FUNDS_RATIOS` (l=3.0, m=6.0, h=12.0)
- `OrderType.STOPLOSS` added to enum; `is_stoploss: bool = False` field on `Order` model
- `PlaceOrderRequest.quantity` changed from `int = 1` to `int | None = None`; `funds_ratio_pct: float | None` added
- `compute_funds_ratio_quantity(symbol, price, session_capital, funds_ratio_pct, current_wallet, lot_size=1)` in `order_service.py`: `floor(spend / price)` for equity, `floor(spend / (price × lot_size))` for options; 1-unit/lot fallback; `InsufficientFundsError` when wallet can't afford even 1
- STOPLOSS order placement: no wallet debit regardless of side; `limit_price = trigger_price` (no 1% deviation unlike TARGET)
- STOPLOSS fill: same trigger logic as TARGET (BUY fires when `price >= trigger`; SELL fires when `price <= trigger`); no wallet credit on fill; no wallet credit on cancel
- `routers/orders.py`: resolves quantity from `session_capital × funds_ratio_pct` when `funds_ratio_pct` is provided; passes `lot_size=1` for all Sprint 2 equity trades
- Frontend: `SettingsModal` — Trading Mode toggle (Quantity ↔ FundsRatio) + L/M/H % inputs (default 3/6/12), persisted to localStorage keys `fundsRatioMode` and `fundsRatios`; exports `loadFundsRatioMode` / `loadFundsRatios` helpers for `App.tsx` init
- Frontend: `OrderPanel` — SL tab enabled only when `position.side !== 'FLAT'`; SL side auto-locked to opposite of position; SL qty pre-filled from position size, capped at position size; L/M/H buttons replace quantity picker in FundsRatio mode; SL orders rendered with orange accent in open orders list
- `useSimulation.placeOrder` signature extended with `opts: { is_stoploss?, funds_ratio_pct? }`
- `App.tsx` lifts `fundsRatioMode` / `fundsRatios` state; passes both to `OrderPanel` and `SettingsModal`
- 155 backend tests passing (27 new), TypeScript clean

**Key implementation decisions:**
- `compute_funds_ratio_quantity` takes explicit `lot_size` parameter (not auto-derived from `LOT_SIZES`) — the router controls equity vs options behaviour. Sprint 2 router always passes `lot_size=1`; Sprint 3 options router will pass the symbol's actual lot size.
- STOPLOSS has **zero wallet impact** at all lifecycle stages (placement, fill, cancel). The spec explicitly called for a simple implementation; accurate P&L tracking for SL exits is deferred.
- FundsRatio percentages live entirely in the frontend (localStorage). The backend only sees a `funds_ratio_pct` float (0–1); it has no awareness of the L/M/H label or user preferences storage. This keeps the backend stateless with respect to user UI preferences.
- STOPLOSS trigger logic reuses the same `check_orders` branch as TARGET — only the wallet and `limit_price` (= trigger, no deviation) differ.

**Bugs found and fixed during Sprint 2:**
- `InsufficientFundsError.__init__(balance, required)` takes two positional floats, not a string. Initial implementation was calling `InsufficientFundsError("message")` — fixed to `InsufficientFundsError(current_wallet, unit_cost)`.
- `LOT_SIZES` contains equity symbols (TATPOW=2700, TATMOT=1400, RELIND=250) because they have options/futures. `compute_funds_ratio_quantity` initially derived `lot_size = LOT_SIZES.get(symbol, 1)`, causing equity TATPOW trades to use lot_size=2700. Fixed by making `lot_size` an explicit parameter defaulting to 1.

---

### Sprint 3 — Options Data Infrastructure (Backend) ✅ COMPLETE (merged to dev, 241 tests passing)

**Goal:** Options OHLC fetch, caching, and streaming working end-to-end before any options UI is built. Highest-risk sprint.

**What shipped:**
- `backend/app/services/options_service.py` — new module containing all options infrastructure:
  - `NSE_HOLIDAYS: frozenset[datetime.date]` — 2025–2026 NSE market holidays hardcoded
  - `_is_trading_day / _prev_trading_day` — holiday-aware trading day utilities
  - `_expiry_weekday(date)` → 1 (Tuesday) from 2025-09-01, 3 (Thursday) before; `_CUTOFF_DATE = datetime.date(2025, 9, 1)`
  - `get_weekly_expiry(date_str)` — next weekly expiry at or after given date; holiday shifts to previous trading day
  - `get_monthly_expiry(date_str)` — last expiry weekday of the month; holiday shifts to previous trading day
  - `get_expiry_date(symbol, date_str)` — dispatches to weekly (NIFTY) or monthly (equities); auto-rolls to next month if current month's expiry has passed
  - `STRIKE_INTERVALS` dict: NIFTY=50, RELIND/TATMOT/TATPOW=5
  - `get_atm_strike(symbol, price, offset=0)` — `round(price / interval) * interval`; OTM/ITM offset in interval steps
  - `options_parquet_path(symbol, date, strike, expiry, right)` → `data/ohlcdata/{SYM}-{CE|PE}-{STRIKE}-{ED}-{EM}-{EY}-{DD}-{MM}-{YYYY}.parquet`
  - `_breeze_expiry_format(expiry)` → `"YYYY-MM-DDTHH:MM:SS.000Z"` (Breeze API ISO format)
  - `_fetch_options_day_paginated(breeze, symbol, date, strike, expiry, right)` — 15-min chunk pagination for NFO options; passes `exchange_code="NFO"`, `product_type="options"`, `right="call"|"put"`, `strike_price=str(strike)`, `expiry_date=<ISO>`
  - `_validate_options_gaps(df, date)` — lenient fill (bfill leading gap + ffill trailing); NO strict gap limit unlike equity
  - `fetch_options_historical(symbol, date, strike, expiry, right)` — cache-first; fetches from Breeze on miss; atomic write via `.tmp` rename
  - `load_options_dataframe(symbol, date, strike, expiry, right)` — reads parquet; applies same `tz_localize("UTC")` IST-as-UTC trick as equity
  - `options_iter_ticks(symbol, date, strike, expiry, right, start_time)` — same tick dict format as equity `iter_ticks`
  - `compute_short_margin(symbol, underlying_price)` — `underlying_price × lot_size × 0.20`
  - `get_underlying_price_at(symbol, date, unix_ts)` — reads equity parquet at given tick time for margin calc; returns None on failure (swallowed)
- `GET /api/data/price-at?symbol&date&time` — returns `{symbol, date, time, price}` (first close at/after given time)
- `GET /api/data/expiry?symbol&date` — returns `{symbol, date, expiry}` using `get_expiry_date`
- `models/schemas.py`: added `PriceAtResponse`, `ExpiryResponse`; `Trade` gains optional `instrument_type / strike / expiry / right`; `SimulationStartRequest/Response` gain `instrument_type / strike / expiry / right`
- `services/simulation.py`: `SimulationSession` dataclass gains `instrument_type / strike / expiry / right`; `create_session()` accepts these params; `_run_session` dispatches to `options_iter_ticks` when `instrument_type == "options"`; `_upsert_session_to_db` includes options fields; `record_trade` call passes session options metadata
- `routers/simulation.py`: `_ensure_options_data()` helper; `start_simulation` validates `instrument_type`, validates `right ∈ {CE, PE}`, calls both `_ensure_session_data` (equity) and `_ensure_options_data` for options sessions
- `routers/orders.py`: naked short margin check for options SELL orders (not SL/covered); `lot_size` passed from `LOT_SIZES` for options sessions vs 1 for equity
- `services/trading.py`: `record_trade()` and `_write_trade_to_db()` accept and persist options metadata
- 86 new tests (68 unit + 18 API); 241 total passing, TypeScript clean

**Key implementation decisions:**
- Options gap-fill is lenient (bfill + ffill, no gap limit) because far-OTM contracts legitimately have no data from 09:15. Equity validation remains strict (15-min gap limit). The bfill behavior means pre-trade simulation candles show the first available options price for any empty leading period — acceptable approximation for ATM options.
- `_get_breeze` and `_breeze_to_dataframe` are re-used from `broker_service` (imported inside `fetch_options_historical`) to avoid duplicating Breeze connection logic. Patch target in tests: `app.services.broker_service._get_breeze`, NOT `app.services.options_service._get_breeze`.
- Underlying price for margin check is read from the equity parquet at the current tick's Unix timestamp (not stored in session state). Equity data is always cached before an options session starts (the router calls `_ensure_session_data` for equity + `_ensure_options_data` for options). Falls back to `session.last_price` if equity read fails.
- Naked short check fires only when `instrument_type == "options"`, `side == SELL`, not a STOPLOSS order, and position is not LONG. Covered sells (LONG position exists) bypass margin check entirely.
- Breeze `expiry_date` format: `"YYYY-MM-DDTHH:MM:SS.000Z"` with fixed `T06:00:00.000Z` suffix. This matches what the Breeze API expects for NFO options lookups.
- Options session also requires equity data to be cached (margin check + historical chart in Sprint 4). The simulation router fetches both on `POST /api/simulation/start`.
- `options_iter_ticks` uses the same `tz_localize("UTC")` + `ts.timestamp()` path as equity — the frontend's Lightweight Charts timestamp math is identical for both.
- `get_expiry_date` for equities checks `monthly < trading_date` and rolls to next month. This handles the edge case where a user replays a date after the monthly expiry has already passed (e.g., replaying May 30 when last Thursday of May was May 29).

**Bugs found and fixed during Sprint 3:**
- `fetch_options_historical` imports `_get_breeze` from `broker_service` at call time (lazy import). Tests patching `app.services.options_service._get_breeze` failed with `AttributeError`. Fixed by patching `app.services.broker_service._get_breeze` instead.
- `SimulationSession` uses `asyncio.Queue` and `asyncio.Event` as dataclass fields. The options session start test created a real `SimulationSession` and the async `_run_session` task was spawned with no data file — `FileNotFoundError` logged as "Task exception was never retrieved". Fixed by patching `_upsert_session_to_db` and `wallet_service.get_balance` directly (no `wallet_service` module-level import in `simulation.py` — it's a lazy import inside `create_session`).

**New technical constraints added to CLAUDE.md:**
- Options cache path: `data/ohlcdata/{SYMBOL}-{CE|PE}-{STRIKE}-{EXPIRY}-{DD-MM-YYYY}.parquet`
- Options lot sizes: hardcoded, current values only (NIFTY=75, RELIND=250, TATMOT=1400, TATPOW=2700)
- NSE options expiry: date-aware helper in `options_service.py`; cutoff 2025-09-01 (Tuesday vs Thursday)
- Breeze expiry ISO format: `"YYYY-MM-DDTHH:MM:SS.000Z"` with fixed `T06:00:00.000Z`
- Naked short margin: `underlying_price × lot_size × 0.20`; underlying read from equity parquet, not options price

---

### Sprint 4 — Layout + Options UI (Frontend) ✅ COMPLETE (merged to dev, 241 tests passing)

**Goal:** Multi-pane layout system and full options trading UI on top of the Sprint 3 backend.

**What shipped:**

**Backend (simulation dual-stream):**
- `SimulationSession` gains `last_price_ce` and `last_price_pe` fields; `queue` maxsize increased 500 → 3000
- `_run_session` for options sessions merges equity + CE + PE ticks by timestamp into `time_to_ticks` dict, emits all three per timestamp in a single `asyncio.sleep(speed)` interval
- `_emit_tick_and_check_orders` extracted as helper: wraps `queue.put_nowait` in try/except `asyncio.QueueFull` (drops tick with warning instead of crashing); routes `check_orders` with correct `tick_right`
- `routers/trading.py` direct BUY/SELL now computes `lot_size = LOT_SIZES.get(symbol, 1)` for options sessions; debits/credits `price × lot_size` and passes `quantity=lot_size` to `record_trade`
- `config.py` NIFTY lot size corrected 75 → 65

**Backend (data loading):**
- `data_loader.load_dataframe` and `options_service.load_options_dataframe` both guard against already-tz-aware DataFrames: if `df.index.tzinfo is not None` use `tz_convert("UTC")` instead of `tz_localize("UTC")`
- `options_service._validate_options_gaps` strips tz before building `pd.date_range` + `reindex` (tz-naive `market_open`/`market_close` timestamps would fail to align with tz-aware index)

**Frontend:**
- Layout control bar: dropdown for 1/2/3/4 pane presets with `+` / `×` pane add/remove buttons
- Options session default layout: 3 panes (equity top full-width, CE and PE half-width below)
- Each pane header shows symbol + interval (equity) or symbol + strike + expiry + CE/PE (options)
- OTM offset input inline with pane add; calls `GET /api/data/price-at` before session start to resolve ATM strike
- Active pane highlighting: click to select; `TradePanel` BUY/SELL targets the active pane's right (CE/PE) or equity
- `useSimulation` gains three separate per-type tick fields: `latestEquityTick`, `latestCETick`, `latestPETick`; `setLatestTick` dispatches by `tick.right` into the correct field using a single functional `setState` to avoid React batching overwrite
- `App.tsx` `getTickForPane` routes ticks to charts by pane type + right; pane wrapper has `minWidth: 0` to allow flex shrink after canvas has explicit pixel width
- `Chart.tsx` options historical effect filters full-day candles to pre-session window before `setData` to avoid "Cannot update oldest data" from Lightweight Charts
- All three async effects in `Chart.tsx` use cancellation flag (`let cancelled = false`) to prevent `Object is disposed` when pane is unmounted before the fetch resolves
- Live tick handler wrapped in try/catch to swallow rare Lightweight Charts errors without crashing the pane

**Key implementation decisions:**
- Dual-stream merges by timestamp server-side: the backend builds `time_to_ticks[ts] = [eq_tick, ce_tick, pe_tick]` so all three ticks for a given second are emitted together before the next `asyncio.sleep`. This keeps CE/PE prices synchronized in the frontend.
- React state batching is a silent killer for multi-field updates in the same callback chain: three consecutive `setLatestTick` calls in one SSE `onmessage` burst → only the last setState wins. Fixed by routing dispatch inside a single `setState(s => ...)` with per-field keys, not by calling `setState` three times.
- Lightweight Charts timestamp rule: `series.setData()` establishes a minimum timestamp; any subsequent `series.update()` with an equal or earlier timestamp throws "Cannot update oldest data". Filtering pre-session historical data to `time < startWindowTs` prevents this.
- `chart.remove()` disposes the chart object; any async `.then()` that runs after dispose throws "Object is disposed". The cancellation flag pattern (`let cancelled = false; return () => { cancelled = true }`) guards all three Chart `useEffect` async paths.
- Flexbox `min-width: auto` on pane wrappers: Lightweight Charts writes an explicit pixel `width` attribute on the canvas. When a pane is removed, the remaining pane's flex container wants to shrink but the canvas `min-width: auto` prevents it. Fixed with `minWidth: 0` on the pane wrapper div.

**Bugs found and fixed during Sprint 4:**
1. `KeyError: 'right'` in `_run_session` dual-stream loop — equity ticks have no `"right"` key; `tick["right"]` raised `KeyError`. Fixed: `tick.get("right")`.
2. `asyncio.queues.QueueFull` crash — `queue.put_nowait` not guarded when queue backed up under high replay speeds. Fixed: try/except + queue size 500 → 3000.
3. `Cannot update oldest data` in options chart — full-day historical candles loaded before session start; live tick at start time was ≤ last loaded candle. Fixed: filter to `time < startWindowTs`.
4. `Object is disposed` — async fetch `.then()` callback fired after pane unmount. Fixed: cancellation flag in all three Chart `useEffect` effects.
5. Only PE chart updating — React batched three `setLatestTick(setState)` calls in one event loop tick; last write (PE) won. Fixed: single `setState(s => ...)` with conditional per-field keys.
6. Newly added pane renders at minimal width — canvas `min-width: auto` prevented flex shrink. Fixed: `minWidth: 0` on pane wrapper.
7. NIFTY lot size wrong — `config.py` had `"NIFTY": 75`; correct value is 65. Fixed.
8. Direct TradePanel BUY/SELL ignored lot size — `routers/trading.py` debited `price × 1` and recorded `quantity=1` for options sessions. Fixed: compute `lot_size` from `LOT_SIZES` and use throughout.
9. Wrong-strike live ticks routed to differently-struck options pane — `getTickForPane` routed by `right` only; a pane at a different offset received the session-strike prices. Initially fixed with a single `sessionStrike` guard. Superseded by bug #11.
10. OTM offset applied identically to CE and PE for mid-session `addPane` — OTM=3 gave PE `ATM + 3 × interval` (ITM for PE) instead of `ATM − 3 × interval`. Fixed: `directedOffset = addPaneType === 'PE' ? -addOffset : addOffset`. UI label renamed "Offset" → "OTM".
11. OTM direction not applied to initial session panes, and CE/PE could only share one backend strike — Full-stack fix: `SessionControls` computes `ceStrike = ATM + N × interval`, `peStrike = ATM − N × interval` and sends both as `strike_ce`/`strike_pe` in the start request. Backend `SimulationSession` stores `strike_ce`/`strike_pe`; `_run_session` dual-stream loads CE data from `strike_ce` and PE data from `strike_pe` independently. `routers/simulation.py` caches options parquet for each right at its own strike. `routers/trading.py` helper `_strike_for_right()` records trades at the correct per-right strike. Frontend `useSimulation` stores `sessionStrikeCE`/`sessionStrikePE`; `getTickForPane` checks each right against its own session strike. Backward compat: `strike_ce`/`strike_pe` default to `strike` when omitted (offset=0 ATM sessions unchanged).

**New technical constraints added to CLAUDE.md:**
- `lot_size` for direct trades: `LOT_SIZES.get(symbol, 1)` when `instrument_type == "options"`, else 1
- NIFTY lot size is 65 (corrected from 75)
- `tz_localize` guard: check `df.index.tzinfo` before applying; use `tz_convert` if already tz-aware
- Options gap-fill strips tz before `pd.date_range` reindex
- React state batching: multiple `setState` calls in one burst → last wins; use single functional update with per-field keys
- Cancellation flag required for all async effects on chart components
- Pane wrapper needs `minWidth: 0` for correct flex behaviour alongside explicit-width canvas
- Options tick routing uses per-right session strike: `getTickForPane` checks CE panes against `sessionStrikeCE`, PE panes against `sessionStrikePE`; panes with a non-matching strike show history only
- OTM offset is direction-aware: CE = `ATM + N × interval`, PE = `ATM − N × interval`; applies both to initial session panes and mid-session `addPane`
- `SimulationSession` carries `strike_ce` and `strike_pe` (default to `strike`); `_run_session` dual-stream uses each for its respective right; trades record per-right strike via `_strike_for_right()`


---

## Phase III Implementation Status

### Sprint 1 — User + Wallet ✅ COMPLETE (128 tests passing, merged to dev)
All wallet mechanics live. Carry-forward keyed by `(user_id, date)`. DynamoDB lazy-import pattern for fault-tolerant persistence.

### Sprint 2 — FundsRatio + Stoploss ✅ COMPLETE (155 tests passing, merged to dev)
FundsRatio sizing (l=3%, m=6%, h=12%) and SL orders live. SL has zero wallet impact.

### Sprint 3 — Options Data Infrastructure ✅ COMPLETE (241 tests passing, merged to dev)
Options data fetch, expiry/strike calculation, options sessions, naked short margin check live.

### Sprint 4 — Layout + Options UI ✅ COMPLETE (241 tests passing, merged to dev)
Multi-pane layout, dual-stream options replay, lot-sized direct trades live. Post-merge fixes: wrong-strike tick routing (bug #9), OTM direction for `addPane` (bug #10), direction-aware OTM strikes for initial session (bug #11).
