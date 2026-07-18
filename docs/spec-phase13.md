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


##### Google Sign-In ✅ Complete (direct commit to dev)

Users can sign in with Google in addition to email/password. Account name replaces
email in the header display for all user types.

**Implementation:**
- Uses Google Identity Services (GIS) one-tap sign-in via the client-side library (`accounts.google.com/gsi/client`)
- Backend verifies Google ID token server-side via `https://oauth2.googleapis.com/tokeninfo`
- Email from Google token is matched against existing Users table → same account, dual sign-in path
- New Google-only users get a popup to set their account name before account creation
- Existing users without an account name get a one-time backfill popup on next login

**Backend:**
- `user_service.py`: `google_auth()` — verifies token, matches by email (existing → login; new → create with account_name); `set_account_name()` for backfill; auto-backfills `google_sub` and account_name from Google profile on first Google login for existing users
- `auth.py`: `AuthRequest` gains `account_name` field for email/password registration; new `POST /api/auth/google` and `POST /api/auth/account-name` endpoints; `login`/`register`/`me` responses return `account_name`
- `seed_user`: includes `account_name="Admin"`; backfills on existing admin records

**Frontend:**
- `index.html`: loads GIS script
- `LoginScreen.tsx`: "Continue with Google" button with Google logo SVG; account name input during email/password registration; account name popup for first-time Google users
- `App.tsx`: `authUser` gains `accountName`; header displays name instead of email; backfill popup for old accounts missing name; refreshes from `/me` on mount

**Behavior:**
| Sign-In Method | Existing Email+Password User | New User | Old Account (no account_name) |
|---|---|---|---|
| Email + Password | Login (unchanged) | Register with account_name | Login, backfill popup shown |
| Google | Login (matched by email) | Popup for account_name, then create | Login, backfill popup shown |

**Client ID:** `249337992826-jm174i5bqdhr4bfqpmip44gnnp4eo2eh.apps.googleusercontent.com` (from `data/accesskeys.ini` `[googlesignin]` section)


## Phase 13 — Implementation Status

| Feature | PR | Status |
|---------|-----|--------|
| Fyers Live Streaming | PR #279 | ✅ Merged to dev |
| Chart Structures | PRs #282, #284, #286, #288, #290 | ✅ Merged to dev |
| Vite HMR disable | PR #292 | ✅ Merged to dev |
| Advanced Analysis — Trade Labelling + Stats | PR #296 | ✅ Merged to dev |
| Stepwise session_type persist fix | PR #298 | ✅ Merged to dev |
| Google Sign-In + Account Name | direct commit | ✅ Merged to dev |
| RingQueue maxsize increase (3000→12000) | direct commit | ✅ Merged to dev |
| GuardRails-MaxSize | PR #303, #306 | ✅ Merged to dev |
| Top Pattern | pending | ✅ Complete |

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
| Google Sign-In + Account Name | dev (direct commit) | Merged to dev |
| RingQueue maxsize increase (3000→12000) | dev (direct commit) | Merged to dev |
| GuardRails-MaxSize — limit total capital in use | feature/guardrail-maxsize | PR #303, #306 merged to dev |
| Top Pattern — rank patterns per chart | feature/top-pattern | pending |



##### GuardRails-MaxSize
This is a new guardrail, which specifies how much maximum % of capital or exact capital by value, is allowed to be risked at any moment in the market or in other words the maximum capital that can be used for trading at any time. Whether it is % of capital or the exact capital value it can be a part of settings with a switch with a checkbox as we have for strategies. This value from settings for this guardrail will be stored. The settings will include also an enable button if this guardrail is enabled. Once done, everytime a new position it taken it is supposed to be checked whether the new position is going to be allowed, provided it doesn't increase the total % of capital or value of capital currently in use currently doesn't exceeed the threshold.


##### Top Pattern ✅ Complete

Users can designate top 1, top 2, and biggest fail (bottom 1) patterns per daily chart.
These rankings are stored on the PatternAnnotations item as a `top_patterns` JSON field
and displayed as distinct medal-styled markers in charts and gallery cards.

**Data Model:**
- No new DynamoDB table — `top_patterns` is a JSON string attribute on existing `PatternAnnotations` items
- Structure: `{"top_1": {"strategy_name": "X", "category": "Y", "instrument": "CE"}, "top_2": {...}, "bottom_1": {...}}`
- Identifies patterns by `(strategy_name, category, instrument)` tuple — the logical pattern identity

**Backend:**
- `pattern_logger_service.py`: `_parse_top_patterns()` handles str/dict parsing; `create_chart()`/`update_chart()` accept optional `top_patterns` dict; `list_charts_for_user()` gains `top_only` filter; `_chart_to_meta_filtered()` includes `top_patterns` and `has_top_patterns` boolean in metadata
- `pattern_logger.py`: `TopPatternItem` and `TopPatternsPayload` Pydantic models; `CreateChartRequest`/`UpdateChartRequest` accept `top_patterns`; `GET /charts` gains `top_only` query param

**Frontend (`PatternLibrary.tsx`):**
- **Create mode**: Top Pattern ranking toolbar shown when chart is loaded — three dropdowns (🥇 Top 1, 🥈 Top 2, ❌ Bottom 1), each populated from unique pattern identities derived from annotations
- **Marker styling**: `buildMarkers()` accepts `topPatterns`; ranked annotations get gold/silver/red colors, larger marker size, and medal emoji badges in text; non-ranked annotations show `{category}/{strategy_name}` as before
- **Gallery cards**: Badge chips showing 🥇 Top 1 / 🥈 Top 2 / ❌ Worst when `has_top_patterns` is true
- **Gallery filter**: "Top Patterns Only" checkbox alongside existing category/strategy dropdowns; calls `api.patternListCharts(strategy, category, topOnly)` with `top_only=true`
- **Persistence**: Top patterns load with chart on Load Chart / gallery Load; save with chart on Save Annotations

**Files changed:**

| File | Change |
|------|--------|
| `backend/app/services/pattern_logger_service.py` | `_parse_top_patterns`, `top_patterns` in create/update/list/meta |
| `backend/app/routers/pattern_logger.py` | `TopPatternItem`, `TopPatternsPayload` models; `top_patterns` in request models; `top_only` query param |
| `backend/tests/test_pattern_logger.py` | Mock `update_item` handles `:tp` value |
| `frontend/src/services/api.ts` | `TopPatternItem`, `TopPatterns` types; `top_patterns` in create/update body; `topOnly` param in listCharts |
| `frontend/src/pages/PatternLibrary.tsx` | Top pattern state, toolbar UI, `buildMarkers` ranking, gallery badges + filter |

