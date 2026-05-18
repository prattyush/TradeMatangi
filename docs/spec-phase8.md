#### Phase-VIII Launch

This phase covers production launch: resolving outstanding Phase VII bugs, admin token management, EC2 backend deployment, and EC2 nginx frontend serving. Vercel deployment is deferred until HTTPS is set up on the backend.

---

##### Older Bugs

**BUG-VII-1: Open order price lines missing strike filter**
- `getOrdersForPane` in App.tsx only filters by `right` (CE/PE), not by `strike`. A SELL order placed on CE 23450 shows its dashed price line on a CE 23500 pane as well.
- Root cause: backend `Order` model and `PlaceOrderRequest` have no `strike` field; frontend `Order` interface same.
- Fix:
  1. Add `strike: int | None` and `right: str | None` to backend `Order` model (`schemas.py`) and `PlaceOrderRequest`.
  2. Populate in `order_service.place_order()` from the session's `strike_ce`/`strike_pe` based on the order's `right` field.
  3. Add `strike?: number | null` and `right?: string | null` to frontend `Order` interface (`api.ts`).
  4. Update `getOrdersForPane` in App.tsx: for options panes, add `&& o.strike === pane.strike` to the filter.
  5. Old orders with `strike=null` safely fall through (backward-compat with existing DDB records).
- Also: merge `fix/marker-strike-filter` branch (3 commits: trade marker strike+right fix, BUG-VII-1 docs, spec update) to dev first.

---

##### Admin Mode

**1. Admin user verification**
`admin@tradematangi.com` / `admin123` already exists as `FIXED_USER_ID = "abc12300-0000-0000-0000-000000000001"`. Verify an `is_admin` flag is set in the Users DynamoDB table. If absent, seed it via a one-time migration.

**2. Admin-only broker token settings**
- Add an "Admin" collapsible section to `SettingsModal.tsx`, visible only when the logged-in user has `is_admin = true`.
  - Add `isAdmin: boolean` to the frontend auth state, populated from `GET /api/auth/me` response.
- Inputs: ICICI session_token (password-masked) and KITE access_token (password-masked). Both rotate daily and must be set by the admin each morning.
- Save via `PUT /api/admin/tokens` (admin-only endpoint, returns 403 for non-admin).
- Read current saved values via `GET /api/admin/tokens` (admin-only); show only last 4 chars for security.

**3. Token storage in DynamoDB**
- New `BrokerTokens` DynamoDB table: `pk = "config"`, `sk = "icici_session" | "kite_access"`, `value = <token>`, `updated_at = <iso-timestamp>`.
- `broker_service._get_breeze()` and `kite_service._get_kite()` read the token from DDB first, falling back to `accesskeys.ini` when the DDB entry is absent.
- No encryption needed — tokens rotate every session (daily).

**4. API keys / secrets decision**
Leave `api_key`, `api_secret`, and `breeze_api_key`/`breeze_secret_key` in `accesskeys.ini` on the EC2 filesystem. They change rarely and moving them to DDB would require AWS KMS encryption (unnecessary complexity). Only the daily-rotating session tokens need the DDB admin path.

---

##### Link To Backend

**1. 2-core deployment analysis**
With `--workers 2`, in-memory state is per-process and will break:
- `simulation._sessions` — session created on worker A is not visible on worker B; SSE stream and tick loop are pinned to A.
- `order_service._orders` — worker B cannot find orders placed via worker A.
- `KiteBroadcaster` singleton — two independent WebSocket connections; duplicate subscriptions, split fan-out.
- Strategy registry — DDB cross-process cancel works, but session lookup still fails on the wrong worker.

**`--workers 2` breaks core features — use `--workers 1`**

With 2 workers, each is a separate OS process with its own memory. The OS distributes requests across both with no stickiness guarantee. Concretely:
- `session.queue` (SSE stream), `_sessions`, `_orders`, `KiteBroadcaster` are all per-process
- A session created on worker A fails with 404 on worker B for pause/resume/stop/order/SSE
- `KiteBroadcaster` creates 2 independent WebSocket connections; paper session ticks are split across processes
- Strategy cancel-all on worker B clears B's empty registry; A's strategies keep running

The workload is I/O-bound (Kite WebSocket, Breeze REST, SSE). A single asyncio event loop handles hundreds of concurrent sessions across both CPU cores via OS scheduling — no second worker needed.

If future load requires scaling out, the correct approach is nginx sticky sessions (route by `X-Session-Id`) so each session's lifecycle stays on one worker.

**2. Updated EC2 start script**
`scripts/start-backend-ec2.sh`: use `uvicorn app.main:app --host 0.0.0.0 --port 8700 --workers 1 --loop uvloop`. Add `uvloop` to `requirements.txt` for async performance on Linux.

**3. Frontend API URL: Vite environment variables**
`npm run build` bakes the backend URL into static files at build time — it must differ between dev and prod without requiring a source edit.

- `frontend/.env` (dev, checked in): `VITE_API_BASE_URL=http://localhost:8700`
- `frontend/.env.production` (prod, checked in): `VITE_API_BASE_URL=` *(empty string)*
- `frontend/src/config.ts`: `const BACKEND_URL = import.meta.env.VITE_API_BASE_URL ?? ''`

Why empty string in prod: nginx on EC2 serves the frontend (port 80) and proxies `/api/` to the backend on the same host. The browser makes requests to the same origin, so relative URLs work. **A Vite dev proxy is not needed** — in dev the absolute `http://localhost:8700` URL routes directly; in prod nginx handles it.

---

##### UI Launch

**Phase VIII: serve frontend from EC2 nginx (no domain needed, Vercel deferred)**
nginx on EC2 serves the React `dist/` build as static files and proxies `/api/` to `localhost:8700`. Everything on the same HTTP origin — no mixed-content issue, no domain required.

Deployment steps:
1. `cd frontend && npm run build` → produces `dist/`
2. Copy `dist/` to nginx webroot (e.g. `/var/www/tradematangi/`)
3. nginx config: serve static files + `location /api/ { proxy_pass http://localhost:8700; }` + SPA fallback (`try_files $uri /index.html`)
4. Access at `http://52.66.185.106` (port 80)

Note: the `VITE_API_BASE_URL` env var introduced in Sprint 3 means switching to a different deployment target later is a config-only change — no code rework.

**Vercel deferred** — requires HTTPS on the backend (nginx + certbot + domain name). Revisit in a future phase once EC2 deployment is stable.

---

## Phase VIII Implementation Plan

### Sprint 1 — Bug Fixes + Logging + Config Paths
- Merge `fix/marker-strike-filter` to dev (cherry-pick 116c4f3, cae3a98, b441b75)
- Fix BUG-VII-1: add `strike`/`right` to backend `Order` + frontend interface; update `getOrdersForPane`
- Daily rotating log files (one per day, 30-day retention) via `TimedRotatingFileHandler`
- Configurable `ohlcdata` and `logs` paths from `accesskeys.ini [paths]` section

### Sprint 2 — Admin Token Management
- Seed `is_admin = true` on admin user in Users table; expose on `/api/auth/me`
- `BrokerTokens` DDB table + `GET/PUT /api/admin/tokens` endpoints
- Admin section in SettingsModal (gated by `isAdmin`)
- `broker_service` + `kite_service` read tokens from DDB with `accesskeys.ini` fallback

### Sprint 3 — Backend Deployment Prep
- `uvloop` in `requirements.txt`
- `scripts/start-backend-ec2.sh`: `uvicorn app.main:app --host 0.0.0.0 --port 8700 --workers 1 --loop uvloop`
- `frontend/src/config.ts`: `const BACKEND_URL = import.meta.env.VITE_API_BASE_URL ?? ''`
- `frontend/.env` (dev): `VITE_API_BASE_URL=http://localhost:8700`
- `frontend/.env.production` (prod): `VITE_API_BASE_URL=` (empty — nginx proxies `/api/` on same EC2 host)

### Sprint 4 — 2-Worker Support via nginx Sticky Sessions *(optional — do after Sprint 1–3 deployed and tested)*
- nginx config: `map $uri $session_key` extracts `session_id` from `/api/stream/{id}` and `/api/simulation/{id}/...` paths; falls back to `X-Session-Id` header for orders/strategies
- `upstream backend` with `hash $session_key consistent` across two uvicorn instances on ports 8701/8702
- `scripts/start-backend-ec2.sh`: launch 2 separate uvicorn processes on 8701/8702 (nginx listens on 8700/80); replace single `--workers 1` launch
- `api.ts`: thread `X-Session-Id` header through all session-scoped requests (orders, strategies, simulation control) using `sim.sessionId` — ~10 call sites; initial `POST /api/simulation/start` needs no header (session not yet known)
- No FastAPI code changes required

---

## Phase VIII Implementation Status

### Sprint 1 — Bug Fixes + Logging + Config Paths ✅ Complete (PR #27, merged to main 2026-05-17)

**Trade marker strike filter** (from `fix/marker-strike-filter`):
- `getTradesForPane` in App.tsx: `t.right === pane.right && t.strike === pane.strike`
- `paneTrades` filter in Chart.tsx: same guard; prevents old strike markers showing on replaced pane

**BUG-VII-1 — Open order price lines missing strike filter:**
- `backend/app/models/schemas.py`: `Order` and `PlaceOrderRequest` gain `strike: int | None = None`
- `backend/app/services/order_service.py`: `place_order()` accepts `strike`; `_write_order_to_db` persists to DDB
- `backend/app/routers/orders.py`: resolves `order_strike` from `session.strike_ce` (CE) or `session.strike_pe` (PE); passes to `place_order()`
- `frontend/src/services/api.ts`: `Order.strike?: number | null`
- `frontend/src/App.tsx`: `getOrdersForPane` filters `o.strike == null || o.strike === pane.strike` — null orders pass through for backward-compat

**Daily rotating logs:**
- `backend/app/main.py`: replaced `RotatingFileHandler` (5 MB size-based) with `TimedRotatingFileHandler(when='midnight', backupCount=30)` — rotated files named `backend.log.YYYY-MM-DD`; 30 days retained

**Configurable data paths from `accesskeys.ini [paths]`:**
- `backend/app/config.py`: reads `[paths]` section at startup; exports `OHLCDATA_DIR` and `LOG_DIR` with `DATA_DIR/ohlcdata` and `DATA_DIR/logs` as fallbacks
- `data_loader.py`, `options_service.py`, `kite_service.py`: import `OHLCDATA_DIR` directly
- `main.py`: imports `LOG_DIR` for log file location
- Tests: patched `OHLCDATA_DIR` (not `DATA_DIR`) in all parquet-path isolation tests

**Test counts:** 350 backend tests passing; TypeScript clean.

---

### Lessons Learned — Sprint 1

**Test isolation must track the right symbol, not its ancestor**
- Services now import `OHLCDATA_DIR` at module load time from `config.py`. Tests that patched `DATA_DIR` in the service module were silently passing because the parquet file didn't exist — they fell through to pickle. Once `OHLCDATA_DIR` was a separate module-level name, the fallback stopped working and the configured real path (with actual parquet files) was used, corrupting test data.
- **Rule:** When a service module exports a derived path constant (e.g. `OHLCDATA_DIR`), tests must patch that constant directly — not the upstream variable it was derived from.

**Backward-compat null guard for new DB fields**
- Adding `strike` to `Order` meant old DynamoDB records had no `strike` attribute. Frontend `o.strike` would be `undefined`, not `null`. Using `o.strike == null` (loose equality) in the filter catches both `undefined` and `null`, making old records fall through safely without a migration.

**`configparser` for per-deployment path overrides is low-friction**
- Rather than adding another env var or a separate config file format, reading `[paths]` from the existing `accesskeys.ini` means a single file controls all deployment-specific values (credentials + paths). Deploying on a new machine only requires editing one file.

---

### Sprint 2 — Admin Token Management ✅ Complete (PR #29, merged to dev 2026-05-17)

**`BrokerTokens` DynamoDB table** (`backend/app/services/token_service.py`):
- Schema: `pk="config"` (HASH), `sk="icici_session"|"kite_access"` (RANGE), `value=<token>`, `updated_at=<iso-ts>`
- `_ensure_table()`: creates table lazily on first access (idempotent)
- `get_token(sk)`: returns full value or `None` if not set
- `set_token(sk, value)`: writes with UTC `updated_at` timestamp
- `get_tokens_masked()`: returns last 4 chars visible, rest redacted with `*`

**Admin endpoints** (`backend/app/routers/admin.py`):
- `GET /api/admin/tokens` — returns masked `{icici_session, kite_access}`; 403 for non-admin
- `PUT /api/admin/tokens` — body `{icici_session?, kite_access?}`; only non-null fields written; returns masked values; 403 for non-admin
- `_require_admin` FastAPI dependency: calls `get_user_info(user_id)` → checks `is_admin` field → 403 if absent or false

**User profile endpoint** (`backend/app/routers/auth.py`):
- `GET /api/auth/me` → `{user_id, email, is_admin}` for the authenticated user (uses `X-User-Id` header)
- `AuthResponse` Pydantic model gains `is_admin: bool = False` — backward-compat default

**`is_admin` flag on Users table** (`backend/app/services/user_service.py`):
- `seed_user()`: new admin record seeded with `is_admin: True`; existing record missing the field gets `update_item` backfill on startup (one-time migration, runs every restart until field present)
- `login_user()`: now returns `{user_id, email, is_admin}` instead of just `{user_id, email}`
- `get_user_info(user_id)`: new helper — `get_item` by `user_id`; used by `/me` endpoint and `_require_admin`

**Broker DDB token fallback:**
- `broker_service._read_breeze_credentials()`: calls `token_service.get_token("icici_session")`; if non-empty, uses it as `session_token` instead of `accesskeys.ini` value; entire call wrapped in `try/except` so token_service failures fall back gracefully
- `kite_service._get_kite()`: same pattern for `kite_access` → `access_token`

**Frontend changes:**
- `api.ts`: `AuthResponse.is_admin: boolean`; `AdminTokensResponse` interface; `api.getMe()`, `api.getAdminTokens()`, `api.setAdminTokens()`
- `LoginScreen.tsx`: passes `result.is_admin ?? false` as third arg to `onLogin`
- `App.tsx`: `authUser` type extended with `isAdmin: boolean`; `loadAuthUser()` defaults missing field to `false`; `handleLogin()` stores `isAdmin`; `useEffect([])` on mount calls `getMe()` to refresh `isAdmin` from server (handles stale localStorage after role change)
- `SettingsModal.tsx`: `isAdmin?: boolean` prop; collapsible ADMIN section rendered only when `isAdmin=true`; amber header colour to distinguish from other sections; two `type="password"` inputs for ICICI and Kite tokens; on open loads masked current values via `getAdminTokens()` (guarded by `useRef` to avoid re-fetching on every modal open); `saveAdminTokens()` calls `setAdminTokens` with only non-empty fields

**Test counts:** 379 backend tests passing (27 new in `test_admin_tokens.py`); TypeScript clean.

---

### Lessons Learned — Sprint 2

**Patch the importing module, not the defining module**
- `admin.py` and `auth.py` import `get_user_info` with `from app.services.user_service import get_user_info`. The function is bound by value at import time. Tests that patched `app.services.user_service.get_user_info` had no effect on the already-bound reference in the router — the real DynamoDB call ran instead.
- **Rule:** Always patch at the module that holds the reference being called: `app.routers.admin.get_user_info`, not `app.services.user_service.get_user_info`. Same applies to `token_service` in admin router tests — patch `app.routers.admin.token_service.set_token` (the module attribute), not `app.services.token_service.set_token`.

**`useRef` for one-time async loads in modals**
- The admin masked-token fetch should happen once when the modal first opens, not on every open. A `useRef(false)` flag (`adminLoadedRef`) gates the fetch inside the `useEffect([open])`. Without it, the `getAdminTokens()` call would fire every time the modal was opened — redundant and briefly clears the displayed values on re-open.

**`is_admin` defaulting in `loadAuthUser`**
- Old `auth_user` entries in localStorage have no `isAdmin` key. Spreading `{ isAdmin: false, ...parsed }` ensures the default is applied before the stored value, so existing sessions get `false` rather than `undefined`. The server-side `getMe()` call on mount then corrects it to the real value.

**DDB token fallback must not propagate token_service errors**
- If `token_service._ensure_table()` fails (DDB not running, wrong creds), it logs and returns `None`. The caller in `broker_service` wraps the `get_token` call in `try/except` and falls back to `accesskeys.ini`. This keeps the broker service functional even when the admin token path is broken — important for local dev where DDB Local may not be running.

---

### Sprint 3 — Backend Deployment Prep ✅ Complete (PR #33, branch docs/phase-viii-sprint-3-design, 2026-05-18)

**Changes:**
- `uvloop>=0.19.0` added to `backend/requirements.txt`
- `scripts/start-backend-ec2.sh`: `--workers 1 --loop uvloop` (single worker required; in-memory state breaks multi-worker)
- `frontend/src/config.ts`: `export const BACKEND_URL = import.meta.env.VITE_API_BASE_URL ?? ''`
- `frontend/src/vite-env.d.ts`: new — declares `ImportMetaEnv` so TypeScript accepts `import.meta.env`
- `frontend/.env`: `VITE_API_BASE_URL=http://localhost:8700` (dev, committed via `!frontend/.env` gitignore negation)
- `frontend/.env.production`: `VITE_API_BASE_URL=` empty — nginx on EC2 proxies `/api/` same-origin
- `.gitignore`: `!frontend/.env` negation so non-secret dev URL is committed

---

### Bugs Fixed Post-Sprint-2 (2026-05-18)

#### BUG-VIII-1: Admin user DynamoDB record corrupted from early phase

**Symptom:** Login with `admin@tradematangi.com` / `admin123` returned "Invalid email or password."

**Root cause:** The admin record in DynamoDB was written in an early phase before proper auth existed:
- `password_hash` field contained plain text `"abc123"` (not bcrypt)
- Record had `username` field instead of `email`
- `seed_user()` skips re-seeding when the `user_id` already exists, so the corrupt record persisted

**Fix:** One-time manual DynamoDB update via Python to set `email = "admin@tradematangi.com"` and `password_hash = bcrypt("admin123")`. No code change — `seed_user()` logic remains correct for new deployments.

---

#### BUG-VIII-2: Paper trading options streaming stops when pane is added/removed with different strike

**Symptom:** Deleting a CE/PE pane and adding it back with a different strike caused all chart streaming (including equity) to stop. In simulation mode, streaming resumed after pane data loaded; in paper mode it did not.

**Root cause — event loop freeze:**
`update_pane_strike` (async endpoint) called `_ensure_options_data` and `fetch_options_instrument_token` as synchronous blocking calls. For paper mode, `_ensure_options_data` fetches today's Breeze data (~10–30s). This froze the asyncio event loop, blocking Phase 3 from processing Kite ticks. In simulation mode the same freeze occurred but the tick loop is driven from pre-loaded in-memory data so it resumed immediately. In paper mode Phase 3 depends on the Kite WebSocket and can be stuck at a 30s timeout.

**Root cause — Kite reconnect storms:**
`_on_error` scheduled a new `threading.Timer` on every 403 error. kiteconnect retries rapidly, so dozens of restart timers piled up. Each timer called `_restart_with_fresh_creds` which closed and replaced the ticker. When the user stopped the old session and started a new one, a stale timer from the old session's 403 errors fired after the new session had already registered and created a healthy new ticker — closing it and breaking the new session.

**Fixes:**
- `routers/simulation.py` — `update_pane_strike`: wraps `_ensure_options_data` in `loop.run_in_executor` (thread pool). For paper mode uses `_soft_ensure` wrapper so data errors don't fail the live session. `fetch_options_instrument_token` also moved to executor.
- `kite_service.py` — `KiteBroadcaster`:
  - `_restart_pending: bool` flag: only one restart timer in flight at a time; `_on_error` returns early if already scheduled.
  - `_restart_generation: int` counter: bumped in `_start` and `unregister` (when closing last session's ticker). `_restart_with_fresh_creds(gen)` compares `gen` to current generation and no-ops if stale — prevents old timers from closing a new session's healthy ticker.
  - `_read_config`: reads DDB token_service first (same pattern as `_get_kite`), so updating the Kite token in Admin settings takes effect on the next reconnect attempt.
  - `_notify_sessions_error`: pushes `{"type": "broker_error", "message": ...}` dict to every registered session's `paper_tick_queue`.
  - `_on_close`: calls `_notify_sessions_error` so frontend shows the orange broker error banner.
- `simulation.py` (service) — Phase 3 loop: handles `broker_error` type from `paper_tick_queue` by forwarding to `session.queue` as JSON for SSE delivery.

---

#### BUG-VIII-3: Wallet reset not persisting across page refresh / backend restart

**Symptom:** Setting wallet to ₹12,000 via Settings showed correctly, but after page refresh reverted to ₹1,50,000.

**Root cause:** `wallet_service._load_from_db` queries DynamoDB with `Key("date").lt(date)` — strictly less than. When `reset()` writes a record for today's date, a subsequent cold-start of `get_or_init_wallet` (empty in-memory cache) skips today's own record because `today < today` is false. It falls back to carry-forward from the previous day or to `DEFAULT_BALANCE = 150,000`.

**Fix:** Changed `Key("date").lt(date)` → `Key("date").lte(date)` in `_load_from_db`. With `ScanIndexForward=False, Limit=1`, today's own record is returned first (most recent), correctly restoring the reset value. All 14 wallet tests pass.

---

#### BUG-VIII-4: Paper trading options chart shows flat bars after refresh (2026-05-18)

**Symptom:** On first render, CE/PE options chart data was correct up to ~10:39, then bars from 10:42 to 10:51 appeared flat at 10:39's close price. On page refresh at 11:24, all bars from 10:39 to 11:24 were flat at 10:39's close, wiping out correctly-streamed data.

**Root cause — backend gap-fill writes fake future bars to parquet:**
`_validate_options_gaps` always reindexed from `market_open` to `market_close` (15:29:59), regardless of whether it was today's partial day. For paper trading, Breeze fetches data up to the last completed second (e.g., 10:39). The ffill from 10:39 to 15:30 created fake flat bars that were **saved into the parquet file**.

**Root cause — frontend cutoffTs includes the flat bars:**
On refresh, `cutoffTs = currentSimTimeRef.current` (live equity tick time, e.g., 11:24). The historical API returns candles filtered to `time < 11:24`, which includes all the flat 10:39-priced bars. `series.setData()` overwrites correctly-streamed bars with these imposters.

**Fix** (`backend/app/services/options_service.py`):
- `_validate_options_gaps(partial=False)`: added `partial` parameter. When `partial=True`, reindex stops at `df.index[-1]` (last actual Breeze row) instead of `market_close` — no fake future bars saved to parquet.
- `fetch_options_historical`: passes `partial=is_today` to gap-fill; adds **10-min TTL re-fetch** for today's parquet (mirroring equity's `_TODAY_CACHE_TTL`). Stale partial cache used as fallback if Breeze is temporarily unavailable.
- 5 new tests: `test_partial_stops_at_last_row`, `test_partial_no_flat_future_bars`, `test_non_partial_still_fills_full_day`, `test_today_partial_saved_without_future_bars`, `test_today_stale_cache_refetches`.

**Result:** On refresh, historical shows correct Breeze data up to last fetch (within 10 min), then live ticks fill in from current time. No flat-bar region.

---

#### BUG-VIII-5: Trade markers (buy/sell circles) missing in paper trading options (2026-05-18)

**Symptom:** Buy/sell execution markers appeared correctly in simulation trading (when using the TradePanel direct buttons) but were absent in paper trading options charts (where limit orders are the natural workflow).

**Root cause:** In `_emit_tick_and_check_orders` (simulation.py), filled orders were recorded with `strike=session.strike` — the base ATM strike — not the order's actual per-right strike. The `Order` model already carries `order.strike` correctly set at placement time (via `orders.py:_strike_for_right`: `session.strike_ce` for CE, `session.strike_pe` for PE). But the fill path ignored it.

The frontend marker filter is strict equality: `t.strike === pane.strike`. The pane's strike is `session.strike_ce` or `session.strike_pe`. For OTM sessions (`strike_ce ≠ session.strike`), the mismatch caused all trades to be filtered out.

**Why simulation appeared to work:** Simulation users typically used the TradePanel's direct BUY/SELL buttons, which call `api.buy()`/`api.sell()` → `_strike_for_right()` → correct strike. Paper trading users place limit/SL orders via the order panel, which fill through `_emit_tick_and_check_orders` — where the bug lived.

**Fix** (`backend/app/services/simulation.py`): One-line change in `_emit_tick_and_check_orders`:
```python
strike=order.strike if order.strike is not None else session.strike,
```
`order.strike` is always populated for orders placed since Sprint 1; fallback to `session.strike` handles any pre-existing DDB orders.

---

#### BUG-VIII-6: SELL stoploss fill not crediting wallet (2026-05-18)

**Symptom:** After buying shares and closing via a stoploss SELL order, the wallet showed the BUY debit but not the SELL credit — funds were permanently removed even after fully exiting the position.

**Root cause:** In `order_service.check_orders`, the wallet credit for SELL fills was gated on `not order.is_stoploss`. Since `OrderPanel.tsx` sends `is_stoploss=True` for all SL-tab orders, this condition was always false — sale proceeds were never returned.

The original design said "SL orders have zero wallet impact" which is correct for *placement* (no upfront debit for SELL SL) and *cancel* (nothing to refund), but wrong for *fill* — a SELL always returns cash regardless of order type.

**Fix** (`backend/app/services/order_service.py`): Removed `not order.is_stoploss` guard from the SELL credit condition:
```python
# Before (wrong): credited only if not is_stoploss
if order.side == TradeSide.SELL and trading_date and not order.is_stoploss:
# After (correct): all SELL fills credit the wallet
if order.side == TradeSide.SELL and trading_date:
```
Updated CLAUDE.md wallet coverage constraint. Corrected the pre-existing test `test_sell_sl_fill_does_not_credit_wallet` (which asserted the wrong behaviour) and added 3 regression tests in `TestSLWalletCredit`.

---

### Lessons Learned — Post-Sprint Bugs (BUG-VIII-4 to BUG-VIII-6)

**Partial vs full-day gap-fill must be mode-aware**
- For past dates, filling a full day with ffill is correct — options don't always trade every second.
- For today's date (paper trading), ffill to market_close writes fake future bars that corrupt the historical display after refresh. The partial pattern from equity's `validate_and_fill_gaps(partial=True)` should have been applied to options from the start.
- **Rule:** Any parquet written for today's date must stop gap-fill at the last actual data row. Mirror the TTL + partial pattern from `broker_service.fetch_historical` in every data-fetch service.

**Order fill path must use order-level fields, not session-level fields**
- `Order.strike` was added in Sprint 1 specifically to support per-right strikes. The fill path in `_emit_tick_and_check_orders` was the only place that still used `session.strike` (a session-level aggregate). This created a split: direct TradePanel trades used `_strike_for_right()` correctly; order-fill trades silently used the wrong strike.
- **Rule:** When recording a trade from a filled order, always use order-level fields (`order.strike`, `order.right`) rather than re-deriving from the session. The order was placed with exact values; the session aggregate is lossy.

**Wallet credit/debit rules must be symmetric around position lifecycle**
- A BUY that debits the wallet must be paired with a SELL that credits — regardless of the SELL's mechanism (LIMIT, TARGET, STOPLOSS). The original "SL = zero wallet impact" rule was designed for placement and cancel (correct) but was incorrectly extended to fill (wrong).
- **Rule:** Any order that exits a position by selling an asset must credit the wallet. The `is_stoploss` flag controls debit-on-placement and refund-on-cancel only. Never use it to suppress a fill credit.

---

### 🔜 Sprint 4 — 2-Worker nginx Sticky Sessions (optional)
