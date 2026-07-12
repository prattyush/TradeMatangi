# Chart Structure Feature — Implementation Plan

## Overview
Users can browse daily charts classified by **Opening**, **Midday**, and **Closing** structure types. Pre-defined classifications are system-generated and visible to all users. Users can create custom classifications and share them via the existing pattern-sharing mechanism.

A standalone script classifies historical data and stores results. A new backend service + API serves these, and a new frontend page provides browsing with multi-select filtering, a gallery grid, and per-chart editing.

---

## Classification Rules (Final, per spec + clarifications)

### Opening Types (in priority order, first match wins)
`y_range = abs(y_open - y_close)`, `y_low = min(y_open, y_close)`, `y_high = max(y_open, y_close)`

1. **within_yesterdays_range** — today's `open` ∈ [y_low, y_high]
2. **within_day_before_yesterdays_range** — same check against DBY's range
3. **gap_up_down** — today's `open` ∈ [y_low − 2×y_range, y_high + 2×y_range]  
4. **big_gap_up_down** — today's `open` outside the 2×y_range band in either direction
5. **undefined** — yesterday/DBY data unavailable

### Midday Types (based on first 15-min candle, 09:15–09:29)
`range_15 = high_15min − low_15min`

1. **trading_range** — `close_at_12` ∈ [low_15min, high_15min]
2. **breakout** — `close_at_12` > high_15min + 2×range_15 OR < low_15min − 2×range_15
3. **trend** — outside [low_15min, high_15min] but within 2×range_15
4. **undefined** — range_15 < 1e-8 (degenerate), or no data at 12:00

### Closing Types (applied in priority order)
`mid_range = |open − close_at_12|`, `mid_low = min(open, close_at_12)`, `mid_high = max(open, close_at_12)`
`midday_up = (close_at_12 > open)`

1. **trading_range** — `day_close` ∈ [mid_low, mid_high]
2. **breakout** — outside 2×mid_range, same direction as open→close_at_12
3. **reversal_breakout** — outside 2×mid_range, opposite direction
4. **trend** — within 2×mid_range, same direction, outside trading range
5. **trend_reversal** — within 2×mid_range, opposite direction, outside trading range
6. **undefined** — mid_range < 1e-8 (open ≈ close_at_12), or no data

---

## Database

### New Tables

**ChartStructures** (in `scripts/setup-dynamodb-tables.py`):

| Property | Value |
|---|---|
| PK (HASH) | `chart_structure_id` (S, UUID) |
| GSIs | `UserIdIndex` on `user_id` (S); `SymbolDateIndex` on `symbol` (S, HASH) + `date` (S, RANGE) |
| BillingMode | PAY_PER_REQUEST |

Item attributes: `chart_structure_id`, `symbol`, `date`, `opening_type`, `midday_type`, `closing_type`, `is_predefined` (BOOL), `user_id` (S), `created_at`, `updated_at`

Predefined records have `user_id = "__SYSTEM__"`, `is_predefined = true`. User-custom records have their real `user_id`, `is_predefined = false`.

**ChartStructureShares** (same pattern as PatternShares):

| Property | Value |
|---|---|
| PK (HASH) | `owner_user_id` (S) |
| SK (RANGE) | `shared_user_id` (S) |
| GSI | `SharedUserIdIndex` on `shared_user_id` (S) |
| BillingMode | PAY_PER_REQUEST |

### Sharing
Reuse the existing `pattern_share_emails` mechanism in UserSettings. When pattern shares are synced, also sync chart structure shares via the same email list. No separate settings field needed — "sharing option taken from settings, like what we do in patterns."

---

## Files to Create

### 1. `scripts/classify_chart_structures.py` — Batch Classification Script

```
Usage:
  python scripts/classify_chart_structures.py --symbol NIFTY --start 2025-01-01 --end 2026-07-10
  python scripts/classify_chart_structures.py --symbol ALL --start 2025-01-01 --end 2026-07-10
```

- Imports from `backend/app/services/data_loader` and `backend/app/config` directly (no HTTP API calls)
- For each trading day: loads yesterday + DBY OHLC for opening type, same-day OHLC for midday/closing types
- Idempotent: queries `SymbolDateIndex` first, skips if already classified
- 12:00 PM close: uses last row at or before `12:00:00` IST (forward-fill via `.loc[:noon].iloc[-1]`)
- Writes to DynamoDB `ChartStructures` with `is_predefined=True`, `user_id="__SYSTEM__"`
- Edge cases: weekends/holidays skipped via `is_trading_day()`, missing parquet → log warning + skip, `range < 1e-8` → "undefined"

### 2. `backend/app/services/chart_structure_service.py` — Service Layer

Functions:
- `get_predefined_types()` → hardcoded {opening_types, midday_types, closing_types} with value+label dicts
- `list_structures(user_id, opening_types, midday_types, closing_types, symbol, start_date, end_date)` — multi-filter query using SymbolDateIndex + in-memory type filtering
- `get_structure_for_user(user_id, structure_id)` → returns structure with `can_delete` flag (true for own + system, false for shared)
- `create_structure(user_id, symbol, date, opening_type, midday_type, closing_type)` → writes to ChartStructures
- `update_structure(structure_id, opening_type, midday_type, closing_type)` → owner-only
- `delete_structure(structure_id)` → owner-only
- `sync_structure_shares(owner_user_id, emails_csv)` → mirrors `sync_pattern_shares()` pattern
- `_load_shared_owner_ids(user_id)` → includes shared owner IDs for gallery queries

### 3. `backend/app/routers/chart_structures.py` — API Router

Prefix: `/api/chart-structures`

| Method | Path | Purpose |
|---|---|---|
| GET | `/types` | Return predefined opening/midday/closing types with labels |
| GET | `/structures` | Query: `opening_types`, `midday_types`, `closing_types`, `symbol`, `start_date`, `end_date`. Returns matching structures. |
| GET | `/structure/{id}` | Full structure record |
| GET | `/ohlc/{symbol}/{date}` | OHLC candles for a specific date (reuses data_loader pattern) |
| POST | `/structure` | Create user-custom classification |
| PUT | `/structure/{id}` | Update (owner only) |
| DELETE | `/structure/{id}` | Delete (owner only) |

### 4. `frontend/src/pages/ChartStructures.tsx` — Main Frontend Page

Structure:
```
ChartStructures
├── FilterHeader
│   ├── OpeningTypeDropdown (multi-select checkboxes)
│   ├── MiddayTypeDropdown (multi-select)
│   └── ClosingTypeDropdown (multi-select)
├── GalleryGrid (responsive columns, 3 wide default)
│   └── StructureCard per chart:
│       - Symbol + Date header
│       - Opening/Midday/Closing type badges (color-coded)
│       - Miniature OHLC sparkline (canvas-based, lightweight)
│       - Click → expands to full view
├── ExpandedView (modal or inline expand)
│   ├── Full OHLC chart (lightweight-charts, read-only, no annotations)
│   ├── ClassificationEditor: three dropdowns to change types
│   ├── Save button for user-defined classification
│   └── "Undefined" option in each dropdown
└── CreateCustomPanel (optional: name a preset of 3 type choices)
```

Key decisions:
- Separate page, navigated via "📊 Structures" button in App.tsx header
- Reuses chart pattern from PatternLibrary simplified: no annotations, no drawing tools, no EMA
- Multi-select: custom dropdowns with checkboxes (no external library)
- Gallery grid uses ResizeObserver for responsive columns (same as PatternLibrary)
- Miniature OHLC: HTML5 canvas sparkline (not full lightweight-charts instance) for performance with 100+ cards

---

## Files to Modify

### 5. `scripts/setup-dynamodb-tables.py`
Add `ChartStructures` and `ChartStructureShares` table definitions.

### 6. `backend/app/main.py`
Register `chart_structures.router`.

### 7. `backend/app/services/user_settings_service.py`
In `update_settings()`, when `pattern_share_emails` changes, also call `chart_structure_service.sync_structure_shares()`.

### 8. `frontend/src/services/api.ts`
Add `ChartStructureType`, `ChartStructureItem` interfaces and all API methods.

### 9. `frontend/src/App.tsx`
Add `showChartStructures` state, "📊 Structures" nav button, conditional render.

---

## Execution Order
1. Database: update `setup-dynamodb-tables.py`, run it
2. Script: create `classify_chart_structures.py`, test on small range
3. Service + Router: create `chart_structure_service.py` + `chart_structures.py`
4. Wiring: modify `main.py`, `user_settings_service.py`
5. Frontend API: add types/methods to `api.ts`
6. Frontend page: build `ChartStructures.tsx`
7. Nav: modify `App.tsx`
8. End-to-end: classify NIFTY, browse in UI, test edit + sharing

---

## Verification
1. Run `python scripts/classify_chart_structures.py --symbol NIFTY --start 2026-06-01 --end 2026-07-10`
2. Verify ChartStructures table has records via `aws dynamodb scan --table-name ChartStructures --endpoint-url http://localhost:8000`
3. Start backend, browse `GET /api/chart-structures/types` → returns 5 opening + 4 midday + 6 closing types
4. Open frontend → "📊 Structures" button visible → click → gallery loads
5. Multi-select filters work: select "Big Gap Up/Down" in Opening → grid filters correctly
6. Click a card → full OHLC chart renders, edit dropdowns work, save persists
7. Run existing tests: `python -m pytest tests/ -v` → no regressions
