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

**3. Backend IP: use Vite environment variables**
Do **not** hardcode the IP in React source files. Use Vite env vars so dev vs prod is automatic:
- `frontend/.env` (checked in, dev): `VITE_API_BASE_URL=http://localhost:8700`
- `frontend/.env.production` (checked in, prod): `VITE_API_BASE_URL=http://52.66.185.106:8700`
- `api.ts`: replace the hardcoded base URL with `const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8700'`.
- Override per-deployment via env file or CI without touching code.

---

##### UI Launch

**Phase VIII: serve frontend from EC2 nginx (no domain needed, Vercel deferred)**
nginx on EC2 serves the React `dist/` build as static files and proxies `/api/` to `localhost:8700`. Everything on the same HTTP origin — no mixed-content issue, no domain required.

Deployment steps:
1. `cd frontend && npm run build` → produces `dist/`
2. Copy `dist/` to nginx webroot (e.g. `/var/www/tradematangi/`)
3. nginx config: serve static files + `location /api/ { proxy_pass http://localhost:8700; }` + SPA fallback (`try_files $uri /index.html`)
4. Access at `http://52.66.185.106` (port 80)

Note: the `VITE_API_BASE_URL` env var introduced in Sprint 3 means switching to Vercel later (once HTTPS is set up) is just a config change — no code rework.

**Vercel deferred** — requires HTTPS on the backend (nginx + certbot + domain name). Revisit in a future phase once EC2 deployment is stable.

---

## Phase VIII Implementation Plan

### Sprint 1 — Bug Fixes
- Merge `fix/marker-strike-filter` to dev (cherry-pick 116c4f3, cae3a98, b441b75)
- Fix BUG-VII-1: add `strike`/`right` to backend `Order` + frontend interface; update `getOrdersForPane`

### Sprint 2 — Admin Token Management
- Seed `is_admin = true` on admin user in Users table; expose on `/api/auth/me`
- `BrokerTokens` DDB table + `GET/PUT /api/admin/tokens` endpoints
- Admin section in SettingsModal (gated by `isAdmin`)
- `broker_service` + `kite_service` read tokens from DDB with `accesskeys.ini` fallback

### Sprint 3 — Backend Deployment Prep
- `scripts/start-backend-ec2.sh`: `--workers 1 --loop uvloop`
- `uvloop` in `requirements.txt`
- `api.ts` + `frontend/.env` + `frontend/.env.production`: Vite env var `VITE_API_BASE_URL`

### Sprint 4 — 2-Worker Support via nginx Sticky Sessions *(optional — do after Sprint 1–3 deployed and tested)*
- nginx config: `map $uri $session_key` extracts `session_id` from `/api/stream/{id}` and `/api/simulation/{id}/...` paths; falls back to `X-Session-Id` header for orders/strategies
- `upstream backend` with `hash $session_key consistent` across two uvicorn instances on ports 8701/8702
- `scripts/start-backend-ec2.sh`: launch 2 separate uvicorn processes on 8701/8702 (nginx listens on 8700/80); replace single `--workers 1` launch
- `api.ts`: thread `X-Session-Id` header through all session-scoped requests (orders, strategies, simulation control) using `sim.sessionId` — ~10 call sites; initial `POST /api/simulation/start` needs no header (session not yet known)
- No FastAPI code changes required

---

## Phase VIII Implementation Status

### Sprint 1 — Bug Fixes ✅ Complete

- Trade marker strike filter applied (commits from `fix/marker-strike-filter`):
  - `getTradesForPane` in App.tsx: added `&& t.strike === pane.strike`
  - `paneTrades` filter in Chart.tsx: added `&& t.strike === strike`
- BUG-VII-1 fixed:
  - `backend/app/models/schemas.py`: `Order` and `PlaceOrderRequest` both have `strike: int | None = None`
  - `backend/app/services/order_service.py`: `place_order()` accepts `strike`; `_write_order_to_db` persists it
  - `backend/app/routers/orders.py`: resolves `order_strike` from `session.strike_ce`/`strike_pe` and passes to `place_order()`
  - `frontend/src/services/api.ts`: `Order.strike?: number | null`
  - `frontend/src/App.tsx`: `getOrdersForPane` filters `o.strike == null || o.strike === pane.strike` for options panes

### 🔜 Sprint 2–4 — Not started
