# TradeMatangi — Project Review

**Reviewed by**: Claude Code  
**Date**: 2026-05-10  
**Status**: Pre-implementation (planning phase)

---

## Executive Summary

The project spec is well-intentioned with clear phasing. Several architectural decisions carry significant hidden risk, and a number of critical design questions are either unanswered or contradicted within the spec. These should be resolved before Phase-I implementation begins to avoid costly rework.

---

## High Severity

### HS-1: WebSocket vs SSE — Foundational Distributed Architecture Decision (Unresolved)

The spec says "confirm the choice from the user" and leaves WebSocket vs SSE open. This is not a minor implementation detail — it is a load-bearing architectural decision with major distributed-system implications:

- **WebSocket** connections are stateful and pinned to the specific server process that accepted the handshake. With `uvicorn --workers N` or multiple EC2 instances behind a load balancer, a client connected to worker-1 cannot receive messages emitted by worker-2. Sticky sessions (load balancer affinity by IP or cookie) are required, which complicates scaling and failover.
- **SSE (Server-Sent Events)** is built on HTTP. Each event is a new response chunk; the client reconnects naturally. Horizontally scaled servers can each emit their own SSE stream independently. No sticky sessions needed. Works with standard HTTP load balancers.

Given the explicit requirement for multi-worker FastAPI and multi-box deployment, **SSE is the correct choice** for streaming OHLC ticks. WebSocket should only be used if bidirectional messaging is required from client to server, which OHLC tick streaming does not need.

**This must be decided before any streaming code is written.** Switching from WebSocket to SSE after implementation requires rewriting both the backend stream emitter and the frontend consumer.

---

### HS-2: SQLite → DynamoDB Schema Impedance Mismatch

The spec now clarifies the migration path: SQLite for beta/development, DynamoDB for production. This is a reasonable cost-saving approach, but SQLite is relational (tables, foreign keys, JOINs) and DynamoDB is a key-value/document store with no joins and a fundamentally different access pattern model.

If the data model is designed purely for SQLite — e.g., a `trades` table with a `sessions` foreign key, fetched via `SELECT * FROM trades WHERE session_id = ?` — that query does not translate to DynamoDB. DynamoDB requires knowing the partition key + sort key at design time. Retrofitting DynamoDB access patterns onto a relational schema after the fact requires a near-complete data layer rewrite.

**Recommendation**: Design the data model from day one with both access patterns in mind. For each entity, define:
- What is the partition key (user_id, session_id)?
- What is the sort key (timestamp, order_id)?
- What queries will be run against it?

An SQLite schema that mirrors DynamoDB's key-value access patterns (avoiding cross-table JOINs in the hot path) can be migrated with minimal rework. Document these access patterns in spec.md before writing any models.

---

### HS-3: Strategy ID Composite Key Breaks Without Phase-I Auth

The spec defines strategy uniqueness as: `(user, symbol, trading_date, strategy_name)`. This is the right long-term design. However, Phase-I explicitly has no authentication and no user concept. This creates an unresolved gap:

- If Phase-I uses a hardcoded placeholder `user = "default"` and Phase-II adds real user IDs, any in-flight or persisted strategies from Phase-I will be owned by "default" and invisible/inaccessible to the real user.
- If Phase-I omits `user` from the ID entirely, the composite key structure changes between phases, breaking the database schema and any client code that references strategy IDs.

**Recommendation**: Even in Phase-I, include `user_id` in the strategy ID and session model. Use a hardcoded placeholder UUID (e.g., `"00000000-0000-0000-0000-000000000001"`) for the single Phase-I user. When auth is added in a later phase, this UUID gets replaced by the real user's ID — the schema and ID format remain unchanged. This costs almost nothing to implement now and prevents a painful migration.

---

### HS-4: `dev` Branch Does Not Exist

CLAUDE.md states "all development should be done in dev branch" with PRs merged to `dev`. The repository currently has only a `main` branch. If development begins without creating `dev` first, commits will accumulate on `main` directly, violating the stated workflow and making it difficult to retroactively establish the branch separation.

**Recommendation**: Create and push the `dev` branch before any code is written. Set `dev` as the default branch in GitHub if possible. All feature branches should be cut from `dev`, not `main`.

---

### HS-5: Pickle File Format Is a Security and Portability Risk

The spec defines the OHLC data format as `NIFTY-dd-mm-yyyy.pickle` — a Python pickle dump of a pandas DataFrame. This introduces two serious issues:

1. **Security**: Python's `pickle.load()` will execute arbitrary code embedded in the file. If the data directory is ever writable by an untrusted party, a malicious pickle file becomes remote code execution on the backend server. FastAPI running `pd.read_pickle()` on a file in a web-accessible directory is a significant attack surface.

2. **Portability**: Pickle is a Python-specific binary format. It cannot be read by the frontend directly, cannot be inspected with standard tools, and is not guaranteed to be forward-compatible across pandas or Python versions (a pickle created with pandas 1.x may fail to load in pandas 2.x).

**Recommendation**: Convert the source pickle to a well-defined, safe format before the data/ directory is committed or used. Parquet (efficient, typed, language-agnostic) or JSON Lines are both appropriate. If the pickle file is the only available source format, add a one-time conversion script at `scripts/convert_data.py` that reads the pickle and writes a `.parquet` or `.json` file, and only the converted file is loaded by the backend at runtime. Never call `pd.read_pickle()` in production code paths.

---

## Medium Severity

### MS-1: P&L Calculation Placement (Unresolved)

The spec says "this feature can be chosen whether the data comes from frontend or backend." Calculate P&L on the frontend for Phase-I — it is a pure function of the open position and the current tick price, both of which are already in the browser. Moving it to the backend adds an extra message type, round-trip latency, and a synchronization concern.

---

### MS-2: Replay Speed Design

The spec adds replay speed as a relative multiplier (e.g., `0.9` = 90% of real time). The simulation engine must emit ticks at `interval * speed_factor` milliseconds. The speed factor should be a backend session parameter (passed at session start), not a frontend-only display trick — otherwise pausing/resuming or reconnecting would desync the replay position.

---

### MS-3: OHLC Data Schema for Frontend

The backend reads a pandas DataFrame (second-level IST DateTimeIndex, columns: open, close, high, low). Before any API is built, define the JSON wire format for what the backend sends to the frontend over SSE/WebSocket. Lightweight Charts expects Unix timestamps in seconds (UTC), so IST times must be converted. Agree on this contract before building either side.

Suggested wire format per tick:
```json
{ "time": 1746589800, "open": 22100.5, "high": 22115.0, "low": 22095.0, "close": 22110.0 }
```

---

### MS-4: WSL Compatibility for Next.js

The spec notes to "check for Next.js if the running environment of WSL on Windows is suitable for testing." The known WSL2 issue is filesystem performance — `node_modules` on the Windows-mounted drive (`/mnt/d/`) causes extremely slow `npm install` and Next.js hot reload. The fix is to keep the project files on the Linux filesystem (e.g., `~/projects/`) rather than under `/mnt/d/`. The current working directory `/mnt/d/code/aiprojects/TradeMatangi` is on the Windows filesystem, which will cause significant slowdowns.

**Recommendation**: Move or clone the project to `~/projects/TradeMatangi` on the WSL Linux filesystem for development. Use the Windows path only for backup or IDE access.

---

## Low Severity / Quick Wins

### LW-1: Missing `.gitignore`

No `.gitignore` exists. Risk of committing `__pycache__`, `node_modules`, `.env`, `.db` files, and broker API keys.

Minimum entries needed:
```
__pycache__/
*.pyc
.venv/
*.db
node_modules/
.next/
.env
.env.local
data/*.pickle
data/*.parquet
```

### LW-2: `CLAUDE.md` References `@docs/spec.md` but spec.md Is Untracked

`CLAUDE.md` now includes `@docs/spec.md`. Neither file is committed. Both should be committed as foundational project documents.

### LW-3: Broker API Credentials Storage

Phase-II integrates with ICICI Breeze, Zerodha, and Kotak Neo. Define a `.env.example` file listing required env var names (e.g., `BREEZE_API_KEY`, `BREEZE_SESSION_TOKEN`) before any broker integration code is written. Keys must never be committed.

---

## What the Spec Gets Right

- Phase separation is pragmatic: Phase-I avoids all external dependencies
- Cost consciousness (SQLite over managed DB, no Lambda/SQS) is correct for early stage
- TradingView Lightweight Charts is the right specific choice for OHLC rendering
- FastAPI is well-suited: async, easy WebSocket/SSE, native thread/process support
- Defining the strategy composite key `(user, symbol, date, strategy_name)` early is good design
- Clarifying DynamoDB as the final DB target removes ambiguity from the earlier spec version
- The `< 200ms` cancellation target is a concrete, testable SLA

---

*End of review.*
