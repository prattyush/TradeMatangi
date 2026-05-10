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
