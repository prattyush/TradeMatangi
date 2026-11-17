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

Session loop (paper/real, Phase 19):
        Subscribe first: MarketDataHub SessionFeed → provider broadcaster
        History: load off-loop; publish baseline without live fills
        Live: await session.paper_tick_queue.get(); discard history overlap
        Live observations call the appropriate Paper/Real tick evaluator

_emit_tick_and_check_orders():
        ├── session.queue.put(tick_json)              → SSE delivery
        ├── order_service.check_orders(session, tick) → fill pending orders
        ├── strategy_service.on_tick(session, tick)   → AutoStop/BreakEven/etc.
        └── _check_and_schedule_ai_hook(session, tick)

stop_session():
        ├── cancel asyncio task
        ├── release SessionFeed and exact-contract subscription handles
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
| `routers/admin.py` | `/api/admin` | Tokens, whitelist, stream-source toggle, extra market holidays (`/holidays`) |
| `routers/kotak.py` | `/api/kotak` | Login, status, funds, order-history, reconcile |
| `routers/users.py` | `/api/users` | `GET /settings`, `PUT /settings` |
| `routers/desktop_games.py` | `/api/desktop/v1/games` | `GET /state`, `PUT /state` (Phase 25 Games progress), `GET /availability`, `GET /window` (cache-only market data, see "Games market data") |

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
| `TradeLabels` | `session_id` (S) | `round_trip_index` (N) | `UserIdDateIndex` (`user_id`, `date`) | Per round-trip category/strategy/tag labels (lazy-created by `trade_label_service`) |
| `PatternNames` | `user_id` (S) | `name_key` (S) | — | Category/strategy name registry (`category#<name>`, `strategy#<name>`) |
| `BehaviorQuestions` | `user_id` (S) | `question_id` (S) | — | Phase 23 behavior questions (`kind` entry/exit, `status` active/archived; never deleted) |
| `BehaviorMarks` | `session_id` (S) | `mark_key` (S) `<round_trip_index:05d>#<question_id>` | `UserIdDateIndex` (`user_id`, `date`) | Phase 23 "yes" marks per round trip; lazy-created by `behavior_service`, deleted with the session |
| `WhatIfScenarios` | `session_id` (S) | `scenario_id` (S, slug of the name) | GSI `UserIdDateIndex` (`user_id`, `date`) | Phase 24 saved What If scenarios: one named scenario per day-session holding the edited price and quantity of fills (`edits`) and a small `summary`; owner only; routes `/api/whatif` (day list, `/range` for Compare days, upsert, delete); lazy-created by `whatif_service`, deleted with the session; never touches trades, orders or labels |
| `VideoLinks` | `session_id` (S) | `video_id` (S) | — | Phase 24 saved YouTube links for Video Maker videos (title, visibility, chapters; the link is rebuilt from the video id); owner only; lazy-created by `video_links_service`, deleted with the session |
| `GameProfiles` | `user_id` (S) | `record_id` (S): `profile`, `game#<id>`, `day#YYYY-MM-DD`, `month#YYYY-MM` | — | Phase 25 Games progress only (levels, last scores, small stats, daily totals). `day#` items carry `expires_at` (epoch seconds, about 200 days, TTL on). Lazy-created by `games_persistence_service`, also in `scripts/setup-dynamodb-tables.py` |
| `DeepDiveSetups` | `user_id` (S) | `setup_key` (S) `<category>::<strategy>#<date>#<symbol>#<side>` | — | Phase 26 Deep Dive: one item per marked day and side (`buy`/`sell`); `tag_values` map `tag_id → bool` (true valid, false not valid, absent = unmarked), `annotations` JSON, `outcome` success/failed, `strength` ideal/average/poor (only with a success; grading a day makes it a success, a failure or a cleared outcome drops it; an older success has none), strikes, interval, notes; lazy-created by `deep_dive_service`; readable by owners' share list, written by the owner only |
| `DeepDiveTags` | `user_id` (S) | `tag_key` (S) `<category>::<strategy>#<tag_id>` | — | Phase 26 Deep Dive tags per strategy (`name` ≤140; `active`/`archived`, never deleted so the marks survive; ≤40 active). A day marks each tag valid, not valid or leaves it unmarked |

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

## Market holidays

`app/utils.py` `is_trading_day` combines weekends, the built-in `NSE_HOLIDAYS` list (updated by hand each year) and holidays added at run time. The added ones live in `DATA_DIR/holidays.json` (`{"holidays": {"2026-11-11": "note"}}`), are re-read whenever the file changes (no restart, a hand edit works), and are managed by an admin with `GET/POST /api/admin/holidays` and `DELETE /api/admin/holidays/{date}`. A missing or unreadable file means no added holidays. Nothing fetches the NSE calendar automatically.

## Start Commands

```bash
# WSL
bash scripts/start-backend.sh     # uvicorn at http://localhost:8700

# EC2
bash scripts/start-backend-ec2.sh
```

Log file: `$LOG_DIR/backend.log` (daily rotating, 14-day retention).


## Phase 19 live-data boundary

Website live engines and desktop chart tiles now subscribe through
`services/market_data.py`. MarketDataHub shares exact provider/instrument feeds,
reference-counts independent consumers and exposes quotes plus feed-group status.
Existing provider broadcasters remain SDK adapters; Kite keeps one streaming
connection for the configured credentials. REST/history clients are independent.
Session SSE carries charts and trading events; desktop chart SSE carries chart
state only. Both use replay/reset recovery. See `spec-phase19.md` for the design
alternatives, fallback matrix, history handoff and authentication follow-up.

This architecture remains process-local and requires one API worker. Extracting
a feed worker later also requires session ownership and command/event routing;
adding workers alone duplicates feeds and loses access to in-memory sessions.

## Games progress (Phase 25, G2)

`routers/desktop_games.py` (`/api/desktop/v1/games`, auth `get_desktop_user_id`: desktop bearer or website `X-User-Id`) and `services/games_persistence_service.py`. It stores compact progress only; it never touches orders, sessions, brokers or market data, and a test scans its imports for that.

- **`GET /state`**: one consistent range query (`record_id BETWEEN day#<today-30d> AND profile`). Sort keys order `day# < game# < month# < profile`, so a single query returns the last 30 calendar days, every game, every month and the profile. Response: `{version, user_id, profile, games{id}, days{date}, months{YYYY-MM}}` (`user_id` seeds the client's replayable sessions); storage keys and `expires_at` are not exposed.
- **`PUT /state`**: one `TransactWriteItems` for the optional `game`, `day`, `month` and `profile` entries, each `{id|date|month, revision, item}`. `revision` is what the client read (0 = new record). A stale revision cancels the whole transaction and returns **409** with `current` (the present records) so the client can re-read and re-apply. `mutation_id` (8–64 chars) makes retries idempotent: if every target record already carries it as `last_mutation_id`, nothing is written and `applied: false` is returned.
- **Validation (422):** game ids must be in the 31-id registry (10 market and 21 brain); every field is whitelisted; `level` 1–20; `lastScores` at most 20 integers 0–100; `stats` at most 20 keys; day/month shape fixed; sizes of the compact JSON: profile 4 KB, game 3 KB, day 2.5 KB, month 3 KB, hard limit 8 KB.
- **TTL:** only `day#` items get `expires_at` (now + 200 days). The table's TTL is switched on at creation. DynamoDB Local accepts the call but does not enforce expiry; real AWS does. Month rollups (no TTL) keep the history.
- **Limiter:** `services/games_rate_limit.py`, an in-process per-user token bucket (2 requests/s, burst 10) on both routes, returning 429 with `Retry-After`. It is per process; the data routes (below) reuse it. There is no global gzip middleware.
- **Capability flag:** `"games"` is appended to `DesktopCapabilities.features` so a client can hide Games against an older backend.
- **Tests:** `tests/test_games_persistence.py` (moto `mock_aws`, as the other DynamoDB tests): registry, round trip, idempotency, 409 and atomicity, per-user isolation, validation, size caps, TTL attribute, recent-days window, limiter, import scan.

## Games market data (Phase 25, G1)

`GET /availability` and `GET /window` on the same router, backed by `services/games_index.py` (index building, file names) and `services/games_data_service.py` (reading and slicing). **Cache-only:** they read parquet files that already exist in `OHLCDATA_DIR` and nothing else. A missing day or contract is `404 {"reason": "not_cached"}`; no code path reaches `load_history`, `fetch_historical`, `fetch_options_historical`, Breeze, Kite, Kotak or Fyers (`test_games_data.py` replaces every one of those with a function that fails the test, and scans the sources for them). Only `NIFTY` and `BSESEN` are served (the only symbols with a year of second-level days).

- **The index.** `scripts/build-games-index.py` (run by hand after the data cache is refreshed; there is no cron in this repo) writes `GAMES_INDEX_PATH` (default `DATA_DIR/games-index.json`, about 600 KB; `GAMES_INDEX_PATH` env overrides) atomically. It is incremental: the `scan` section stores size, modification time, verdict and observed count per file, and an unchanged file is not read again (first full run on the real cache: 386 day files and about 6,300 option files in about 160 s; a re-run about 25 s, almost all of it listing the directory on `/mnt/d`). Options: `python scripts/build-games-index.py --full` ignores the old index, `--dry-run` writes nothing, `--data-dir` and `--output` override the paths.
- **What counts as a day.** File name exactly `SYMBOL-DD-MM-YYYY.parquet` (the `-kite1m` and `-kotak1m` minute files are not second data), at least 20,000 rows (`_MIN_DAY_ROWS`), and genuine seconds: files with the `observed` column need 15,000 observed rows; older files, which have none, need 10,000 seconds whose price differs from the one before (a minute file spread over seconds by gap filling changes about once a minute). The parquet files carry no `native_interval_seconds` metadata (checked on the real cache), so `has_native_second_cadence` cannot be used: it is always true on a gap-filled frame. An option contract is listed for a listed day when its file has at least 20,000 rows and, if it has the column, 10,000 observed rows.
- **`/availability`** returns `{version, generated_at, index_missing, symbols: {SYM: {lot_size, strike_step, dates[], options: {date: {expiry: {CE: [strikes], PE: [strikes]}}}}}}`. `lot_size` and `strike_step` come from `config.LOT_SIZES` and `options_service.STRIKE_INTERVALS` at request time, never from the index. A missing or unreadable index gives `index_missing: true` and no symbols; the route never scans the directory. The index is cached in process for 10 minutes and re-read as soon as the file's modification time changes.
- **`/window`** takes `symbol`, `date`, `start_sec`, `duration_sec`, `interval_seconds` (1 or 60 only: 5 s and 15 s candles are built by the client) and, for an option, `expiry`, `strike` and `right` together. `duration_sec` is at most `GAMES_MAX_WINDOW_SECONDS` (900) for 1 s and a whole day for 60 s. It returns `{symbol, date, interval_seconds, start_sec, duration_sec, count, t[], o[], h[], l[], c[]}` (plus `expiry`, `strike`, `right` for an option): `t` is the second of the day on the IST wall clock (34200 = 09:30), prices are integer paise, **observed rows only** (no flag; filled seconds are simply absent, and a file without the column loses its back-filled opening run via `infer_observed`). A 60 s call resamples the whole observed day with `resample_to_candles(df, 1)` and returns the candles that start inside the window, so there is never a cut-off first candle. A window with no observed rows is `200` with `count: 0`. Invalid parameters are 422.
- **Cost.** One parquet read (about 370 KB) and a slice; the last four observed days are kept in a small in-process LRU keyed by file, modification time and size, so the underlying and one option of a round are not re-read. The two routes are plain `def` (run in FastAPI's thread pool), not `async def`, so a file read never blocks the event loop that serves live trading streams. Per-user token buckets: 4 requests/s (burst 10) for `/window`, 1/s (burst 5) for `/availability`.
- **Compression** is done in this route only (`encode_json`): gzip when the request's `Accept-Encoding` lists it and the body is at least 512 bytes, with `Vary: Accept-Encoding`. The desktop's Rust client (`reqwest`) does not enable the `gzip` feature, so the desktop receives plain JSON (decided in G3b to leave it: at most 34 KB a window, fetched once because of the local window cache, and the Rust dependency set stays untouched).
- **Payload sizes (real data, NIFTY 2026-11-09):** `/availability` 64.6 KB raw, 7.4 KB gzip (236 NIFTY and 149 BSESEN days, about 6,200 contracts); `/window` 1 s over 300 s 11.5 KB raw, 3.1 KB gzip; over 600 s 22.9 KB, 6.1 KB; over 900 s 34.3 KB, 9.3 KB; a whole day of 60 s candles 13.8 KB, 4.4 KB. A 300 to 600 s round (underlying plus one option) is about 10 KB gzipped, inside the 30 KB budget of the spec.
- **Tests:** `tests/test_games_data.py` (54, synthetic parquet files in a temporary directory): file-name parsing and parity with `parquet_path` / `options_parquet_path`, the row limits equal to the loaders', index rules (observed, legacy, filled-minute, short and damaged files, other symbols, provider files, sparse options), incremental builds and the script, availability, window values in paise, observed-only, legacy back-fill, options, minute candles, caps and 422s, gzip negotiation, rate limit, the frame cache, and the cache-only proofs (a miss is 404 with every download and broker function failing the test).

### Traded patterns (Phase 26, S10)

`traded_patterns_service.py` turns the user's own `TradeLabels` into pattern material, with no table of its own. `GET /api/pattern/traded/summary` (labels only), `GET /api/pattern/traded?category&strategy&start_date&end_date&limit` (round trips rebuilt per session for the newest `limit` labels, one rebuild per session, unreadable sessions counted as `unavailable`) and `POST /api/pattern/traded/save` (copies a labelled trade's entry and exit into the day's pattern chart as marks, through `pattern_logger_service.save_marks_to_chart`, which the Deep Dive also uses). All read the caller's own labels only; a linked real session is counted once through `trade_label_service.canonical_labels`. Mirrored for the desktop under `/api/desktop/v1/patterns/pattern/traded...`.

### Deep Dive hardening (Phase 26, S11)

`deep_dive_service.stats_all` (the percentages every label form and live popup asks for) is cached per process for `STATS_ALL_TTL_SECONDS` (20 s); every write in the service (`upsert_setup`, `delete_setup`, `set_tag_values`, tag add, rename, archive, restore) clears the cache, callers receive a copy, and another process or a viewer of a shared deep dive sees a change within the TTL. A marked day must be before today in India (`Asia/Kolkata`), the calendar's own rule. The desktop's `trading/trade-labels/metadata` reads the percentages under a 2 second bound and falls back to an empty list.

