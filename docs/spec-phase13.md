#### Enhancements

##### Fyers ✅ Complete (PR #279 merged to dev)

Fyers live streaming is now available as the primary streaming source for paper and real trading sessions.

**Implementation:**
- `backend/app/services/fyers_service.py` — `FyersBroadcaster` singleton managing one `FyersDataSocket` WebSocket connection shared by all active sessions
- Uses `fyers_apiv3.data_ws.FyersDataSocket` with LTP mode for ticks
- 1-second OHLC accumulation (same `_OHLCAccumulator` as Kite/Kotak/Breeze), pushed to `session.paper_tick_queue`
- Token flow: DDB `BrokerTokens` table (`fyers_access`) → `data/accesskeys.ini` `[fyers]` section fallback
- Admin UI: "Fyers" button added to LIVE STREAMING SOURCE selector, Fyers Access Token and Refresh Token inputs in BROKER TOKENS section
- Admin API: `GET/PUT /api/admin/tokens` supports `fyers_access` and `fyers_refresh`; `PUT /api/admin/stream-source` accepts `"fyers"`
- Fallback chain: fyers → breeze → kotak → kite

**Fyers symbol format:**
- Equities: `NSE:RELIANCE-EQ`
- Indices: `NSE:NIFTY50-INDEX`, `BSE:SENSEX-INDEX`
- Options: `NSE:NIFTY30JUL26000CE` (symbol + day + month-abbr + strike + right)


##### Chart Structure ✅ Complete (PRs #282, #284, #286, #288, #290)

Users can browse daily charts classified by Opening, Midday, and Closing structure types.
Predefined classifications are system-generated and visible to all users. Users can create
custom classifications and share them via the existing pattern-sharing mechanism.

**Database:**
- `ChartStructures` table: PK=`chart_structure_id`, GSIs `UserIdIndex` (on `user_id`) and `SymbolDateIndex` (on `symbol`+`date`)
- `ChartStructureShares` table: PK=`owner_user_id`, SK=`shared_user_id`, GSI `SharedUserIdIndex` on `shared_user_id`
- Predefined records have `user_id="__SYSTEM__"`, `is_predefined=true`. User-custom records have real `user_id`, `is_predefined=false`.

**Classification Script (`scripts/classify_chart_structures.py`):**
- Batch classifies any supported symbol (NIFTY, BSESEN, TATPOW, TATMOT, RELIND)
- Uses Breeze API to auto-fetch missing parquet cache (same as `fetch_historical()`)
- DDB credentials read from `accesskeys.ini` matching other scripts

**Classification rules:**

| Segment | Types | Logic |
|---|---|---|
| **Opening** | `within_yesterdays_range`, `within_day_before_yesterdays_range`, `gap_up`, `gap_down`, `big_gap_up`, `big_gap_down`, `undefined` | Compares today's open to yesterday's open-close range tiered: within range → within DBY range → within 2×range (direction determines up/down) → beyond 2×range (big gap) |
| **Midday** | `trading_range`, `breakout`, `trend`, `undefined` | First 15-min candle vs 12:00 close. Within first-15 OHLC → range. Beyond 2× first-15 range → breakout. Between → trend |
| **Closing** | `trading_range`, `breakout`, `reversal_breakout`, `trend`, `trend_reversal`, `undefined` | Open-to-12:00 range vs day close. 5 tiers with direction-aware breakout/reversal/trend logic |

**Backend API (`/api/chart-structures`):**

| Method | Path | Purpose |
|---|---|---|
| GET | `/types` | Return predefined opening/midday/closing types |
| GET | `/structures` | Filtered list (multi-select on opening/midday/closing types, symbol, date range) |
| GET | `/structure/{id}` | Full structure record |
| GET | `/ohlc/{symbol}/{date}` | 3-minute OHLC candles for current day + 2 prior trading days |
| POST | `/structure` | Create user-custom classification |
| PUT | `/structure/{id}` | Update (owner only) |
| DELETE | `/structure/{id}` | Delete (owner only) |

Sharing reuses `pattern_share_emails` — when pattern shares are synced, chart structures sync to the same users automatically.

**Frontend:**
- "📊 Structures" button in main header nav
- Multi-select dropdown filters for Opening, Midday, Closing types
- Gallery grid with sparkline previews per chart
- Full-chart modal with lightweight-charts OHLC (3 days), EMA 9/21 toggle, inline classification editing
- `typeBadge()` with directional color coding (up=green, down=red, range=blue, breakout=green, trend=purple, reversal=pink)

**Files changed:**

| File | Change |
|---|---|
| `scripts/setup-dynamodb-tables.py` | ChartStructures + ChartStructureShares table definitions |
| `scripts/classify_chart_structures.py` | **New** — batch classification with auto-fetch + idempotent reclassify |
| `backend/app/services/chart_structure_service.py` | **New** — CRUD, query, type definitions, sharing |
| `backend/app/routers/chart_structures.py` | **New** — REST API |
| `backend/app/main.py` | Register chart_structures router |
| `backend/app/services/user_settings_service.py` | Sharing hook triggers `sync_structure_shares` |
| `backend/app/services/broker_service.py` | Catch Breeze session-key-expired as BreezeTokenError (prevents UI refresh loop) |
| `backend/tests/test_user_settings.py` | Patch `sync_structure_shares` in sharing test |
| `frontend/src/services/api.ts` | 7 chart structure API methods + types |
| `frontend/src/pages/ChartStructures.tsx` | **New** — full structures browser with filters, gallery, chart modal, EMA |
| `frontend/src/App.tsx` | "📊 Structures" nav button + conditional render |
| `docs/chart-structure-feature.md` | Planning doc |


##### Advanced Analysis ✅ Complete (PR #296 merged to dev)

Two features: **Trade Labelling** and **Stats Dashboard** — extending the Analysis UI with round-trip annotations and aggregated metrics.

**Implementation (by implementation plan in `docs/spec-phase13-implementation-plan.md`):**

**Database:**
- `TradeLabels` table: PK=`session_id`, SK=`round_trip_index`, GSI `UserIdDateIndex` on (`user_id`, `date`) for stats queries
- Denormalized fields: `symbol`, `date`, `session_type`, `round_trip_pnl`, `round_trip_pnl_pct`

**Backend (`backend/app/services/trade_label_service.py`, `backend/app/routers/labels.py`):**
- FIFO round-trip matching per session, per right (CE/PE/underlying tracked independently), closing at net_qty=0
- `GET /api/analysis/round-trips?session_id=` — compute FIFO round-trips
- `POST /api/analysis/labels` — batch upsert labels (auto-defaults: actual_pattern=expected, entry/exit_tag="AS_PER_PATTERN")
- `GET /api/analysis/labels?session_id=` — fetch all labels for a session
- `GET /api/analysis/entry-tags` / `exit-tags` — distinct tag listing per user
- `GET /api/analysis/stats` — aggregated stats with per-pattern breakdown, mismatch analysis, by-tag tables

**Stats endpoints compute:**
| Metric | Description |
|--------|-------------|
| Total trades | Count of labeled round-trips |
| Win % | Percentage with positive PnL |
| Avg PnL% | Mean `round_trip_pnl_pct` |
| P95 PnL% | 95th percentile PnL% |
| Per-pattern | Count, win%, avg PnL% grouped by (expected_category, expected_strategy) |
| Mismatch | Rate, profit% when matched vs mismatched, most mismatched expected/actual |
| By entry/exit tag | Count, avg PnL% per tag |

**Frontend:**

*Trade Labeling (`TradeLabeling.tsx`):*
- "Label Trades" tab inside expanded GroupCard in Trade Analysis
- Split view: OHLC chart (left) with round-trip-numbered markers, label forms (right) in a scrollable column
- Per round-trip: expected pattern (category + strategy dropdowns from Pattern Library), actual pattern (same), entry tag (creatable datalist), exit tag (creatable datalist)
- Auto-save on any field change (debounced, per-field upsert)
- Labels persist across sessions (keyed by `session_id + round_trip_index`)

*Stats Dashboard (`StatsModal.tsx`):*
- "📊 Stats" button in Analysis filter bar opens full-screen overlay
- Same filters as Analysis: symbol, instrument type, session type, date range
- Summary cards (Total Trades, Win %, Avg PnL%, P95 PnL%)
- By Expected Pattern table (sortable by count/win%/avg PnL%)
- Mismatch Summary card (mismatch rate, profit comparison, most mismatched)
- Entry Tag and Exit Tag tables side by side
- Auto-refreshes on filter change

**Files changed:**

| File | Change |
|------|--------|
| `scripts/setup-dynamodb-tables.py` | +TradeLabels table with UserIdDateIndex GSI |
| `backend/app/services/trade_label_service.py` | **New** — CRUD, FIFO round-trips, stats aggregation |
| `backend/app/routers/labels.py` | **New** — REST API (7 endpoints) |
| `backend/app/main.py` | Register labels router |
| `frontend/src/services/api.ts` | +7 types + 7 API methods (round-trips, labels, tags, stats) |
| `frontend/src/components/TradeLabeling.tsx` | **New** — Label Trades tab with chart + forms |
| `frontend/src/components/StatsModal.tsx` | **New** — Stats dashboard |
| `frontend/src/components/TradeAnalysis.tsx` | Tab bar [Trades | Label Trades], "📊 Stats" button, imports |

**Tests:** 627 backend tests + 305 aihelper tests — all passing.


## Phase 13 — Implementation Status

| Feature | PR | Status |
|---------|-----|--------|
| Fyers Live Streaming | PR #279 | ✅ Merged to dev |
| Chart Structures | PRs #282, #284, #286, #288, #290 | ✅ Merged to dev |
| Vite HMR disable | PR #292 | ✅ Merged to dev |
| Advanced Analysis — Trade Labelling + Stats | PR #296 | ✅ Merged to dev |
| Stepwise session_type persist fix | PR #298 | ✅ Merged to dev |

## PR Log — Phase 13

| Sprint | Branch | Status |
|--------|--------|--------|
| Fyers as live streaming source | feature/fyers-streaming | PR #279 merged to dev |
| Chart Structures — daily classification browser | feat/chart-structures | PR #282 merged to dev |
| Chart Structures — classify script fix | fix/chart-structures-script | PR #284 merged to dev |
| Chart Structures — OHLC 2 prior days + gap direction split | fix/chart-structures-ohcl-days | PR #286 merged to dev |
| Chart Structures — EMA 9/21 toggle | feat/chart-structures-ema | PR #288 merged to dev |
| Chart Structures — yesterday/DBY date fix | fix/chart-structures-yesterday-order | PR #290 merged to dev |
| Disable Vite HMR on all deployments | fix/disable-vite-hmr | PR #292 merged to dev |
| Advanced Analysis — Trade Labelling + Stats | feature/phase13-advanced-analysis | PR #296 merged to dev |
| Stepwise session_type persist — distinct "stepwise" in DB + Analysis UI filter | feat/stepwise-trade-type | PR #298 merged to dev |


