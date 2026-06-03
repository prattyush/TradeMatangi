# Trade Matangi — Backend Architecture

---

## Overview

The backend is a **FastAPI** application running at **port 8700**. It serves three session types simultaneously — historical simulation, paper trading (live data, simulated orders), and real trading (live data, broker orders). All three modes share the same tick loop, order evaluation, and SSE delivery code paths; the session type controls only how ticks are sourced and where orders are routed.

Key design invariants:
- All trading logic is in-process and in-memory for the hot path — no external queues.
- One `asyncio.Queue` + `asyncio.Event` per session drives tick delivery, pause/resume, and SSE.
- DynamoDB Local (Docker port 8000) is the persistence layer; schema is forward-compatible with AWS DynamoDB.
- OHLC data lives on disk as parquet (preferred) or legacy pickle files under `OHLCDATA_DIR`.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Frontend (port 5173 / Vite)                                          │
│  React + TypeScript + Lightweight Charts                              │
└───────────┬──────────────────────────────────────────────────────────┘
            │  REST (JSON)  │  SSE (text/event-stream)
            ▼               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Backend (port 8700) — FastAPI / uvicorn                              │
│                                                                       │
│  13 routers (simulation, stream, trading, orders, data, strategies,   │
│  guardrails, analysis, auth, wallet, admin, kotak, users)            │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  session loop (asyncio task per session)                        │ │
│  │  tick → _emit_tick_and_check_orders()                          │ │
│  │       → order_service.check_orders()                           │ │
│  │       → strategy_service.on_tick()                             │ │
│  │       → _check_and_schedule_ai_hook()  ──► POST :8701/hook/... │ │
│  │       → session.queue.put(tick_json)                           │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  SSE endpoint reads session.queue → StreamingResponse                │
└─────────────┬────────────────────────────────────────────────────────┘
              │  boto3
              ▼
        DynamoDB Local (port 8000)
        Sessions, Trades, Orders, Wallets, Users, UserSettings,
        Strategies, GuardRailSettings, Tokens, RealTradingWhitelist

              ▲  live ticks (websocket)
              │
        KiteBroadcaster / KotakBroadcaster
        (paper + real sessions subscribe; sim replays from disk)
```

---

## Session Types

| Type | Tick Source | Order Execution | Use Case |
|------|-------------|-----------------|----------|
| `sim` | Parquet/pickle replay (`iter_ticks`) | Simulated fill at trigger/limit price | Historical replay |
| `paper` | KiteBroadcaster (Zerodha WS) | Simulated fill (wallet deducted) | Practice with live data |
| `real` | KiteBroadcaster or KotakBroadcaster | Kotak Neo broker API | Live trading |

---

## Session Lifecycle

```
POST /api/simulation/start
        │
        ├── validate request, load data file, compute session_capital from wallet
        ├── create SimulationSession (asyncio.Queue, asyncio.Event, per-session state)
        ├── _sessions[session_id] = session
        ├── fire asyncio.create_task(_run_session | _run_paper_session | _run_real_session)
        └── return {session_id, ...}

Session loop (sim):
        for tick in iter_ticks(symbol, date, start_time, speed):
            await asyncio.sleep(interval / speed)
            if paused: await event.wait()
            _emit_tick_and_check_orders(session, tick)

Session loop (paper/real) — two phases:
        Phase 1 (replay): fast-replay Breeze historical data at asyncio.sleep(0.001)
        Phase 2 (live):   subscribe to KiteBroadcaster; await session.paper_tick_queue.get()
        Both phases call _emit_tick_and_check_orders() on each tick

_emit_tick_and_check_orders():
        ├── session.queue.put(tick_json)              → SSE delivery
        ├── order_service.check_orders(session, tick) → fill pending orders
        ├── strategy_service.on_tick(session, tick)   → AutoStop/BreakEven/etc.
        └── _check_and_schedule_ai_hook(session, tick)

stop_session():
        ├── cancel asyncio task
        ├── unsubscribe from KiteBroadcaster / KotakBroadcaster
        ├── strategy_service.cancel_all(session_id)
        ├── session.queue.put({"type":"session_ended"})
        └── await POST :8701/hook/session/{id}/stop   ← synchronous, 2s timeout
```

---

## Routers

| File | Prefix | Key Endpoints |
|------|--------|---------------|
| `routers/simulation.py` | `/api/simulation` | `POST /start`, `/stop`, `/pause`, `/resume`, `PUT /{id}/update-pane-strike`, `POST /ai/commands/active` |
| `routers/stream.py` | `/api/stream` | `GET /{session_id}` — SSE endpoint |
| `routers/trading.py` | `/api/trades` | `POST /buy`, `POST /sell`, `GET /position`, `GET /by-context` |
| `routers/orders.py` | `/api/orders` | `POST /` (place), `PATCH /{id}`, `DELETE /{id}`, `GET /` |
| `routers/data.py` | `/api/data` | `/historical`, `/options-historical`, `/pre-session`, `/symbols`, `/available-dates`, `/price-at`, `/expiry` |
| `routers/strategies.py` | `/api/strategies` | `POST /start`, `POST /cancel-all`, `GET /` |
| `routers/guardrails.py` | `/api/guardrails` | `POST /block`, `GET /status`, `GET /settings`, `POST /settings` |
| `routers/analysis.py` | `/api/analysis` | `GET /sessions`, `GET /sessions/{id}`, `GET /trades`, `GET /ohlc-context` |
| `routers/auth.py` | `/api/auth` | `POST /login`, `/register`, `/change-password`, `GET /me` |
| `routers/wallet.py` | `/api/wallet` | `GET /`, `POST /reset` |
| `routers/admin.py` | `/api/admin` | Tokens, whitelist, stream-source toggle |
| `routers/kotak.py` | `/api/kotak` | Login, status, funds, order-history, reconcile |
| `routers/users.py` | `/api/users` | `GET /settings`, `PUT /settings` |

---

## Service Layer

| File | Responsibility |
|------|----------------|
| `services/simulation.py` | Session registry, tick loops (sim/paper/real), `_emit_tick_and_check_orders`, AI hook firing, `stop_session` |
| `services/trading_service.py` | `buy`, `sell`, `get_position`, `record_trade` — position tracking and trade persistence |
| `services/order_service.py` | `check_orders` (called every tick) — fills PENDING orders when price crosses trigger/limit; emits `order_filled` SSE |
| `services/strategy_service.py` | Four automated strategies (AutoStop, BreakEven, AggressiveStoploss, TargetProfit); `on_tick` called each tick |
| `services/data_loader.py` | Loads parquet/pickle OHLC files; applies IST-as-UTC timestamp trick; `iter_ticks` generator |
| `services/options_service.py` | Fetches and caches options chain parquet from Breeze; row-count guard for partial files |
| `services/guardrail_service.py` | BLOCK/COOLDOWN/BAN logic; snapshotted onto session at start; checks on each trade |
| `services/wallet_service.py` | DynamoDB Wallets table — balance read/debit/credit/reset |
| `services/user_settings_service.py` | DynamoDB UserSettings — 13 per-user preferences including `analysis_price_source` |
| `services/db.py` | boto3 DynamoDB resource factory; reads `accesskeys.ini [aws]`; switches between Local and AWS |
| `services/kite_service.py` | Zerodha Kite websocket; `KiteBroadcaster` fan-out to all paper/real sessions |
| `services/kotak_service.py` | Kotak Neo REST/WS; `KotakBroadcaster`; reconcile loop for fill detection |

---

## Strategy Types

| Strategy | Trigger | Action |
|----------|---------|--------|
| `AutoStop` | Each bar close | Places a TARGET entry order at `bar.close ± deviation_pct` |
| `BreakEven` | Each tick | Moves stoploss to avg_entry_price when unrealised PnL turns positive |
| `AggressiveStoploss` | Each bar close | Shifts stoploss to last bar's close (only in profit if `only_in_profit=True`) |
| `TargetProfit` | Each tick | Places a limit exit when unrealised PnL (₹ or %) reaches the target |

Strategies are in-process; cross-process cancellation writes `CANCELLED` to DynamoDB `Strategies` table and checks on the next trigger.

---

## DynamoDB Tables

| Table | PK | SK | GSI | Purpose |
|-------|----|----|-----|---------|
| `Sessions` | `session_id` (S) | — | `user_id-index` | Session metadata (symbol, date, type, capital) |
| `Trades` | `session_id` (S) | `trade_id` (S) | `user_id-date-index` | Filled trades |
| `Orders` | `session_id` (S) | `order_id` (S) | — | All orders (PENDING/FILLED/CANCELLED) |
| `Wallets` | `user_id` (S) | `date` (S) | — | Daily wallet balance per user |
| `Users` | `user_id` (S) | — | `email-index` | Auth credentials (bcrypt hash) |
| `UserSettings` | `user_id` (S) | — | — | 13 per-user preferences (guardrails, ratios, analysis_price_source) |
| `Strategies` | `session_id` (S) | `strategy_id` (S) | — | Strategy lifecycle (active/cancelled) |
| `GuardRailSettings` | `user_id` (S) | — | — | GuardRail thresholds (mirrors UserSettings subset) |
| `Tokens` | `token_key` (S) | — | — | Admin API tokens (Kite, Breeze) |
| `RealTradingWhitelist` | `user_id` (S) | — | — | Users allowed to place real orders |

---

## Data Storage

OHLC data lives under `OHLCDATA_DIR` (configured in `accesskeys.ini [paths]`):

```
ohlcdata/
  NIFTY-06-05-2026.parquet          # equity bars (tz-naive IST DatetimeIndex)
  ohlcdata/options/
    NIFTY26MAY23500CE-06-05-2026.parquet   # options chain bars (same format)
```

**Critical IST-as-UTC trick** (`data_loader.py`):
The parquet files store IST wall-clock times as a tz-naive `DatetimeIndex`. The backend calls `df.index.tz_localize("UTC")` — it attaches the UTC label to IST wall-clock values. Unix timestamps therefore encode IST values, so Lightweight Charts displays `09:15`, not `03:45`. Do **not** use `tz_localize("Asia/Kolkata").tz_convert("UTC")`.

**3-minute candle boundaries** — both sides must agree:
- Backend: `pandas resample("3min")` (epoch-aligned)
- Frontend: `Math.floor(tick.time / 180) * 180`

---

## SSE Event Types

| Event `type` | Payload | Emitter |
|---|---|---|
| `tick` | `{time, open, high, low, close, right?}` | Session tick loop |
| `order_filled` | `{order_id, filled_price, right?}` | `order_service.check_orders` |
| `order_placed` | `Order` dict | `orders.py` router (strategy-placed orders) |
| `order_cancelled` | `{order_id}` | Kotak reconcile (rejected orders) |
| `new_trade` | `Trade` dict | AI Helper-placed trades, strategy fills |
| `strategy_completed` | `{strategy_id}` | Strategy service |
| `guardrail_activated` | `{guardrail_type, reason}` | Guardrail service |
| `broker_error` | `{message}` | Kotak service |
| `session_ended` | `{}` | Session loop on completion or stop |

---

## AI Helper Integration (Phase XI)

The backend has two integration points with the aihelper server (port 8701):

**Bar-close hook (fire-and-forget)**

Fired inside `_emit_tick_and_check_orders` only when `session.ai_commands_active == True`:
```
POST http://AI_HELPER_URL/hook/bar-close
{
  user_id, session_id, symbol, right,
  bars: [last 15 OHLC bars of today],
  underlying_bars: [last 15 NIFTY bars] (for CE/PE hooks only),
  position: {side, qty, avg_entry, unrealized_pnl_pct},
  session_type, funds_ratio_l_pct, funds_ratio_m_pct, funds_ratio_h_pct
}
```
Timeout: 100 ms. Backend does not wait for a response.

**Session stop (synchronous)**

Called in `stop_session()` before returning:
```
POST http://AI_HELPER_URL/hook/session/{session_id}/stop
```
Timeout: 2 s. Backend blocks until aihelper confirms all commands cancelled.

---

## Configuration

All configuration is read at startup from `data/accesskeys.ini` and environment variables.

| Key | Source | Default | Purpose |
|-----|--------|---------|---------|
| `DATA_DIR` | env | `../data` | Root data directory |
| `OHLCDATA_DIR` | `accesskeys.ini [paths] ohlcdata` | — | OHLC parquet/pickle files |
| `LOG_DIR` | `accesskeys.ini [paths] logs` | — | Daily rotating log files |
| `AI_HELPER_URL` | env `AI_HELPER_URL` | `http://localhost:8701` | aihelper base URL |
| `USE_DYNAMODB_LOCAL` | env | `true` | Connect to Docker DynamoDB Local |
| `DYNAMODB_LOCAL_ENDPOINT` | env | `http://localhost:8000` | DynamoDB Local endpoint |
| `DYNAMODB_REGION` | env | `ap-south-1` | AWS region (DynamoDB Local ignores it) |

**Symbol registry** (`config.py`):

| Symbol | Display | Lot Size |
|--------|---------|----------|
| `NIFTY` | Nifty 50 | 75 |
| `BSESEN` | BSE Sensex | 10 |
| `TATPOW` | Tata Power | 2625 |
| `TATMOT` | Tata Motors | 1425 |
| `RELIND` | Reliance | 250 |

---

## Authentication

A single fixed user (`00000000-0000-0000-0000-000000000001`) is seeded at startup. The `X-User-Id` header (set by the frontend from `localStorage`) is the primary auth token. Admin routes additionally check `X-Admin-Token`. bcrypt passwords are stored in the `Users` DynamoDB table.

---

## Start Commands

```bash
# WSL
bash scripts/start-backend.sh     # uvicorn at http://localhost:8700

# EC2
bash scripts/start-backend-ec2.sh
```

Log file: `$LOG_DIR/backend.log` (daily rotating, 14-day retention).
