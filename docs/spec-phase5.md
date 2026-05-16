#### Phase-V TradeAnalysis

This phase will allow trades to be analyzed for manual evaluation and later for AI Based analysis.


##### TradeAnalysis
1. We will an option to open separate screen for trade data analysis, maybe at the top left of the screen or anyplace suitable.
2. The new UI will allow to choose the type of trading (symbol or option trading) and the primary symbol like for option trading for NIFTY 50, option of NIFTY50 needs to be selected. Next would a range of days.
3. Given the values selected in the above step 2, the trade history for that day, symbol combination should be displayed. If a range of days are selected, show for each day. Open to suggestions whether all trade history will be displayed together or next=next type of option.
4. For each day also display net P&L for that symbol, day combination with % P&L calculated with respect to the wallet value before that of that day's session of trading. Also, display the % of winning or losing trades.
5. The charts should also be displayed, may be only the symbol and not options chart, And the chart should show buy and sell markers for all trades in the range of days.  A Buy in Call would be reflected as a buy and a sell in a call as a sell. A buy in Put would be shown as sell and a sell in Put would be shown as buy in the symbol chart. Here symbol means Nifty 50, sensex or likewise. 


##### LogIn
1. Add the first screen for user login, User login is defined by email address and a password, save the password and email in persistence layer. Better to save the password as one time hash. 
2. Password resetting is not present as of now, as that requires sending OTP to email which is not added now. Create a new table if required. Then, display the the usual screen. The settings shown the setting menu should be stored per user.

##### Persistence
1. For each trading session, store the trades taken also the wallet value captured at the start of the session. Better to store it in tables and then show it in the trade analysis, as that wallet value would be required to calculate the P&L % w.r.t to wallet value.


##### ReloadChart
1. One of the problems when a new pane is added is that the new pane start to show the data correctly but in the lightweight chart the old value still remains, thus it show the previous candle lowest or highest point from previous strike price value. Let say the value of strike price 73500 was in range of 60 to 61 then I removed the pane added a new pane of strike price 73900, with range around 41-42, then the current candle is showing the currrent price. But the candle has high point of 61. So add an icon to reload chart on the top may be beside the Bar close or anywhere as suited, when clicked the chart data is fetched till previous bar not the current candle and rendered on the chart. The user can click on refresh after the candle finishes to fixed the candles. This will also come in handy when implementing papertrading as with real streaming data this problem will always be present.


## Phase-V Implementation Status ✅ COMPLETE (299 tests) — PR #18 open

### Features Shipped

#### Login
- `POST /api/auth/login` and `POST /api/auth/register` with bcrypt password hashing
- Default admin user seeded on startup: `admin@tradematangi.com` / `admin123` (user_id = `abc12300-0000-0000-0000-000000000001`)
- `LoginScreen.tsx` — email/password form with login/register toggle; hint shows defaults
- Auth state persisted in `localStorage.auth_user` as `{userId, email}`; sign-out clears it
- `App()` is now the auth gate: renders `<LoginScreen>` if no auth, otherwise renders `<AppInner>` (all existing UI)
- User email + sign-out button in main header; `📊 Analysis` button opens Trade Analysis modal

#### Trade Analysis
- `GET /api/analysis/sessions` — list sessions for user, filterable by symbol/date range/instrument_type
- `GET /api/analysis/sessions/{id}` — session detail with all trades
- `analysis_service.py`: queries Sessions + Trades from DynamoDB via `UserIdIndex` GSI, computes net P&L (SELL proceeds − BUY costs − commissions), `pnl_pct` as percentage (e.g. 9.70 = 9.70%)
- `TradeAnalysis.tsx` — full-screen modal: symbol + date + type filters, aggregate stats (sessions, win rate, total trades, total P&L), per-session expandable cards with trade table + embedded equity chart
- Chart shows prior 2 days + full trading day (historical + pre-session merged); trade markers on correct bars
- Chart height = `max(300, floor(containerWidth × 0.45))` — scales with modal width (~2.2:1 ratio)
- Options trades mapped to underlying direction: Buy CE/Sell PE → ↑ BUY marker, Sell CE/Buy PE → ↓ SELL marker
- `pnl_pct` displayed as `{value.toFixed(2)}%` (NOT `* 100` — backend stores as percentage already)

#### User Data Isolation
- `app/dependencies.py`: `get_request_user_id` FastAPI dependency reads `X-User-Id` header, defaults to `FIXED_USER_ID` so tests without the header continue to pass
- `SimulationSession` gains `user_id` field; `create_session()` accepts `user_id` and uses it for wallet snapshots and DynamoDB writes
- `record_trade()` accepts `user_id`; stored on `Trade` object and in DynamoDB
- `order_service.place_order()` accepts `user_id`; wallet debit uses it; `cancel_order`/`update_order`/`check_orders` use `order.user_id`
- Session-based routers (simulation, trading, orders) derive `user_id` from `session.user_id`; non-session routers (wallet, analysis) use `Depends(get_request_user_id)`
- Frontend `api.ts` adds `_authHeaders()` helper that reads `localStorage.auth_user` and injects `X-User-Id: <userId>` on all authenticated requests

#### Reload Chart
- `↻` button in every chart pane toolbar
- Increments `localReloadKey`; `effectiveReloadKey = reloadKey + localReloadKey` triggers historical re-fetch and `series.setData()`
- Clears `liveWindowRef`, `lastEma9Ref`, `lastEma21Ref`, `candleTimesRef` on reload
- Fixes phantom candle price range inherited from a previous strike when a pane is removed and re-added

### Backend New Files
- `app/routers/auth.py` — `POST /api/auth/login`, `POST /api/auth/register`
- `app/routers/analysis.py` — `GET /api/analysis/sessions`, `GET /api/analysis/sessions/{id}`
- `app/services/analysis_service.py` — session query + P&L computation
- `app/dependencies.py` — `get_request_user_id` FastAPI header dependency

### Frontend New Files
- `frontend/src/components/LoginScreen.tsx` — auth gate form
- `frontend/src/components/TradeAnalysis.tsx` — full analysis modal + embedded chart

### Tests
- `tests/test_auth.py` — 6 tests for login/register endpoints (patches `user_service._find_by_email`)
- `tests/test_analysis.py` — 21 tests for analysis endpoints and service (patches service functions)
- `tests/test_user.py` — updated: `test_seed_writes_to_db` asserts `email` + `password_hash` fields


## Phase-V Post-Merge Bugs Fixed

### Bug #1 — All users see the same trade history
**Symptom**: A newly registered user sees all sessions and trades from all other users in Trade Analysis.
**Root cause**: Every service hardcoded `FIXED_USER_ID` — sessions, trades, orders, and wallet reads/writes were all keyed to the same UUID regardless of who was logged in.
**Fix**: Threaded actual user_id through the full stack:
- `get_request_user_id` dependency reads `X-User-Id` header (defaults to `FIXED_USER_ID` for backward compat)
- `SimulationSession.user_id` carries the owner; all DynamoDB writes use it
- `record_trade()`, `place_order()`, `cancel_order()`, `check_orders()` all use the correct user's wallet
- Frontend sends `X-User-Id` header on all authenticated fetch calls

### Bug #2 — Analysis chart shows previous day's candles; markers pile up on last bar
**Root cause**: `getHistorical(symbol, date)` returns only the 2 **prior** trading days — not the trading date itself (by design for the live sim). So the chart had no candles for the session date, and trade markers (timestamped to that day) were clamped to the last visible bar by Lightweight Charts.
**Fix**: Fetch `getHistorical` (prior 2 days) and `getPreSession(symbol, date, '15:30:00')` (full trading day 09:15–15:30) in parallel, merge by timestamp (deduplicate + sort), call `setData` once.

### Bug #3 — Analysis chart height too small (220px fixed)
**Fix**: Height computed as `max(300, floor(containerWidth × 0.45))` via ResizeObserver — maintains ~2.2:1 aspect ratio that scales with modal width.


## Phase-V Lessons Learned

- **`getHistorical` ≠ trading day data**: The historical endpoint returns prior days only (for live-sim context). Any read-only analysis view that needs the actual session's candles must also call `getPreSession` with a late end time (e.g. `'15:30:00'`) and merge the results. This is different from the live chart, which gets the trading day candles from the SSE stream.

- **User isolation must be end-to-end**: Adding login without threading `user_id` into every DB write just adds authentication without isolation. Every service layer write must carry the caller's user_id. Using `session.user_id` (carried from session creation) for session-scoped operations, and a header dependency for non-session operations, keeps the pattern consistent.

- **FastAPI header dependency must live outside the service layer**: `get_request_user_id` belongs in `app/dependencies.py`, not `app/services/user_service.py`. Services should be pure Python — they receive `user_id` as a parameter and must not import from FastAPI. Mixing FastAPI imports into services breaks testability and violates the dependency direction.

- **Default `FIXED_USER_ID` in header dependency = zero test breakage**: Using `Header(default=FIXED_USER_ID)` means all existing tests that POST without `X-User-Id` continue to work unchanged, while production requests with a valid header get proper isolation. No test needed to be rewritten — only `_make_session()` helpers needed `session.user_id = FIXED_USER_ID` added.

- **`order.user_id` makes cancel/update/fill self-contained**: Once an `Order` object carries `user_id` at creation, `cancel_order`, `update_order`, and `check_orders` can use `order.user_id` for wallet operations without receiving `user_id` as an extra parameter. The user identity travels with the order, not the caller.

- **Analysis chart aspect ratio should scale with container**: Fixed pixel heights break on different screen sizes. Computing height as a fraction of container width (`containerWidth × 0.45`) via ResizeObserver gives a natural chart regardless of display size. The same ResizeObserver that handles width changes can apply the proportional height change via `chart.applyOptions({width, height})`.

- **Default admin credentials are the entry point for all historical data**: All sessions created before Phase V user isolation were stored under `FIXED_USER_ID = "abc12300-0000-0000-0000-000000000001"`. The seeded admin user (`admin@tradematangi.com` / `admin123`) maps to this UUID, so historical data is accessible by logging in with those credentials.

---

## Phase V Implementation Status

### ✅ COMPLETE (299 tests passing) — PR #18 merged to dev

All four spec items shipped plus full user data isolation:

1. **Login** — `POST /api/auth/login` + `POST /api/auth/register`; bcrypt hashing; `LoginScreen.tsx` auth gate; `localStorage.auth_user`; sign-out in header
2. **Trade Analysis** — `GET /api/analysis/sessions` + `GET /api/analysis/sessions/{id}`; full-screen modal with filters, aggregate stats, per-session expandable cards with trade table + embedded equity chart; chart height = `containerWidth × 0.45`
3. **Persistence** — `analysis_service.py` reads Sessions + Trades via `UserIdIndex` GSI; `pnl_pct` stored as percentage (e.g. `9.70` = 9.70%)
4. **Reload Chart** — `↻` button increments `localReloadKey`; triggers full historical re-fetch + `series.setData()`
5. **User data isolation** — `app/dependencies.py` `get_request_user_id`; `SimulationSession.user_id`; `X-User-Id` header on all authenticated requests

**Default admin**: `admin@tradematangi.com` / `admin123` (user_id = `abc12300-0000-0000-0000-000000000001`) — owns all historical sessions created before Phase V.

### Lessons Learned
- `order.user_id` makes cancel/update/fill self-contained — user identity travels with the order, not the caller
- Analysis chart aspect ratio: `containerWidth × 0.45` via ResizeObserver gives natural sizing; apply via `chart.applyOptions({width, height})`
- Default admin credentials are the entry point for all pre-Phase-V historical data
