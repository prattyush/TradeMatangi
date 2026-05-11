
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

### Sprint 2 — FundsRatio + Stoploss

**Goal:** Replace quantity with capital-ratio sizing and add the SL tab to the order panel.

**Backend:**
- FundsRatio calculation: `session_capital × ratio% → target spend → floor(spend / (option_price × lot_size))` = number of lots
- 1-lot fallback if ratio spend < 1 lot cost; hard error if current wallet < 1 lot cost
- Hardcoded lot sizes: `NIFTY=75, RELIND=250, TATMOT=1400, TATPOW=2700`; equity uses price × quantity directly
- Stoploss order type: opposite direction, quantity ≤ open position size, no wallet debit

**Frontend:**
- Settings toggle: FundsRatio mode vs Quantity mode (persisted in localStorage)
- When FundsRatio on: OrderPanel shows L/M/H buttons instead of quantity input for all order types except SL
- FundsRatio % overrides in Settings popup (l/m/h default 3/6/12, user-editable per user)
- SL tab: enabled only when a position is open; pre-fills opposite direction + open qty; quantity field always shown; qty capped at open position size

**Tests:** ratio→lots calculation, 1-lot fallback, unaffordable error, SL tab state

---

### Sprint 3 — Options Data Infrastructure (Backend)

**Goal:** Options OHLC fetch, caching, and streaming working end-to-end before any options UI is built. Highest-risk sprint.

**Backend:**
- `GET /api/data/price-at?symbol=X&date=YYYY-MM-DD&time=HH:MM` — reads first price at/after given time from cached parquet; fetches from Breeze if not cached
- Expiry date calculator: date-aware (Thursdays pre-2025-09-01, Tuesdays from 2025-09-01), shifts to previous trading day on holiday
- ATM strike calculator: `round(price / interval) * interval` where interval=50 for NIFTY, 5 for equities; apply OTM/ITM offset
- Options fetch + pagination: `get_historical_data_v2(exchange_code="NFO", product_type="options", expiry_date, strike_price, right)` with same 15-min chunking as equity
- Cache path: `data/ohlcdata/{SYMBOL}-{CE|PE}-{STRIKE}-{EXPIRY}-{DD-MM-YYYY}.parquet`
- Options session: `POST /api/simulation/start` accepts `instrument_type=options`, `strike`, `expiry`, `right`; streams ticks via existing SSE
- Naked short margin check: `symbol_price × lot_size × 0.20`; blocked if wallet insufficient
- DynamoDB Sessions/Trades gain options metadata fields: `strike`, `expiry`, `right`, `instrument_type`

**Tests:** expiry calculation pre/post 2025-09-01 including holiday edge cases, ATM strike calc, paginated options fetch, margin check, cache path generation

---

### Sprint 4 — Layout + Options UI (Frontend)

**Goal:** Multi-pane layout system and full options trading UI on top of the Sprint 3 backend.

**Frontend:**
- Layout control bar (top of screen): buttons for 1/2/3/4 pane presets
  - 1 pane: full width/height
  - 2 panes: vertically stacked
  - 3 panes: 1 full-width on top + 2 half-width below (default for options mode)
  - 4 panes: 2×2 grid
- Each pane configurable as: symbol at an interval (equity mode) or Call/Put at a strike+expiry (options mode)
- Instrument type toggle in session config: Equity vs Options; NIFTY locked to Options only
- When Options selected: layout switches to 3-pane default; top pane = underlying, bottom two = CE + PE at computed ATM strike
- Strike configurator per pane: OTM/ITM offset input; calls `GET /api/data/price-at` to resolve and display computed strike before session start
- Pane header shows: symbol + interval (equity) or strike + expiry + CE/PE (options)
- Active pane selection: clicking a pane highlights it; Buy/Sell in OrderPanel applies to the active pane's instrument
- Options panes freely deletable and re-addable with different strike or CE/PE

**Tests:** layout rendering at each preset, pane add/remove, active pane selection, options config before session start

