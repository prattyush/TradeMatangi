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
`npm run build` bakes the backend URL into static files at build time. The URL must differ between dev and prod — do not hardcode either value in source.

- `frontend/.env` (dev, checked in): `VITE_API_BASE_URL=http://localhost:8700`
- `frontend/.env.production` (prod, checked in): `VITE_API_BASE_URL=` *(empty string)*
- `frontend/src/config.ts`: `const BACKEND_URL = import.meta.env.VITE_API_BASE_URL ?? ''`

Why empty string in prod: nginx on EC2 serves both the frontend (port 80) and proxies `/api/` to the backend on the same host. The browser makes requests to the same origin, so relative URLs (`/api/...`) work. A Vite dev proxy is **not** needed — in dev the absolute `localhost:8700` URL handles routing directly; in prod nginx handles it. No proxy configuration required anywhere.

---

##### UI Launch

**Phase VIII: serve frontend from EC2 nginx (no domain needed, Vercel deferred)**
nginx on EC2 serves the React `dist/` build as static files and proxies `/api/` to `localhost:8700`. Everything on the same HTTP origin — no mixed-content issue, no domain required.

Deployment steps:
1. `cd frontend && npm run build` → produces `dist/`
2. Copy `dist/` to nginx webroot (e.g. `/var/www/tradematangi/`)
3. nginx config: serve static files + `location /api/ { proxy_pass http://localhost:8700; }` + SPA fallback (`try_files $uri /index.html`)
4. Access at `http://52.66.185.106` (port 80)

Note: the `VITE_API_BASE_URL` env var introduced in Sprint 3 means switching to a different deployment (CDN, Vercel with HTTPS, etc.) later is a config-only change — no code rework.

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
- `frontend/src/config.ts`: replace hardcoded `BACKEND_URL` with `import.meta.env.VITE_API_BASE_URL ?? ''`
- `frontend/.env` (dev): `VITE_API_BASE_URL=http://localhost:8700`
- `frontend/.env.production` (prod): `VITE_API_BASE_URL=` (empty — nginx on EC2 proxies `/api/` on same origin)

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
- `GET /api/auth/me` → `{user_id, email, is_admin}` for the authenticated user
- `AuthResponse` Pydantic model gains `is_admin: bool = False` — backward-compat default

**`is_admin` flag on Users table** (`backend/app/services/user_service.py`):
- `seed_user()`: new admin record seeded with `is_admin: True`; existing record missing the field gets `update_item` backfill on startup (one-time migration)
- `login_user()`: now returns `{user_id, email, is_admin}`
- `get_user_info(user_id)`: new helper — `get_item` by `user_id`; used by `/me` and `_require_admin`

**Broker DDB token fallback:**
- `broker_service._read_breeze_credentials()`: `token_service.get_token("icici_session")` overrides `accesskeys.ini session_token`; call wrapped in `try/except` so token_service failures fall back gracefully
- `kite_service._get_kite()`: same pattern for `kite_access` → `access_token`

**Frontend changes:**
- `api.ts`: `AuthResponse.is_admin: boolean`; `AdminTokensResponse` interface; `api.getMe()`, `api.getAdminTokens()`, `api.setAdminTokens()`
- `LoginScreen.tsx`: passes `result.is_admin ?? false` as third arg to `onLogin`
- `App.tsx`: `authUser` type extended with `isAdmin: boolean`; `loadAuthUser()` defaults missing field to `false`; `handleLogin()` stores `isAdmin`; `useEffect([])` on mount calls `getMe()` to refresh from server
- `SettingsModal.tsx`: `isAdmin?: boolean` prop; collapsible ADMIN section (amber header, admin-only); `type="password"` inputs for ICICI and Kite tokens; loads masked current values via `getAdminTokens()` on first open (guarded by `useRef`); `saveAdminTokens()` sends only non-empty fields

**Test counts:** 379 backend tests passing (27 new in `test_admin_tokens.py`); TypeScript clean.

---

### Lessons Learned — Sprint 2

**Patch the importing module, not the defining module**
- `admin.py` imports `get_user_info` with `from app.services.user_service import get_user_info`. The function is bound by value at import time. Patching `app.services.user_service.get_user_info` has no effect on the reference already held in the router module.
- **Rule:** Patch at the module that holds the reference being called: `app.routers.admin.get_user_info`, not `app.services.user_service.get_user_info`. Same applies to `token_service` in router tests — patch `app.routers.admin.token_service.set_token`.

**`useRef` for one-time async loads in modals**
- The masked-token fetch should happen once when the modal first opens, not on every open. A `useRef(false)` flag (`adminLoadedRef`) gates the fetch inside `useEffect([open])`. Without it, `getAdminTokens()` fires every time the modal opens — redundant and briefly clears the displayed values on re-open.

**`isAdmin` defaulting in `loadAuthUser`**
- Old `auth_user` entries in localStorage have no `isAdmin` key. Spreading `{ isAdmin: false, ...parsed }` ensures the default is applied before the stored value, so existing sessions get `false` rather than `undefined`. The server-side `getMe()` on mount then corrects it to the real value.

**DDB token fallback must not propagate token_service errors**
- If `token_service._ensure_table()` fails (DDB not running), it logs and returns `None`. `broker_service` wraps the `get_token` call in `try/except` and falls back to `accesskeys.ini`. This keeps the broker service functional in local dev where DDB Local may not be running.

---

### 🔜 Sprint 3 — Backend Deployment Prep
### 🔜 Sprint 4 — 2-Worker nginx Sticky Sessions (optional)
