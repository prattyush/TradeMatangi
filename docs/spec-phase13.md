#### Enhancements

##### Fyers ✅ Complete (PR #279 merged to dev)

Fyers live streaming is now available as the primary streaming source for paper and real trading sessions.

**Implementation:**
- `backend/app/services/fyers_service.py` — `FyersBroadcaster` singleton managing one `FyersDataSocket` WebSocket connection shared by all active sessions
- Uses `fyers_apiv3.data_ws.FyersDataSocket` with LTP mode for ticks
- 1-second OHLC accumulation (same `_OHLCAccumulator` as Kite/Kotak/Breeze), pushed to `session.paper_tick_queue`
- Token flow: DDB `BrokerTokens` table (`fyers_access`) → `data/accesskeys.ini` `[fyers]` section fallback
- Admin UI: "Fyers" button added to LIVE STREAMING SOURCE selector, Fyers Access Token and Refresh Token inputs in BROKER TOKENS section
- Admin API: `GET/PUT /api/admin/tokens` supports `fyers_access` and `fyers_refresh`; `PUT /api/admin/stream-source` accepts `"fyers"`
- Fallback chain: fyers → breeze → kotak → kite

**Fyers symbol format:**
- Equities: `NSE:RELIANCE-EQ`
- Indices: `NSE:NIFTY50-INDEX`, `BSE:SENSEX-INDEX`
- Options: `NSE:NIFTY30JUL26000CE` (symbol + day + month-abbr + strike + right)


##### Chart Structure ✅ Complete (PRs #282, #284, #286, #288, #290)

Users can browse daily charts classified by Opening, Midday, and Closing structure types.
Predefined classifications are system-generated and visible to all users. Users can create
custom classifications and share them via the existing pattern-sharing mechanism.

**Database:**
- `ChartStructures` table: PK=`chart_structure_id`, GSIs `UserIdIndex` (on `user_id`) and `SymbolDateIndex` (on `symbol`+`date`)
- `ChartStructureShares` table: PK=`owner_user_id`, SK=`shared_user_id`, GSI `SharedUserIdIndex` on `shared_user_id`
- Predefined records have `user_id="__SYSTEM__"`, `is_predefined=true`. User-custom records have real `user_id`, `is_predefined=false`.

**Classification Script (`scripts/classify_chart_structures.py`):**
- Batch classifies any supported symbol (NIFTY, BSESEN, TATPOW, TATMOT, RELIND)
- Uses Breeze API to auto-fetch missing parquet cache (same as `fetch_historical()`)
- DDB credentials read from `accesskeys.ini` matching other scripts

**Classification rules:**

| Segment | Types | Logic |
|---|---|---|
| **Opening** | `within_yesterdays_range`, `within_day_before_yesterdays_range`, `gap_up`, `gap_down`, `big_gap_up`, `big_gap_down`, `undefined` | Compares today's open to yesterday's open-close range tiered: within range → within DBY range → within 2×range (direction determines up/down) → beyond 2×range (big gap) |
| **Midday** | `trading_range`, `breakout`, `trend`, `undefined` | First 15-min candle vs 12:00 close. Within first-15 OHLC → range. Beyond 2× first-15 range → breakout. Between → trend |
| **Closing** | `trading_range`, `breakout`, `reversal_breakout`, `trend`, `trend_reversal`, `undefined` | Open-to-12:00 range vs day close. 5 tiers with direction-aware breakout/reversal/trend logic |

**Backend API (`/api/chart-structures`):**

| Method | Path | Purpose |
|---|---|---|
| GET | `/types` | Return predefined opening/midday/closing types |
| GET | `/structures` | Filtered list (multi-select on opening/midday/closing types, symbol, date range) |
| GET | `/structure/{id}` | Full structure record |
| GET | `/ohlc/{symbol}/{date}` | 3-minute OHLC candles for current day + 2 prior trading days |
| POST | `/structure` | Create user-custom classification |
| PUT | `/structure/{id}` | Update (owner only) |
| DELETE | `/structure/{id}` | Delete (owner only) |

Sharing reuses `pattern_share_emails` — when pattern shares are synced, chart structures sync to the same users automatically.

**Frontend:**
- "📊 Structures" button in main header nav
- Multi-select dropdown filters for Opening, Midday, Closing types
- Gallery grid with sparkline previews per chart
- Full-chart modal with lightweight-charts OHLC (3 days), EMA 9/21 toggle, inline classification editing
- `typeBadge()` with directional color coding (up=green, down=red, range=blue, breakout=green, trend=purple, reversal=pink)

**Files changed:**

| File | Change |
|---|---|
| `scripts/setup-dynamodb-tables.py` | ChartStructures + ChartStructureShares table definitions |
| `scripts/classify_chart_structures.py` | **New** — batch classification with auto-fetch + idempotent reclassify |
| `backend/app/services/chart_structure_service.py` | **New** — CRUD, query, type definitions, sharing |
| `backend/app/routers/chart_structures.py` | **New** — REST API |
| `backend/app/main.py` | Register chart_structures router |
| `backend/app/services/user_settings_service.py` | Sharing hook triggers `sync_structure_shares` |
| `backend/app/services/broker_service.py` | Catch Breeze session-key-expired as BreezeTokenError (prevents UI refresh loop) |
| `backend/tests/test_user_settings.py` | Patch `sync_structure_shares` in sharing test |
| `frontend/src/services/api.ts` | 7 chart structure API methods + types |
| `frontend/src/pages/ChartStructures.tsx` | **New** — full structures browser with filters, gallery, chart modal, EMA |
| `frontend/src/App.tsx` | "📊 Structures" nav button + conditional render |
| `docs/chart-structure-feature.md` | Planning doc |


##### Advanced Analysis
This feature need to extend the current Analysis to include new features. When we click on Analysis button we enter into a space where we can look through past trades with markets on chart to understand the trades. The analysis also has snapshot information for better understanding pshychy during trading. This Trade Analysis can to be extended to include, 2 more features, labelling of trades and metrics of trades without and with labels.

A single trade is defined as when a user enter a position with date, symbol, (CE, PE for options for respective underlying) and exits the position entirely. The position can be either side buy or sell. Trades are considered at daily level now, overflowing trades acrosss days are not considered. So, from day's start if user performs 2 buys of 65 quantity each and then exits the position with one sell of quantity 130, then trade is finished. If user buys 65  in CE, theen buys 130 in PE and then exits CE 65 position after 6 minnutes, but contines with PE position, then the CE trade is finished, PE is continuing till the user exits position in PE as well.

1. Trades Labelling:- The feature is to have an option in analysis, for a date, symbol (underlying for options), type of trading (paper, real and simulation), that allows users to label these trades, so a UI which has the ohlc chart with markers similar to what we have in anallysis, with on the left or right the grouping of traddes, with each trade shwoing the enter and the exit and having 4 dropdowns to label the trade. 
a) Expected Pattern of the Trade:- This dropddown will have all the patterns that the user has in the drop down in 2 dropdowns in pattern window, so user can specify with which pattern in mind the user took the trade. So this dropddown is actually 2 dropdowns which has same value as pattern window.
b) Actual Pattern of the Trade:- This is similar dropdown to a) with same values but it signifies what was the actual pattern.
c) Entry Tag:- This will have an option to create new or select old ones which are already added, similar to patterns. This signifies the users comments on how was the entry like Panic Entry, Perfect Entry, Late Entry, FOMO Entry etc.
d) Exit Tag:- This is similar to entry tag, except here user can define a different set of tags, like scared exit, greedy exit, target reached exit etc. Users can type their own and what they have already declared is added to the dropddown similar to pattern.

User if misses actual pattern fill it same as expected. And if Entry and Exit are not entered, enter default value: - "AS_PER_PATTERN"

2. Stats :- This features shows status, total trades, winning percentage of trades, avg % profit made in trades (PnL % calculated against avg entry price and total profit made), 95 percentile P/L % each of these calculated per pattern combination (expected). Calculate within a start date and end date. Some stats are to be inclueded as well like expected v/s actual mismatch %, % of trades in profit based on mis-match. Which expected pattern has most mismatch. which actual pattern is most mismatcch too. Also PnL% against exit and entry  tags. Feel free to include more trading related stats if required.

