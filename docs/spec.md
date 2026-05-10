
# Trade Matangi Project

## Overview
This project is a trading platform providing 3 major features, simulated trading on older days, simulated trading on current day with live data also known as paper trading and 3rd is real trading with a broker and live market data. This platform will also support advanced features like special entry and exit mechanisms, these mechanisms will be configurable and will require machine to take decisions based on market data. 
The entire project will be broker into 2 parts Frontend in the frontend folder and the backend in the backend folder. The frontend UI will be plotting showing market data in ohlc format for a time interval like 3 minutes, 5 minutes, 1 minutes etc. The UI will provide ways in which the advanced entry/exit mechanisms could be triggered. It will also have a AI Chat Option in which these same mechanisms can be triggered by chat commands. 
The backend will serve the UI. The backend will expose API's which the frontend will use to display data and trigger the respective mechanims or commands. The project will have login support using external vendors like Google and will persist the trades taken by the users and analysis of it. The platform will also provide ways to analyze the trades to better understand the good and bad traits of the manual trader. The platform will also provide live suggestions on the possible market structure and possible trading setups on the go and also post analysis period based on pre-set defined patterns. 

Currently, this platform will be only for Indian Markets and specifically supporting NSE exchange.


## Technology choices and guidelines
One overall guideline for the entire project is, this trading platform is very time critial at run-time. Basically, the time taken from clicking on buy button to actually buying in simulated environment or calling the broker endpoint should be minimum, similarly for squre-off or stoploss update feature.

The project will be divided into 2 parts, frontend and backend. 

The frontend UI platform, react JS, next JS etc, can be chosen as suited. However, below are a set of guidelines to be followed.
1. For plotting the OHLC Data, please use trading view open source library (light-weight charts) https://github.com/tradingview/lightweight-charts, with documentation link :- https://tradingview.github.io/lightweight-charts/docs
2. All the code of the frontend should be present in the frontend folder.
3. The frontend code should be able to be deployed separately on websites like vercel or any other free choices to test. However, only the tested and manually approved version needs to be deployed. Manual testing would be done locally.
4. The frontend framework can be of your choice, recommending reactJS or NextJs. But just check for NextJs if the running environment of WSL on windows is suitable for testing.
5. For fetching streaming data from the backend make your technology choice whether websocket or SSE whichever is suitable in a multi user distributed environment.
6. Apply CORS policy as suitable that is with Access-Control-Allow-Origin=* headers or as suited.



The backend should follow below guidelines.
1. The backend should be a fastAPI based backend.
2. The backend should be able to run threads or parallel processes as it needs to run these trading strategies for entry and exits parallely based on the data.
3. The backend design is open for discussion, however, it needs to persist data and allow multiple users to run trading sessions simulataneously like simulated trading on older days, paper trading or real trading.
4. The final project would be deployed in a multiple boxes and in a distributed environment, so the trading strategies which are running should persist some information so that they can be canceled if if the running thread running host is different from the one which got the cancel request for the particular strategy. Basically, it should also support fastapi inbuilt multiple cpu/process deployment where 2 processes of the server is running. The final Project will be using AWS Dynamo Db as database, instead of Dynamo DB Local which will be only for initial development beta phase, till all the bugs and features are finalized as AWS Dynamo Db will be costly so will be used for final phase as described in the below phase wise development below.
5. Cost is very important so refrain from using any external databases or tools like lambda or queues like sqs etc.
6. The backend should persist the data in a AWSDynamoDB database, which for initials version which is deployed in one machine as Docker version of Dynamo DB Local, and later the AWSDynamoDB databaset can be shifted to AWS Technologies.
7. The backend will be deployed separately from the frontend, so the frontend should store the ipaddress of the backend and the port in some config so that it can be changed if required or may be hard coded as seems fit.
8. The backend will integrate with multiple brokers like Zerodha, Kotak Neo and ICICI Direct.
9. For Cross-process strategy cancellation try to go with design choices to have < 200ms and the polling may or may not be required. One suggestion would be to only check when the strategy is triggered, then you can check if it is still enabled and if not then cancel. Make sure each time the entry or exit strategy is requested a new unique id is used. Uniqueness will be defined, per user, per symbol, trading date and the strategy name. Use that id to manage the strategy lifecycle. The id can be persisted in the database.


Data Storage Guidelines
1. The fetching of the OHLC Data will be through a broker like ICICI-Direct using Breeze library (https://pypi.org/project/breeze-connect/). The fetched data can be stored in a folder or any suitable directory structure as per choosing. In later version this data will be shifted to S3. 
2. The trading data or the trades taken and the analysis, needs to be stored separately per user, either in the AWS DynamoDb Local database (running in Docker at port 8000) of simple files as suitable. In later version, the possibiliy of periodic data backup should be present.

There should be scripts in scripts for starting the backend and frontend for Windows WSL Environment and AWS EC2 for backend as well something like:  
```bash

scripts/start-backend.sh    # Start Backend
scripts/stop-backend.sh     # Stop Backend

scripts/start-backend-ec2.sh    # Start Backend
scripts/stop-backend-ec2.sh     # Stop Backend

scripts/start-frontend.sh    # Start Frontend
scripts/stop-frontend.sh     # Stop Frontend
```
Backend available at http://localhost:8700


## Development process

When instructed to build a feature:
1. Develop the feature - do not skip any step from the feature-dev 7 step process
2. Thoroughly test the feature with unit tests and integration tests and fix any issues
3. Submit a PR using your github tools.


## Feature List
Below are the list of phases, and each phase has a list of features described. Each Feature has a label in front, use that label to inform the status of the feature and any issues detected in it. The entire project will be deployed in phases, below are each phase listed and their respective features.

### Phases

#### Phase-I MVP (Minimum Viable Product)

Include this phase in the context only when you are implementing or planning phase 1. The phase 1 docs is location at <project root>/docs/spec-phase1.md


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

**Design Note (2026-05-10, updated 2026-05-10):** Two order types are supported: TARGET (stop-limit) and LIMIT. TARGET: user enters a trigger price; limit execution price is auto-computed at 1% deviation (`BUY limit = trigger × 1.01`, `SELL limit = trigger × 0.99`); BUY fills when `price >= trigger`, SELL when `price <= trigger`. LIMIT: user enters the limit price directly; BUY fills when `price <= limit`, SELL when `price >= limit`. Both types are persisted to DynamoDB. OrderPanel shows a TARGET/LIMIT toggle. Quantity is selectable (default 1 unit); lot-based quantity for options/futures deferred to Phase-III.

##### Flexible Inputs
1. UI and backend will allow to choose date on which replay is to be done. And fetch last 2 days of data for the respective symbol.
2. UI and backend will allow to choose the symbol. The choices can be restricted for now, that is NIFTY, TATPOW (Tata Power), TATMOT (Tata Motors), RELIND (Reliance). These are the ICICI Direct / Breeze API stock codes.


#### Phase-III BetaStage
Include this phase in the context only when you are implementing or planning phase 3. The phase 3 docs is location at <project root>/docs/spec-phase3.md


#### Phase-IV Entry/Exit Custom Logic

The details are getting discussed.




## Notes

### Phase-II Implementation Status (as of 2026-05-10)

**Completed (branch: `feature/phase-ii-sprint-3`, PR #5 open against `dev`):**

**Sprint 2 — DynamoDB, Orders, OrderPanel:**
- DynamoDB Local (Docker) persistence for Sessions and Trades tables; `USE_DYNAMODB_LOCAL=true` env var controls local vs AWS
- TARGET order engine: in-memory `_orders` store, `check_orders` called each tick in simulation loop, filled orders recorded as trades + emitted as `order_filled` SSE events
- `/api/orders` REST endpoints: POST (place), GET (list open/all), DELETE (cancel)
- OrderPanel frontend component: BUY/SELL toggle, trigger price input, quantity picker, open orders list with cancel
- 85 backend tests

**Sprint 3 — Multi-pane charts, Symbols/Dates, Drawing tools:**
- Symbol dropdown (NIFTY, TATPOW, TATMOT, RELIND) fetched from `/api/data/symbols`
- Date picker: `<input type="date">` defaulting to last weekday; weekends blocked client-side; future dates blocked via `max={today}`
- SSE connection lifted from Chart to App level — all chart panes share one connection
- Multi-pane charts: add/remove panes with independent intervals; dynamic height via `ResizeObserver` (1–2 panes fill window, 3+ use 280px fixed)
- EMA(9) orange + EMA(21) blue overlays with toggle; incremental update per closed candle
- H-Line drawing tool via `series.createPriceLine()`; Trend Line via `chart.addLineSeries()` with click-capture
- Pre-session candles fix: `updateSymbol`/`updateDate` push state in real-time so Chart pre-loads before Start

**Sprint 3 follow-on — LIMIT orders + data infrastructure:**
- LIMIT order type alongside TARGET: LIMIT BUY fills when `price <= limit`, SELL when `price >= limit`; OrderPanel has TARGET/LIMIT toggle
- Breeze fetch → Parquet: `broker_service.fetch_historical` now saves to `data/ohlcdata/<symbol>-DD-MM-YYYY.parquet`; `data_loader.load_dataframe` checks parquet → pickle (legacy migration) → raises
- `pyarrow` added to `requirements.txt`
- Simulation `/start` endpoint validates symbol + pre-fetches data (Breeze if needed) before creating session, returning 503/404 with human-readable errors on failure
- Date picker backend-aware: Breeze errors (expired token, market holiday) surface in the UI as inline error text
- 98 backend tests passing

**Pending (open PR #5):**
- PR #5 covers: LIMIT order type, dynamic pane heights, 1% target deviation, symbol renames (TATPOW/TATMOT/RELIND), date picker, parquet/Breeze data fetch

---

### Bugs Fixed in Phase-II

1. **DynamoDB Local `UnrecognizedClientException`**: DynamoDB Local rejects real AWS credentials (ASIA* keys). Fix: when `USE_DYNAMODB_LOCAL=true`, always use hardcoded dummy credentials (`fakeKey`/`fakeSecret`) regardless of what is in `accesskeys.ini`.
2. **Target order fill not recording trade**: `check_orders` in `_run_session` was filling orders but not calling `record_trade`. Fix: call `record_trade` for each filled order before emitting the `order_filled` SSE event. Frontend `handleOrderFilled` was also updated to refresh position + trades from backend.
3. **Pre-session candles race condition**: Chart component was fetching historical data at the same time as `startSession` updated `startTime`, causing a race. Fix: `updateSymbol`/`updateDate` update state immediately as the user changes dropdowns; `startSession` only changes `startTime`.
4. **Docker DynamoDB SQLite permission error**: container ran as non-root; fix was to add `user: root` to `docker-compose.yml`.
5. **Test patch targets**: after `pickle_path` was made public in `data_loader.py`, test patches needed updating from `app.services.broker_service.DATA_DIR` to `app.services.data_loader.DATA_DIR`.

---

### Technology Decisions Finalized in Phase-II

**DynamoDB persistence pattern**
Each service (`trading.py`, `order_service.py`, `simulation.py`) lazily imports `get_dynamodb_resource()` inside `_write_*_to_db` helpers. Failures are logged and swallowed — the simulation continues even if DynamoDB is unavailable. This avoids tight coupling between the real-time simulation loop and storage.

**Parquet as primary data format**
New data fetched from Breeze is stored as `data/ohlcdata/<symbol>-DD-MM-YYYY.parquet`. Legacy pickle files in `data/` are auto-migrated to parquet on first access. The IST-as-UTC timestamp convention (`tz_localize("UTC")`) applies identically to both formats.

**Single SSE connection per app instance**
SSE is opened once in `App.tsx` (not per chart pane). All panes receive `latestTick` as a prop. This prevents N×SSE connections when N panes are open.

**Order fill → Trade recording**
When a simulated order fills, the backend: (1) marks order FILLED in memory + DynamoDB, (2) calls `record_trade` to create a trade record, (3) emits `order_filled` SSE event. The frontend removes the order from `openOrders` and refreshes `position` + `trades` via two parallel API calls.

**Breeze data fetch during simulation start**
`/api/simulation/start` calls `fetch_historical(symbol, date)` synchronously before creating the session. This means the first request for a new date blocks for the Breeze API call (a few seconds), but subsequent replays are instant. Errors (expired token, holiday) return HTTP 503/404 with detail messages that the frontend surfaces inline.

---

### Phase-I Implementation Status (as of 2026-05-10)

**Completed (branch: `feature/phase-i-mvp`):**
- FastAPI backend: CORSMiddleware, asyncio simulation engine (one `asyncio.Queue` + `asyncio.Event` per session), SSE tick stream, in-memory trade store
- All 10 REST endpoints implemented — `/api/simulation/*`, `/api/stream/{id}`, `/api/data/historical`, `/api/trades/*`
- 27 backend unit tests passing (data_loader, simulation state machine, trading)
- Frontend: React + Vite + TypeScript, Lightweight Charts v4 candlestick replay
- Session controls: Start with configurable start time + replay speed, Pause, Resume, Stop
- Buy/Sell with in-memory position tracking, real-time P&L calculated on the frontend
- Trade history panel showing all trades in the session
- Historical chart: May 4 + May 5 NIFTY 3-min candles loaded on mount
- Scripts for WSL and EC2: `start-backend.sh`, `start-frontend.sh`, and stop equivalents

**Known Open Issue:**
When replay starts at a time after 09:15 (e.g. 10:15), the May 6 candles between 09:15 and the chosen start time are not shown on the chart — the live replay appears disconnected from the prior two days of data. A fix was prototyped (backend `GET /api/data/pre-session` endpoint + frontend `presessionCandles` state in `useSimulation`, effects in `Chart.tsx`) but reverted for further review. The fix approach is sound; it was not a correctness issue.

---

### Technology Decisions Finalized in Phase-I

**SSE over WebSocket** (resolves HS-1)
SSE (`text/event-stream`) was chosen for the tick stream. Rationale: tick data is server-to-client only, SSE works across multiple uvicorn workers without sticky sessions, and the browser's `EventSource` API handles reconnection automatically. WebSocket would be reconsidered only if bidirectional in-session messaging (e.g. server-initiated trade execution triggers) becomes a requirement.

**IST Timezone Handling** (resolves MS-3)
The pickle files use a tz-naive `DatetimeIndex` representing IST wall-clock times (e.g. `2026-05-06 09:15:00`). Lightweight Charts interprets Unix timestamps as UTC for display. Rather than converting IST → UTC (which shifts display times by −5:30, showing 03:45 instead of 09:15), the backend uses `df.index.tz_localize("UTC")` — attaching the UTC label to the IST wall-clock value. This makes the Unix timestamps encode the IST time directly so the chart x-axis shows the correct market time without any client-side configuration. Applied consistently in `data_loader.py` for both historical REST and SSE tick timestamps.

**P&L on the Frontend** (resolves MS-1)
P&L is calculated entirely in the browser: `direction × quantity × (currentPrice − avgEntryPrice)`. No backend round-trip needed. Updated on every SSE tick.

**3-Minute Candle Window Alignment**
Both sides use epoch-aligned boundaries: pandas `resample("3min")` on the backend and `Math.floor(tick.time / 180) * 180` on the frontend. This guarantees live-streamed ticks aggregate into candles whose timestamps exactly match the pre-loaded historical candles.

**Placeholder User ID** (resolves HS-3)
Even with no auth in Phase-I, all trades record `user_id = "00000000-0000-0000-0000-000000000001"`. The schema is forward-compatible: swapping in a real UUID when auth lands in a later phase requires no structural change.

**Parquet adopted in Phase-II** (resolves HS-5)
New Breeze-fetched data is stored as Parquet in `data/ohlcdata/`. Legacy pickle files are still readable and auto-migrate to Parquet on first access. `pyarrow` is the engine (`requirements.txt`). The same IST-as-UTC convention applies to both formats.

---

### WSL `/mnt/d/` Filesystem Constraints

The project lives on the Windows filesystem under `/mnt/d/`. Two constraints apply:

1. **Python venv**: the Windows filesystem does not support the `lib → lib64` symlink that `python -m venv` creates. Create the venv on the Linux filesystem: `python -m venv ~/venvs/tradematangi`.

2. **npm install**: `.bin/` symlinks fail on the Windows filesystem. Always use `npm install --no-bin-links`. Scripts invoke Vite directly via `node node_modules/vite/bin/vite.js` instead of the `.bin/vite` symlink.

These constraints are encoded in `scripts/start-backend.sh` and `scripts/start-frontend.sh`.

