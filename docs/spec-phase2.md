
#### Phase-II Older Data Fetch

This phase the simulated engine and the UI will support taken symbol and types and the respective dates and fetch the data from Breeze Library. The UI should also be advanced for supporting different charts for the same symbol for different intevals. In this phase

##### MultiPane Charts
1. UI will support multiple formats, or panes for displaying the OHLC data, these different panes can display data in different time-intervals.
2. UI should support add indicators Exponential Moving Average for a window of 9 and 21. The data for the EMA can be either calculated in the backend and through streaming or calculated in the frontend.
3. UI should have option to provide dates for which the simulated trading is to be done and based on that the backend will fetch the data.
4. UI should support drawing horizontal and trend lines on the chart.

##### BROKER Integration
1. The backend should integrate with breeze library to fetch the data for the respective symbol. 
2. The backend should in this phase persist all fetched data from broker and also the trades taken in a database DynamoDb Local.
3. Use the broker integration to only fetch, don't place orders.
4. The access credentials are present in the data/ folder in the files accesskeys.ini. It is in config format for python to read. Already added .ini in .gitignore so that it is not included in the git files. The code snippet for creating breeze instance is as below:-
```
from breeze_connect import BreezeConnect
import configparser

credentials_config_parser = configparser.ConfigParser()
credentials_config_parser.read('data/accesskeys.ini')
breeze = BreezeConnect(api_key=credentials_config_parser['icicidirect']['api_key'])
breeze.generate_session(api_secret=credentials_config_parser['icicidirect']['api_secret'],
                        session_token=credentials_config_parser['icicidirect']['session_token'])
```


##### Basic AllOrders
1. The UI will support another feature called stop limit placement and limit and target order.
2. The backend should be able to persist these limit, stop limit and target orders and trigger them in the simulated trading environment when the condition for the respective order is fullfilled.
3. The UI and backend should support clearing of these orders and also display of the open orders when asked for.

**Design Note (2026-05-10):** Two order types are supported: TARGET (stop-limit) and LIMIT. TARGET: user enters a trigger price; limit execution price is auto-computed at 1% deviation (`BUY limit = trigger × 1.01`, `SELL limit = trigger × 0.99`); BUY fills when `price >= trigger`, SELL when `price <= trigger`. LIMIT: user enters the limit price directly; BUY fills when `price <= limit`, SELL when `price >= limit`. Both types are persisted to DynamoDB. OrderPanel shows a TARGET/LIMIT toggle. Quantity is selectable (default 1 unit); lot-based quantity for options/futures deferred to Phase-III.

##### Flexible Inputs
1. UI and backend will allow to choose date on which replay is to be done. And fetch last 2 days of data for the respective symbol.
2. UI and backend will allow to choose the symbol. The choices can be restricted for now, that is NIFTY, TATPOW (Tata Power), TATMOT (Tata Motors), RELIND (Reliance). These are the ICICI Direct / Breeze API stock codes.

---

## Phase-II Implementation Status (as of 2026-05-10, all PRs merged to dev)

**Phase-II is complete.** All features from the spec are implemented and merged. 110 backend tests passing.

### What is shipped

**Sprint 2 — DynamoDB, Orders, OrderPanel:**
- DynamoDB Local (Docker) persistence for Sessions and Trades tables; `USE_DYNAMODB_LOCAL=true` env var controls local vs AWS
- TARGET order engine: in-memory `_orders` store, `check_orders` called each tick in simulation loop, filled orders recorded as trades + emitted as `order_filled` SSE events
- LIMIT order type alongside TARGET: LIMIT BUY fills when `price <= limit`, SELL when `price >= limit`; OrderPanel has TARGET/LIMIT toggle
- `/api/orders` REST endpoints: POST (place), GET (list open/all), DELETE (cancel)
- OrderPanel frontend component: BUY/SELL toggle, TARGET/LIMIT toggle, trigger/limit price input, quantity picker, open orders list with cancel

**Sprint 3 — Multi-pane charts, Symbols/Dates, Drawing tools:**
- Symbol dropdown (NIFTY, TATPOW, TATMOT, RELIND) fetched from `/api/data/symbols`
- Date picker: `<input type="date">` defaulting to last weekday; weekends blocked client-side; future dates blocked via `max={today}`
- SSE connection lifted from Chart to App level — all chart panes share one connection
- Multi-pane charts: add/remove panes with independent intervals; dynamic height via `ResizeObserver` (1–2 panes fill window, 3+ use 280px fixed)
- EMA(9) orange + EMA(21) blue overlays with toggle; incremental update per closed candle
- H-Line drawing tool via `series.createPriceLine()`; Trend Line via `chart.addLineSeries()` with click-capture

**Data infrastructure (follow-on fixes, all merged):**
- Breeze `get_historical_data_v2` caps at ~1000 records/call; a full trading day needs 22 500 1-second rows. Fixed by paginating into 25 × 15-minute chunks in `broker_service._fetch_day_paginated`. Cached parquet files with < 20 000 rows are automatically discarded and re-fetched.
- `data_loader.validate_and_fill_gaps()`: gaps ≤ 15 min are forward-filled; gaps > 15 min raise `RuntimeError`. Called on every new Breeze fetch before saving.
- Parquet is the primary data format (`data/ohlcdata/<symbol>-DD-MM-YYYY.parquet`). Legacy pickles auto-migrate on first access.

**Frontend stability fixes (merged):**
- Chart init `useEffect` had `[height]` in its dep array. Adding a pane or resizing the browser changed `paneHeight`, tearing down and recreating the chart without re-fetching historical data — all candles were lost. Fixed by separating init (`[]` deps, runs once) from height updates (`chart.applyOptions({ height })` only).

---

## Bugs Fixed in Phase-II

1. **DynamoDB Local `UnrecognizedClientException`**: DynamoDB Local rejects real AWS credentials (ASIA* keys). Fix: when `USE_DYNAMODB_LOCAL=true`, always use hardcoded dummy credentials (`fakeKey`/`fakeSecret`) regardless of what is in `accesskeys.ini`.
2. **Target order fill not recording trade**: `check_orders` in `_run_session` was filling orders but not calling `record_trade`. Fix: call `record_trade` for each filled order before emitting the `order_filled` SSE event. Frontend `handleOrderFilled` also updated to refresh position + trades from backend.
3. **Pre-session candles race condition**: Chart was fetching historical data at the same time as `startSession` updated `startTime`. Fix: `updateSymbol`/`updateDate` update state immediately; `startSession` only changes `startTime`.
4. **Docker DynamoDB SQLite permission error**: container ran as non-root; fix was to add `user: root` to `docker-compose.yml`.
5. **Breeze API truncation**: single-call fetch only returned ~1000 records (last ~16 min of the day). Fix: paginate into 15-min chunks; validate completeness before saving.
6. **Chart data loss on resize/pane-add**: `useEffect([height])` for chart init caused full chart teardown on any height change. Fix: separate init from height via `applyOptions`.

---

## Technology Decisions Finalized in Phase-II

**DynamoDB persistence pattern**
Each service (`trading.py`, `order_service.py`, `simulation.py`) lazily imports `get_dynamodb_resource()` inside `_write_*_to_db` helpers. Failures are logged and swallowed — the simulation continues even if DynamoDB is unavailable. This avoids tight coupling between the real-time simulation loop and storage.

**Parquet as primary data format**
New data fetched from Breeze is stored as `data/ohlcdata/<symbol>-DD-MM-YYYY.parquet`. Legacy pickle files in `data/` are auto-migrated to parquet on first access. The IST-as-UTC timestamp convention (`tz_localize("UTC")`) applies identically to both formats.

**Breeze pagination pattern**
`broker_service._fetch_day_paginated` splits the trading day into 15-minute windows and issues one `get_historical_data_v2(interval="1second")` call per window. Never make a single full-day call for 1-second data — the API silently truncates to ~1000 records.

**Single SSE connection per app instance**
SSE is opened once in `App.tsx` (not per chart pane). All panes receive `latestTick` as a prop. This prevents N×SSE connections when N panes are open.

**Order fill → Trade recording**
When a simulated order fills, the backend: (1) marks order FILLED in memory + DynamoDB, (2) calls `record_trade` to create a trade record, (3) emits `order_filled` SSE event. The frontend removes the order from `openOrders` and refreshes `position` + `trades` via two parallel API calls.

**Breeze data fetch during simulation start**
`/api/simulation/start` calls `fetch_historical(symbol, date)` synchronously before creating the session. This means the first request for a new date blocks for ~25 Breeze API calls (a few seconds), but subsequent replays are instant. Errors (expired token, holiday) return HTTP 503/404 with detail messages that the frontend surfaces inline.

**Lightweight Charts — never re-create the chart for layout changes**
Any prop change that triggers chart teardown (`chart.remove()`) also loses all series data. For layout-only changes (height, width), always use `chart.applyOptions(...)`. Only re-create the chart (empty `[]` dep array on init effect) when the component mounts.

