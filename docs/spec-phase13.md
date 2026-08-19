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
| Top Pattern | PR #309, #311 | ✅ Merged to dev |
| Pattern Filter Fix | PR #313 | ✅ Merged to dev |
| Structures Next/Prev + Chart Size + Pattern Underlying Filter | PR #315 | ✅ Merged to dev |
| Underlying Only checkbox fix | PR #317 | ✅ Merged to dev |
| Buy/Sell Marker Drawing Tools | PR #319 | ✅ Merged to dev |
| Stepwise Trade Labeling + Snapshot OHLC Fix | PR #326 | ✅ Merged to dev |
| Pattern V/S Trading Comparison | WIP | ⏳ In Progress (PR pending) |

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
| Top Pattern — rank patterns per chart | feature/top-pattern | PR #309 merged to dev |
| Top Pattern — remove instrument from identity for options | fix/top-pattern-remove-instrument | PR #311 merged to dev |
| Pattern filter fix — gallery respects category, preserve filter on load, fix card width | fix/pattern-gallery-filter-and-width | PR #313 merged to dev |
| Structures Next/Prev nav + larger chart + Pattern underlying-only filter | feat/structures-nav-and-pattern-filter | PR #315 merged to dev |
| Underlying Only checkbox fix — filter load panes, not gallery | feat/underlying-only-fix | PR #317 merged to dev |
| Buy/Sell Marker Drawing Tools — markers in drawing toolbar | feat/buy-sell-marker-drawing-tools | PR #319 merged to dev |
| Stepwise Trade Labeling + Snapshot OHLC Fix | feat/stepwise-labeling-and-snapshot-fix | PR #326 merged to dev |
| Pattern V/S Trading Comparison — 2×2 grid side-by-side comparison | feat/pattern-vs-trading-comparison | PR #337 merged to dev |
| Pattern V/S Trading Comparison — 2×2 grid + maximize + filters | feat/pattern-vs-trading-comparison (updates) | WIP |



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



##### Buy/Sell Marker Drawing Tools ⏳ Pending

Two new drawing tools — Buy Marker and Sell Marker — added to the drawing tool dropdown
alongside existing H-Line, Trend, Fib, and Channel tools. These place single-click marker
annotations (similar to Pattern Library's entry/exit markers) on any chart pane.

**Marker style (matching Pattern Library entry/exit-underlying):**
- **Buy Marker**: arrowUp shape, belowBar position, color `#3b82f6` (blue), text "Buy UL", size 2
- **Sell Marker**: arrowDown shape, aboveBar position, color `#f97316` (orange), text "Sell UL", size 2

**Behavior:**
- Select Buy Marker or Sell Marker from the Draw ▾ dropdown
- Click anywhere on the chart to place the marker (1-click operation)
- Markers are stored in the drawings stack and can be cleared with the Clear button (LIFO)

**Files changed:**

| File | Change |
|------|--------|
| `frontend/src/components/Chart.tsx` | `DrawMode` type + `buymarker`/`sellmarker`; marker creation in `subscribeClick`; dropdown items; `clearLastDrawing` switch case; status text |
| `frontend/src/pages/PatternLibrary.tsx` | Same changes in `ChartPane`: `DrawMode`, `Drawing` types, marker creation, dropdown items, clear logic, status text |



##### Snapshot OHLC Full-Session Fix ⏳ Pending

Previously, snapshot charts truncated all OHLC bars after the snapshot's timestamp
when navigating through events. This meant successive events never showed bars beyond
their own moment in time — you couldn't see the full session's price action.

**Root cause:** Both `SnapshotChart` and `SnapshotOptionsChart` used
`sorted.filter(c => c.time <= barTime)` to discard bars after each event's time.

**Fix:** Remove the truncation filter entirely. Load all bars for the entire session
and only replace the bar at the snapshot's exact moment with the in-progress OHLC.
All bars before and after remain visible, so navigating through events progressively
reveals markers and overlays against the full session chart.

**Files changed:**

| File | Change |
|------|--------|
| `frontend/src/components/EventSnapshotViewer.tsx` | Both chart components: remove `filter(<= barTime)`, replace only matching bar via `findIndex` |



##### Stepwise Trade Labeling ✅ Complete

When a round-trip completes during stepwise trading (position goes from >0 to zero,
detected per-right: equity/CE/PE), show a labeling popup at the bar boundary
(before the user can advance to the next bar).

**Flow:**
1. Position-to-zero transitions are tracked in a ref during stepwise mode
2. When `bar_paused` fires (bar boundary reached), any pending completed trades
   trigger a popup
3. The popup collects: Expected Pattern (category + strategy dropdowns),
   Actual Pattern (category + strategy dropdowns), Entry Tag (datalist with
   suggestions), Exit Tag (datalist with suggestions)
4. Labels are persisted to the existing `TradeLabels` DynamoDB table
   (reuses the `/api/analysis/labels` endpoint)
5. User can "Skip" to continue without labeling, or "Save & Continue"
6. The wrapped `nextBar` call blocks while the popup is visible
7. Clearing/dismissing the popup allows the next bar to advance normally

**Files changed:**

| File | Change |
|------|--------|
| `frontend/src/components/StepwiseLabelPopup.tsx` | **New** — popup component with pattern/tag dropdowns, save via existing API |
| `frontend/src/components/SettingsModal.tsx` | New toggle "Enable trade labeling popup in stepwise mode" in General tab |
| `frontend/src/App.tsx` | Position tracking ref, bar_paused detection, wrapped nextBar, popup render, settings gate |

##### Pattern V/S Trading Comparison ⏳ In Progress

See [implementation plan](./pattern-vs-trading-comparison-plan.md) for detailed design and file changes.

In the analysis window, users can compare trades taken against pattern annotations saved for the same day. A "📊 Compare" button appears on each analysis group card (next to 📸 Snapshots) when a pattern chart exists for that date/symbol.

**Layout**: Full-page 2×2 grid for options, single-row for equity

**Options mode (2×2 grid):**
- **Top-left**: Trade markers on underlying with All/CE/PE filter buttons
- **Top-right**: Pattern markers on underlying with UL/CE/PE instrument filter pills
- **Bottom-left**: Collapsible CE/PE trade charts per strike with marker labels
- **Bottom-right**: Collapsible CE/PE pattern charts per strike with annotations
- All 4 panes have ⤢ maximize buttons
- Category+strategy filter dropdowns apply to both underlying and option panes

**Equity mode:** Single row side-by-side (trades | patterns)

**Files changed:**

| File | Change |
|------|--------|
| `frontend/src/services/patternMarkers.ts` | **New** — shared marker utilities extracted from PatternLibrary |
| `frontend/src/components/PatternVsTradeComparison.tsx` | **New** — full-page 2×2 comparison view |
| `frontend/src/components/TradeAnalysis.tsx` | `getMarkerText` prop on AnalysisChart; Compare button + pattern check in GroupCard |
| `frontend/src/pages/PatternLibrary.tsx` | Import from patternMarkers instead of local definitions |
##### Bug Fix: Breeze Paper Session Streaming (BUG-XIII-1) ✅ Complete

Fixed a critical bug where paper trading sessions using Breeze (ICICI Direct) as the live streaming source never received ticks despite successful WebSocket connection and subscription.

**Root cause:** Two independent bugs:
1. `_get_breeze()` was called up to 3× per paper session (Phase-1 equity fetch, Phase-1 options fetch, Phase-2 WebSocket), each calling `generate_session()` which invalidated previous sessions on Breeze's server. The WebSocket subscribed successfully but silently received no ticks.
2. `BreezeStreamManager._on_ticks` used `not self._queue` which evaluated to `True` for empty `RingQueue` objects (custom queue with `__len__` but no `__bool__`), silently discarding every tick.

**Fix:**
1. Cached `BreezeConnect` in `_get_breeze()` by credential key — single `generate_session()` per process
2. Changed guard to `self._queue is None` (identity check instead of truthiness)
3. Throttled diagnostic logging: first 6 candles, then every 60th up to 300 candles

**Files:** `backend/app/services/broker_service.py`, `backend/app/services/breeze_service.py`

**Test script:** `scripts/test_breeze_paper_flow.py` — standalone diagnostic replicating Phase 1+2 flow

##### Bug Fix: Breeze BFO Option Tick Identity (BUG-XIII-2) ✅ Complete

Fixed Breeze paper and real trading sessions for BSE SENSEX (BSESEN) options — option ticks were arriving on the WebSocket but losing their `right` (CE/PE) and `strike_price` identity because Breeze's BFO WS payloads omit those fields and only carry the raw ScripCode in `symbol` (e.g. `8.1!855562`).

**Root cause:** Three independent issues:
1. `_on_ticks` read `tick["right"]` which is absent on BFO option ticks.
2. `breeze.get_quotes()` is unreliable for BFO (returns empty/non-JSON), so it couldn't be used at subscribe time to discover the ScripCode→(right, strike) mapping.
3. `quotes: "Quotes Data"` collides with Breeze index ticks — using it as an option discriminator in the test script misclassified the SENSEX index tick and prevented CE/PE subscription.

**Fix:**
- **`backend/app/services/breeze_master.py`** (new) — shared module that downloads the Breeze Security Master zip (`https://directlink.icicidirect.com/NewSecurityMaster/SecurityMaster.zip`) once per day (Breeze regenerates at 8 AM), caches under `<DATA_DIR>/ICICISecurityMaster/`, and exposes `load_breeze_security_master(stock_code, exchange_code, strike, right, expiry_breeze)` returning `{ScripCode: (strike, right)}`. Falls back to local `FOBSEScripMaster.txt` / `FONSEScripMaster.txt` if present.
- **`backend/app/services/breeze_service.py`** — `BreezeStreamManager` now builds `_option_scrip_map` at subscribe time via the master loader. `_on_ticks` detects option ticks by `OI`/`CHNGOI` presence (option-only fields), and for BFO ticks lacking `right`, parses `tick["symbol"].rsplit("!", 1)[-1]` to look up the ScripCode in the map. Candle keys become `8.1!855562_CE` / `8.1!855562_PE` — distinct accumulators with correct `right` in the candle payload.
- **`scripts/test_broker_streaming.py`** — uses the same `breeze_master` loader. Also added `--symbol NIFTY|BSESEN` flag (full per-broker config: exchange code NFO/BFO, base name NIFTY/SENSEX, strike interval 50/100, weekly expiry Thursday always for SENSEX). Dropped the noisy full-tick log dump.

**Files:** `backend/app/services/breeze_master.py` (new), `backend/app/services/breeze_service.py`, `scripts/test_broker_streaming.py`, `backend/tests/test_breeze_master.py` (new), `backend/tests/test_breeze_service.py`.

**Tests:** 29 pass — daily-refresh cutoff, cache freshness, download path, master filter by (strike, right, expiry), BFO tick resolution, equity fallback when ScripCode unknown.

**Bug doc:** `docs/bugs.md` Phase-XIII BUG-XIII-2 entry.

##### Auto-Stoploss on Entry ⏳ In Progress

Users can optionally specify a stoploss price when placing any entry order (TARGET, LIMIT, MARKET, or AutoStop strategy). When the entry order fills, the system automatically places a matching STOPLOSS order for the filled quantity. Works across simulated, paper, real/Kotak, and stepwise trading sessions.

**Architecture:**
- `EntryStoplossWatcher` (`backend/app/services/entry_sl_watcher.py`) — passive observer that hooks into order-fill events
- Triggers on `order_filled` events in `_emit_tick_and_check_orders()` (sim/paper/stepwise) and Kotak fill callbacks (real)
- For real sessions: configurable delay timer (default 3 s) to handle partial fills from Kotak. Timer resets on additional fills in the same group
- Uses `group_id` to link entry + auto-SL orders in the UI

**Settings:**
- `entry_auto_sl_enabled` (default `false`) — global toggle in Settings
- `entry_auto_sl_delay_sec` (default `3`, range 1–30) — delay for real/Kotak sessions

**Order model changes:**
- `entry_sl_price: float | None` — stoploss price specified at entry time
- `group_id: str | None` — shared UUID linking entry order with its auto-placed SL

##### Feature: In-Session Trade Labeling (Button-Based) ⏳ In Progress

Replaces / extends the stepwise-only trade-labeling popup with a persistent
**button-based labeling surface** that works in **all session types**
(stepwise / sim / paper / real). Users click a button on the right-side
position card to capture entry labels for the current open trade; when a
trade closes, it moves into a "Pending exit labels" sub-section where the
user can capture the actual outcome.

**Field mapping (entry vs exit):**

- **Entry label** (captured while position is open): `expected_category`, `expected_strategy`, `entry_tag`
- **Exit label** (captured after position closes): `actual_category`, `actual_strategy`, `exit_tag`

Both writes target the same DDB row keyed by `(session_id, round_trip_index)`.
The backend upsert preserves whichever fields are already saved
(`trade_label_service.save_labels:209-220`), so a partial save (entry-only
or exit-only) is fully supported. No backend changes required.

**Per-session-type toggle (Settings → Trade Labeling Mode):**

| Mode | Effect |
|---|---|
| `Popup` (default for stepwise) | Keeps existing `StepwiseLabelPopup` behavior — fires at bar close in stepwise mode. |
| `Button` (default for sim/paper/real) | Renders `PendingLabelPanel` inside the right-side `TradePanel` card; users click to label. |
| `Off` | No labeling surface at all for that session type. |

Storage: single localStorage key
`tradeLabelingModeByType: { stepwise, sim, paper, real }` with default
`{ stepwise: 'popup', sim: 'button', paper: 'button', real: 'button' }`.
Migrate the existing `stepwiseLabelingPopupEnabled` key into this structure
on first load (`'false'` → `'off'`, otherwise `'popup'`).

**Panel layout (mounted at top of `TradePanel` card):**

```
┌─────────────────────────────────────────┐
│ Pending exit labels                     │ ← only when ≥1 closed-and-unlabeled RT
│ ┌─────────────────────────────────────� │
│ │ NIFTY 24750 CE (closed)             │ │
│ │ P&L +620.50  2 min ago              │ │
│ │ Actual pattern: [Cat ▼] [Strat ▼]   │ │
│ │ Exit tag: [AS_PER_PATTERN] [Save]   │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ Label current open trade                │ ← only when a position is open AND user
│ ┌─────────────────────────────────────� │   hasn't already saved entry for this RT
│ │ NIFTY 24750 CE  Qty 50 LONG         │ │
│ │ Expected: [Cat ▼] [Strat ▼]         │ │
│ │ Entry tag: [AS_PER_PATTERN]          │ │
│ │ [Save entry label]                   │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

If only one leg is open, only that leg's form shows. If both CE and PE
positions are open, a single combined form with two leg rows.

**RT detection across all session types:**

Generalize the existing stepwise-only detection in `App.tsx:220-246`.
Instead of triggering on `sim.barPaused`, trigger on every `sim.trades`
change and maintain a per-leg `lastNetQtyRef` snapshot. When any leg
transitions non-zero → zero AND the user has saved entry labels for that RT,
push the RT into the **pending exit labels** queue. When the RT index
increments past the saved-entry index, also push to queue (in case the user
skipped entry labeling).

This is a small refactor: extract the body of the existing
`useEffect(() => { if (!sim.stepwise || !sim.barPaused) return ... }, ...)`
into a helper `useRoundTripCompletionWatcher()` that always runs but
gates by `sim.sessionId && sim.trades`. Reuse `rtIndexCounterRef` and
`lastNetQtyRef`.

**Save semantics:**

- **Entry save**: writes `expected_category`, `expected_strategy`,
  `entry_tag` via existing `POST /api/analysis/labels`. Other fields
  default to empty / `AS_PER_PATTERN`.
- **Exit save**: writes `actual_category`, `actual_strategy`, `exit_tag`
  for the same `(session_id, round_trip_index)`. Backend upsert preserves
  entry values, only updates the four fields the caller provides.
- **Both saves**: backend stamps `round_trip_pnl` and
  `round_trip_pnl_pct` automatically (`trade_label_service.py:196-199`).

**Auto-clear trigger:** When a leg transitions non-zero → zero, that RT
moves from "current open" sub-section into "pending exit labels"
sub-section. When the user saves the exit label, it disappears from the
pending list. When all legs are flat AND pending list is empty, the panel
collapses.

**Suggestion sources (reused from `TradeLabeling.tsx` / `StepwiseLabelPopup.tsx`):**
- `api.patternListStrategies()` → expected/actual strategy selects
- `api.patternListCategories()` → expected/actual category selects
- `api.getEntryTags()` → entry tag datalist
- `api.getExitTags()` → exit tag datalist

**Files:**
| File | Change |
|---|---|
| `frontend/src/hooks/useSimulation.ts` | +`pendingExitLabels`, `currentOpenEntry`, save methods, `useRoundTripCompletionWatcher` |
| `frontend/src/components/PendingLabelPanel.tsx` | **New** — entry + exit forms, suggestion loading |
| `frontend/src/components/TradePanel.tsx` | +`pendingRts`, `currentOpenRt`, save-handler props, render panel |
| `frontend/src/App.tsx` | wire new state, gate `StepwiseLabelPopup`, pass props to `TradePanel` |
| `frontend/src/components/SettingsModal.tsx` | replace stepwise checkbox with per-type mode selector + migration |
| `frontend/src/components/PendingLabelPanel.test.tsx` | **New** — Vitest + RTL tests |
| `frontend/src/hooks/__tests__/useSimulation.test.ts` | **New or extend** — RT completion watcher tests |

**Tests:** entry/exit save payload correctness, panel hidden when nothing pending, suggestion loading, RT completion across multi-leg sessions, session-restart reset.

**Verification:**
1. Settings → Trade Labeling Mode → confirm stepwise defaults to "Popup" and others to "Button". Switch all to "Button", save, reload, confirm persistence.
2. Sim session: Buy 50 equity → entry form appears → fill + Save → POST `/api/analysis/labels` fires, panel collapses for entry.
3. Sell 50 equity → "Pending exit labels" appears with that RT → fill actual + exit tag → Save → entry values preserved, exit fields stamped.
4. Trade Analysis modal confirms saved labels round-trip.
5. Options session: Buy 50 CE → label entry → Sell → pending exit shows → label exit. Confirm CE and PE legs handled independently when both open.
6. Stepwise with mode='Button': closed-position RTs appear in "Pending exit labels" instead of popup. Click Save, advance bar.

**Regression:** existing `StepwiseLabelPopup` still works when stepwise mode is `'popup'`. Existing `TradeLabeling.tsx` (analysis tab) post-hoc flow untouched.

**UI (OrderPanel):**
- Expandable "Stoploss on entry" section in TARGET, LIMIT, and Mkt tabs
- Absolute price input with chart-click selection
- Validation: SL < entry_price for BUY, SL > entry_price for SELL
- Disabled when `entry_auto_sl_enabled` is off

**AutoStop strategy support:**
- `StartStrategyRequest.entry_sl_price` — optional, auto-places SL when AutoStop TARGET fills
- Group ID generated server-side in `_on_bar_close_autostop()`

**Stepwise mode:**
- SL order placed in the same bar's tick loop
- If price reverses to SL trigger within the same bar, both entry and exit trades execute

**Files changed:**

| File | Change |
|------|--------|
| `backend/app/models/schemas.py` | Added `entry_sl_price`, `group_id` to `Order` and `PlaceOrderRequest`; added `entry_auto_sl_enabled/delay` to user settings models; added `entry_sl_price` to `StartStrategyRequest` |
| `backend/app/services/entry_sl_watcher.py` | **New** — `on_entry_filled()`, `_place_sl_immediately()`, `_schedule_delayed_sl()`, `cancel_pending_for_group()` |
| `backend/app/services/order_service.py` | `place_order()` accepts `entry_sl_price` + `group_id`; `_write_order_to_db()` persists them |
| `backend/app/services/simulation.py` | `_emit_tick_and_check_orders()` calls `on_entry_filled()` after fills |
| `backend/app/services/strategy_service.py` | `_on_bar_close_autostop()` passes `entry_sl_price` + `group_id` when placing TARGET |
| `backend/app/services/user_settings_service.py` | Added `entry_auto_sl_enabled` + `entry_auto_sl_delay_sec` defaults |
| `backend/app/routers/orders.py` | Passes `entry_sl_price` from `PlaceOrderRequest` to `place_order()` |
| `backend/app/routers/strategies.py` | Passes `entry_sl_price` from `StartStrategyRequest` to metadata |
| `frontend/src/services/api.ts` | `Order` interface + `placeOrder` body include `entry_sl_price`, `group_id` |
| `frontend/src/components/OrderPanel.tsx` | Expandable "Stoploss on entry" section in entry tabs |
| `frontend/src/components/SettingsPopup.tsx` | Toggle + delay input for entry auto-SL |

##### Max Price Threshold Strike Mode ⏳ In Progress

Alternative to OTM offset for choosing option strikes: pick a max contract price
threshold instead of a fixed number of strikes OTM. The system scans outward from
ATM and picks the first strike whose option price ≤ the threshold.

**Applicability:** Indices only (NIFTY, BSESEN). Stocks continue using OTM offset.

**How it works:**
- User picks a threshold (e.g. ₹50) from a dropdown
- System starts at ATM strike, loads option price at reference time from cached
  parquet data (sim/stepwise) or Breeze narrow-window fetch (paper/real)
- Scans outward one strike interval at a time until price ≤ threshold
- CE scans UP (higher strikes → lower premiums), PE scans DOWN

**Threshold dropdown values:**
- NIFTY (interval 50): 25, 50, 75, 100, 125, 150
- SENSEX (interval 100): 50, 100, 150, 200, 250

**Mid-session pane add:** Works identically — calls the same backend endpoint
with the current bar time as reference_time. If API fails, falls back to OTM offset.

**Settings:**
- `max_price_mode: "otm" | "threshold"` (default `"otm"`)
- `max_price_threshold_ce: float` — CE threshold
- `max_price_threshold_pe: float` — PE threshold

**Backend endpoint:**
- `GET /api/data/options/find-strike-by-price?symbol=&date=&expiry=&right=&max_price=&reference_time=`
  Returns `{ strike, price, symbol, date, right }`

**Files changed:**

| File | Change |
|------|--------|
| `backend/app/services/options_service.py` | `find_strike_by_max_price()` + `_get_option_price_at()` |
| `backend/app/routers/data.py` | `GET /api/data/options/find-strike-by-price` endpoint |
| `backend/app/services/user_settings_service.py` | `max_price_mode`, `max_price_threshold_ce`, `max_price_threshold_pe` defaults |
| `backend/app/models/schemas.py` | New fields on UserSettingsResponse/UpdateRequest |
| `frontend/src/components/SettingsModal.tsx` | "OPTION STRIKE MODE" section with OTM/Threshold toggle + threshold dropdowns |
| `frontend/src/components/SessionControls.tsx` | Use threshold mode on session start for indices |
| `frontend/src/services/api.ts` | `findStrikeByPrice()` API function + UserSettingsResponse fields |
| `frontend/src/App.tsx` | Async addPane with threshold mode for mid-session CE/PE adds |

##### SEBI Market Close Adjustment (15:15 effective 03 Aug 2026) ✅ Complete

SEBI changed the closing price determination time from 15:30 to 15:15 effective
03 August 2026. All data fetching, OHLC rendering, and live streaming respect this
new cutoff for dates on or after the threshold.

**Implementation:**
- `config.get_market_close(date_str)` — date-aware function returning `"15:15:00"` for
  dates >= `"2026-08-03"`, `"15:30:00"` otherwise
- All callsites that use `MARKET_CLOSE` now use `get_market_close(date)`:
  - `data_loader.validate_and_fill_gaps()` — reindex window end
  - `broker_service._fetch_day_paginated()` — Breeze fetch upper bound
  - `options_service._fetch_options_day_paginated()` — Breeze options fetch upper bound
  - `options_service._validate_options_gaps()` — options reindex window end
  - `kite_service.fetch_kite_1min()` / `fetch_kite_1min_options()` — historical date bound
- **Live stream cutoff**: Phase 3 in both `_run_paper_session()` and `_run_real_session()`
  drops ticks with `time >= market_close_ts` for post-cutoff dates — no 15:15–15:30
  streaming data reaches the chart

**Threshold constant:** `_NEW_CLOSE_CUTOFF = "2026-08-03"`, easy to adjust if SEBI
revises further.

**Files:** `backend/app/config.py`, `backend/app/services/data_loader.py`,
`backend/app/services/broker_service.py`, `backend/app/services/options_service.py`,
`backend/app/services/kite_service.py`, `backend/app/services/simulation.py`
