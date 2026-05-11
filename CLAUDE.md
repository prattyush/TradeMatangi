# Trade Matangi Project

All development should be done in dev branch and finally merging to main branch will be done manually. When raising a PR please create a new branch and when it is reviewed merge to dev.

@docs/spec.md

## Development Environment

### Running the stack locally (WSL)

```bash
# Terminal 1 — backend at http://localhost:8700
bash scripts/start-backend.sh

# Terminal 2 — frontend at http://localhost:5173
bash scripts/start-frontend.sh
```

### Running backend tests

```bash
cd backend
source ~/venvs/tradematangi/bin/activate
python -m pytest tests/ -v
```

### TypeScript check

```bash
cd frontend
node node_modules/typescript/bin/tsc --noEmit
```

## Key Technical Constraints

- **Python venv must live outside `/mnt/d/`** — use `~/venvs/tradematangi`. The Windows filesystem does not support the `lib → lib64` symlink that `python -m venv` creates inside the repo.
- **npm must use `--no-bin-links`** — `.bin/` symlinks fail on the Windows filesystem. Scripts already handle this; don't add a plain `npm install` step.
- **IST timestamps**: data files (pickle and parquet) have tz-naive IST DatetimeIndex. The backend uses `df.index.tz_localize("UTC")` (NOT `tz_localize("Asia/Kolkata").tz_convert("UTC")`). This makes Unix timestamps encode IST wall-clock values so Lightweight Charts shows 09:15, not 03:45. Do not change this without updating all timestamp comparisons in `data_loader.py` and the frontend `CANDLE_INTERVAL_SECONDS` window math.
- **3-min candle boundaries**: both backend (`pandas resample("3min")`) and frontend (`Math.floor(time / 180) * 180`) must use the same epoch-aligned formula. These are intentionally kept in sync.
- **Data file lookup order**: `data_loader.load_dataframe` checks `data/ohlcdata/<symbol>-DD-MM-YYYY.parquet` first, then falls back to legacy `data/<symbol>-DD-MM-YYYY.pickle`. New Breeze-fetched data is always saved as parquet in `data/ohlcdata/`. Legacy pickles are auto-migrated to parquet on first access.
- **pyarrow required**: parquet support needs `pyarrow` installed (`pip install pyarrow`). It is in `requirements.txt`. The venv must have it.
- **DynamoDB Local credentials**: when `USE_DYNAMODB_LOCAL=true`, always use hardcoded dummy credentials (`fakeKey`/`fakeSecret`). Never pass real AWS credentials (ASIA* keys) to DynamoDB Local — it will reject them with `UnrecognizedClientException`.
- **ICICI Direct symbol codes**: The canonical symbol keys in `SUPPORTED_SYMBOLS` match ICICI Direct / Breeze API codes exactly: `NIFTY`, `TATPOW`, `TATMOT`, `RELIND`. Do not use NSE display names (TATAPOWER, TATAMOTORS, RELIANCE) as symbol keys.
- **Breeze API record limit**: `get_historical_data_v2(interval="1second")` silently truncates to ~1000 records per call (~16 min). A full trading day (22 500 rows) requires pagination. Use `broker_service._fetch_day_paginated` which splits the day into 15-min chunks. Never make a single full-day call for 1-second data.
- **Lightweight Charts — no teardown for layout changes**: calling `chart.remove()` discards all series data. Height/width changes must go through `chart.applyOptions(...)`. The chart init `useEffect` must use `[]` deps (mount only); a separate `useEffect([height])` calls `applyOptions` for height changes.
- **Options cache path**: options parquet files are stored as `data/ohlcdata/{SYMBOL}-{CE|PE}-{STRIKE}-{EXPIRY}-{DD-MM-YYYY}.parquet`. Equity files remain `data/ohlcdata/{SYMBOL}-{DD-MM-YYYY}.parquet`.
- **Options lot sizes (hardcoded, current)**: NIFTY=75, RELIND=250, TATMOT=1400, TATPOW=2700. No historical lot size tracking — always use current values.
- **NSE options expiry**: date-aware helper required. From 2025-09-01: weekly and monthly expiry on Tuesday (Monday if holiday). Before 2025-09-01: Thursday (Wednesday if holiday). Monthly = last occurrence of that weekday in the month.
- **FundsRatio capital base**: snapshotted from wallet at `POST /api/simulation/start`. Mid-session wallet changes do not affect l/m/h amounts for that session. Ratios: l=3%, m=6%, h=12% (user-overridable in settings).
- **Wallet carry-forward**: keyed per user + calendar date of the replay. Replaying an earlier date uses that date's prior end-of-day balance, not the most recent session's balance.

## Phase-III Sprint 1 — User + Wallet

**Goal:** Foundational user identity and wallet persistence.

### Backend Tasks
- [x] Create `Users` DynamoDB table; seed hardcoded user `abc123` with fixed UUID on startup
- [x] Create `Wallet` DynamoDB table (user_id HASH, date RANGE); carry-forward logic
- [x] `GET /api/wallet` — return current balance for today
- [x] `POST /api/wallet/reset` — reset to ₹1,50,000 or custom amount
- [x] Thread `user_id` through all routers → services (replace `PLACEHOLDER_USER_ID`)
- [x] Wallet debit on order placement (limit/target); credit on fill or cancel
- [x] `POST /api/simulation/start` snapshots wallet balance as `session_capital`
- [x] Tests: wallet debit/credit, carry-forward, reset, user_id propagation (128 passing)

### Frontend Tasks
- [x] Store hardcoded user in `localStorage` on first load (survives refresh)
- [x] Wallet balance widget in top bar; refresh after every order event
- [x] Settings popup (gear icon top-right): reset wallet to ₹1,50,000 or custom amount
- [x] UI error banner when order is blocked due to insufficient funds
