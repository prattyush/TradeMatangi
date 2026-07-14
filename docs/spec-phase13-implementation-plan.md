# Phase 13 — Advanced Analysis: Detailed Implementation Plan

## 1. Overview

**Phase 13 extends Trade Analysis with two features:**
1. **Trade Labelling** — label completed round-trips with expected/actual patterns and entry/exit tags
2. **Stats** — aggregated metrics dashboard filtered by symbol, date range, and session type

### UI Walkthrough

**Current Analysis flow:** 
- User clicks "Analysis" in the main header → full-screen modal opens
- Filters at top (Symbol, Type, Session, From, To, Search)
- Summary stats bar (Days, Win Rate, Total Trades, Total P&L)
- Scrollable list of GroupCards — each group is one `(date, symbol, instrument_type, session_type)` combo
- Clicking a GroupCard expands it: shows trade tables + OHLC chart with markers

**New "Label Trades" tab** (inside expanded GroupCard):
```
┌─ Filter Bar (existing) ──────────────────────────────────────────────────┐
│ Trade Analysis    Symbol [▼] Type [▼] Session [▼] From [__] To [__] [Search] [📊 Stats] │
│                  Days: 5   Win Rate: 60%   Total Trades: 12   Total P&L: +₹1,250   │
├───────────────────────────────────────────────────────────────────────────┤
│ ┌─ 2026-07-10  NIFTY  Options  Paper  ──────────────────────────────────┐ │
│ │ Capital ₹25,000  Net P&L +₹420.50  P&L% +1.68%  Trades 3  [📸 Snapshots] ▼│
│ │ ┌──────────────────────────────────────────────────────────────────────┐│ │
│ │ │ [Trades] │ [Label Trades]                                             ││ │
│ │ ├──────────────────────────────────────────────────────────────────────┤│ │
│ │ │ ┌──────────────────────────┐ ┌──────────────────────────────────────┐││ │
│ │ │ │                          │ │ Round Trip #0 — CE  PnL: +₹420.50    │││ │
│ │ │ │   OHLC Chart             │ │ Entry: BUY 50 @ 19200 (10:15)        │││ │
│ │ │ │   with trade markers     │ │ Exit:  SELL 50 @ 19208 (10:42)       │││ │
│ │ │ │   (3-min candles)        │ │                                      │││ │
│ │ │ │                          │ │ Expected Pattern:                     │││ │
│ │ │ │   ● markers for buys     │ │ [Category ▼] [Strategy ▼]            │││ │
│ │ │ │   ● markers for sells    │ │                                      │││ │
│ │ │ │   number labels (0,1,2)  │ │ Actual Pattern:                       │││ │
│ │ │ │   to match round-trips   │ │ [Category ▼] [Strategy ▼]            │││ │
│ │ │ │                          │ │                                      │││ │
│ │ │ │                          │ │ Entry Tag: [▼ or type new...]         │││ │
│ │ │ │                          │ │ Exit Tag:  [▼ or type new...]         │││ │
│ │ │ └──────────────────────────┘ └──────────────────────────────────────┘││ │
│ │ │ ┌──────────────────────────────────────────────────────────────────────┐│ │
│ │ │ │ Round Trip #1 — PE  PnL: -₹125.00                                    ││ │
│ │ │ │ ...(same fields)...                                                   ││ │
│ │ │ └──────────────────────────────────────────────────────────────────────┘│ │
│ │ │                                                         [Save Labels]  ││ │
│ │ └──────────────────────────────────────────────────────────────────────┘││ │
│ └────────────────────────────────────────────────────────────────────────┘│ │
└───────────────────────────────────────────────────────────────────────────┘
```

**New "Stats" modal** (opens from "📊 Stats" button in Analysis filter bar):
```
┌─ Stats ────────────────────────────────────────────────────── ✕ ────┐
│ Symbol [▼] Type [▼] Session [▼] From [__] To [__] [Search]         │
├─────────────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│ │  Trades  │ │  Win %   │ │ Avg PnL% │ │ P95 PnL% │                │
│ │    42    │ │  54.8%   │ │  +1.23%  │ │  +4.56%  │                │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘                │
│                                                                     │
│ ┌─ By Expected Pattern ──────────────────────────────────────────┐ │
│ │ Category   │ Strategy  │ Trades │ Win% │ Avg PnL% │             │ │
│ │ trend      │ breakout  │   12   │ 58%  │ +2.10%   │             │ │
│ │ reversal   │ vwap      │    8   │ 50%  │ -0.50%   │             │ │
│ │ reversal   │ breakout  │    6   │ 33%  │ -1.80%   │             │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ Mismatch ─────────────────────────────────────────────────────┐ │
│ │ Mismatch Rate: 23.8%                                           │ │
│ │ Profit when Matched: 62.5% | Profit when Mismatched: 40.0%    │ │
│ │ Most Mismatched Expected: trend / breakout (5 mismatches)      │ │
│ │ Most Mismatched Actual:   reversal / vwap (4 mismatches)       │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ By Entry Tag ───────┐ ┌─ By Exit Tag ─────────┐                 │
│ │ Tag      │ N │ Avg%  │ │ Tag       │ N │ Avg%  │                 │
│ │ perfect  │ 8 │ +3.2% │ │ target    │10 │ +2.8% │                 │
│ │ panicked │ 5 │ -1.1% │ │ trailing  │ 6 │ +1.5% │                 │
│ │ as_per   │15 │ +1.0% │ │ scared    │ 3 │ -3.2% │                 │
│ │ pattern  │   │       │ │ as_per    │12 │ +1.0% │                 │
│ │          │   │       │ │ pattern   │   │       │                 │
│ └──────────────────────┘ └───────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Trade Definition (Round-Trip)

A "completed trade" = round-trip. When a user enters a position and exits it entirely, net_qty hits 0, and that's one round-trip. Grouped **per-session, per-right** (CE, PE, underwlying tracked independently). Uses FIFO matching.

Example:
```
Session S1, right=CE:
  BUY  65 @ 19200 (10:15)
  BUY  65 @ 19205 (10:20)
  SELL 130 @ 19210 (10:42)   ← net_qty=0 → Round Trip #0 closed, PnL = +(130×19210 - 65×19200 - 65×19205)

Session S1, right=None (underlying):
  BUY  50 @ 24050 (11:00)
  SELL 50 @ 24080 (11:20)    ← net_qty=0 → Round Trip #1 closed, PnL = +(50×24080 - 50×24050)

Total for S1: 2 round-trips across 2 rights
```

---

## 2. Database Schema

### New Table: `TradeLabels`

DynamoDB table storing one record per labeled round-trip.

```
TableName: TradeLabels
BillingMode: PAY_PER_REQUEST

Primary Key:
  HASH: session_id (String)
  RANGE: round_trip_index (Number)    -- 0-based within a session

GSI: UserIdDateIndex
  HASH: user_id (String)
  RANGE: date (String)               -- YYYY-MM-DD
  ProjectionType: ALL                 -- needed because stats queries need PnL data

Attributes:
  user_id              String    (denormalized from session)
  session_id           String    (PK)
  round_trip_index     Number    (SK)
  symbol               String    (denormalized for stats filtering)
  date                 String    (YYYY-MM-DD, for GSI range key)
  instrument_type      String    ("equity" | "options")
  session_type         String    ("sim" | "paper" | "real")
  round_trip_pnl       Number    (denormalized — total P&L of this round trip)
  round_trip_pnl_pct   Number    (denormalized — PnL / session_capital * 100)
  expected_category    String    (from pattern library dropdowns)
  expected_strategy    String
  actual_category      String    (if user doesn't fill, defaults to same as expected)
  actual_strategy      String
  entry_tag            String    (default "AS_PER_PATTERN")
  exit_tag             String    (default "AS_PER_PATTERN")
  created_at           String    (ISO timestamp)
  updated_at           String    (ISO timestamp)
```

**Why a separate table (not embedding in Sessions/Trades):**
- Stats need to query across date ranges efficiently → GSI
- Labels are independent of session lifecycle (labels persist even if sessions are deleted)
- Clean separation of concerns — follows existing pattern (EventSnapshots, PatternAnnotations are separate tables)

**Why denormalize symbol/date/PnL:** The GSI `UserIdDateIndex` enables efficient date-range queries for stats without needing to join with the Sessions or Trades tables. The round_trip_pnl is computed at label save time from FIFO matching.

---

## 3. Backend Implementation

### 3.1 NEW: `backend/app/services/trade_label_service.py`

Auto-creates the `TradeLabels` table on first use (same pattern as `snapshot_service.py::_ensure_table()`).

**Functions:**

```python
def _ensure_table() -> None
    # Create TradeLabels table if it doesn't exist
    # Uses get_dynamodb_resource() for resource-level API

def _load_session_capital(session_id: str) -> float
    # Query Sessions table for session_capital
    # Fallback to 100000.0 if not found

def compute_round_trips_for_session(session_id: str) -> list[dict]
    # 1. Load trades via analysis_service.get_trades_for_session(session_id)
    # 2. Group by right (None → "underlying", "CE", "PE")
    # 3. For each right group, sort by timestamp, FIFO match
    # 4. Return list of {index, right, entry_trades, exit_trades, pnl}
    # NOTE: Only closes round-trips. Any unclosed position (net_qty != 0)
    # at session end is ignored (spec says: daily trades only, no overflow).

def save_labels(session_id: str, labels: list[dict], user_id: str) -> list[dict]
    # For each label in the batch:
    #   1. Compute round_trip_pnl by running compute_round_trips_for_session
    #      and matching by round_trip_index
    #   2. Load session_capital, compute round_trip_pnl_pct
    #   3. Fetch session metadata (symbol, date, instrument_type, session_type)
    #   4. Upsert: put_item into TradeLabels
    #   5. Set created_at/updated_at
    # Returns list of saved labels with metadata

def get_labels_for_session(session_id: str) -> list[dict]
    # query TradeLabels by PK=session_id, return all items

def list_entry_tags(user_id: str) -> list[str]
    # Scan TradeLabels GSI by user_id
    # Collect distinct entry_tag values where tag != "AS_PER_PATTERN"

def list_exit_tags(user_id: str) -> list[str]
    # Same as above but for exit_tag

def get_stats(user_id: str, symbol=None, start_date=None, end_date=None,
              instrument_type=None, session_type=None) -> dict
    # 1. Query TradeLabels GSI: UserIdDateIndex
    # 2. Filter by symbol, instrument_type, session_type (Python-side)
    # 3. Compute: total_trades, win_pct, avg_pnl_pct, pnl_95th_percentile
    #    per_pattern breakdown, mismatch analysis, by_entry_tag, by_exit_tag
```

**FIFO matching algorithm** (adapted from `guardrail_service.py::_compute_round_trips`):

```python
def _fifo_match_trades(trades: list[dict]) -> list[dict]:
    """
    trades: sorted by timestamp, dicts with {side, quantity, price, right}
    Returns: list of {index, entry_trades[], exit_trades[], pnl, right}
    """
    from collections import defaultdict, deque

    by_right = defaultdict(list)
    for t in sorted(trades, key=lambda x: x.get("timestamp", 0)):
        by_right[t.get("right")].append(t)

    round_trips = []
    index = 0

    for right, rt_trades in by_right.items():
        buy_q = deque()
        sell_q = deque()
        net_qty = 0
        entry_trades = []
        exit_trades = []

        for t in rt_trades:
            qty = int(t.get("quantity", 0))
            price = float(t.get("price", 0))
            side = t.get("side", "BUY")

            if side == "BUY":
                net_qty += qty
                buy_q.append([price, qty])
                entry_trades.append(t)
            else:
                net_qty -= qty
                sell_q.append([price, qty])
                exit_trades.append(t)

            if net_qty == 0 and (buy_q or sell_q):
                total_buy = sum(p * q for p, q in buy_q)
                total_sell = sum(p * q for p, q in sell_q)
                pnl = round(total_sell - total_buy, 2)
                round_trips.append({
                    "index": index,
                    "right": right,
                    "entry_trades": [dict(e) for e in entry_trades],
                    "exit_trades": [dict(e) for e in exit_trades],
                    "pnl": pnl,
                })
                index += 1
                buy_q.clear()
                sell_q.clear()
                entry_trades = []
                exit_trades = []

    return round_trips
```

---

### 3.2 NEW: `backend/app/routers/labels.py`

FastAPI router under prefix `/api/analysis`.

**Pydantic Models:**

```python
from pydantic import BaseModel
from typing import Optional

class RoundTripTradeOut(BaseModel):
    trade_id: str
    side: str
    quantity: int
    price: float
    timestamp: int
    right: Optional[str] = None
    strike: Optional[int] = None

class RoundTripOut(BaseModel):
    index: int
    right: Optional[str]
    entry_trades: list[RoundTripTradeOut]
    exit_trades: list[RoundTripTradeOut]
    pnl: float

class LabelIn(BaseModel):
    session_id: str
    round_trip_index: int
    expected_category: str = ""
    expected_strategy: str = ""
    actual_category: str = ""
    actual_strategy: str = ""
    entry_tag: str = "AS_PER_PATTERN"
    exit_tag: str = "AS_PER_PATTERN"

class BatchLabelRequest(BaseModel):
    labels: list[LabelIn]

class LabelOut(BaseModel):
    session_id: str
    round_trip_index: int
    expected_category: str
    expected_strategy: str
    actual_category: str
    actual_strategy: str
    entry_tag: str
    exit_tag: str
    round_trip_pnl: float
    round_trip_pnl_pct: float
    created_at: str
    updated_at: str

class StatsByPattern(BaseModel):
    category: str
    strategy: str
    count: int
    win_pct: float
    avg_pnl_pct: float

class StatsByTag(BaseModel):
    tag: str
    count: int
    avg_pnl_pct: float

class MismatchSummary(BaseModel):
    mismatch_pct: float
    profit_pct_matched: float
    profit_pct_mismatched: float
    most_mismatched_expected: Optional[StatsByPattern] = None
    most_mismatched_actual: Optional[StatsByPattern] = None

class StatsResponse(BaseModel):
    total_trades: int
    win_pct: float
    avg_pnl_pct: float
    pnl_95th_percentile: float
    per_pattern: list[StatsByPattern]
    mismatch: MismatchSummary
    by_entry_tag: list[StatsByTag]
    by_exit_tag: list[StatsByTag]

class TagListResponse(BaseModel):
    tags: list[str]
```

**Endpoints:**

| Method | Path | Query/Body | Response |
|--------|------|------------|----------|
| GET | `/api/analysis/round-trips` | `session_id` | `list[RoundTripOut]` |
| GET | `/api/analysis/labels` | `session_id` | `list[LabelOut]` |
| POST | `/api/analysis/labels` | `BatchLabelRequest` | `list[LabelOut]` |
| PUT | `/api/analysis/labels/{session_id}/{round_trip_index}` | `LabelIn` (partial) | `LabelOut` |
| GET | `/api/analysis/entry-tags` | — | `TagListResponse` |
| GET | `/api/analysis/exit-tags` | — | `TagListResponse` |
| GET | `/api/analysis/stats` | `symbol`, `start_date`, `end_date`, `instrument_type`, `session_type` | `StatsResponse` |

**Dependencies:** All endpoints use `user_id: str = Depends(get_request_user_id)`.

**Defaults at save time:**
- `actual_pattern` = `expected_pattern` if both category and strategy are empty
- `entry_tag` = `"AS_PER_PATTERN"` if empty
- `exit_tag` = `"AS_PER_PATTERN"` if empty

---

### 3.3 MODIFY: `backend/app/main.py`

```python
from app.routers import labels
app.include_router(labels.router)
```

---

### 3.4 MODIFY: `scripts/setup-dynamodb-tables.py`

Add `TradeLabels` table definition with `UserIdDateIndex` GSI.

---

## 4. Frontend Implementation

### 4.1 MODIFY: `frontend/src/services/api.ts`

**New types** (7 interfaces): `RoundTripTrade`, `RoundTrip`, `TradeLabel`, `StatsByPattern`, `StatsByTag`, `MismatchSummary`, `AnalysisStats`

**New API methods** (5 methods): `getRoundTrips()`, `getLabels()`, `saveLabels()`, `getEntryTags()`, `getExitTags()`, `getAnalysisStats()`

### 4.2 NEW: `frontend/src/components/TradeLabeling.tsx`

Split-view component — OHLC chart on left (reusing `AnalysisChart`), round-trip label forms on right. Uses `<select>` for pattern dropdowns (pulling from Pattern Library API), `<input>` + `<datalist>` for creatable entry/exit tags. "Save Labels" button batch-upserts all labels.

### 4.3 MODIFY: `frontend/src/components/TradeAnalysis.tsx`

- Add tab bar (`[Trades] | [Label Trades]`) inside expanded `GroupCard`
- Add "📊 Stats" button in the Analysis filter bar
- Import `TradeLabeling` and `StatsModal` components

### 4.4 NEW: `frontend/src/components/StatsModal.tsx`

Full-screen overlay with filterable metrics — core stat cards, per-pattern table, mismatch analysis cards, entry/exit tag tables. Auto-fetches on mount and on filter change.

---

## 5. Files Summary

### New Files (4)

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `backend/app/services/trade_label_service.py` | ~250 | TradeLabels CRUD, FIFO round-trips, stats, tags |
| `backend/app/routers/labels.py` | ~150 | REST API for labels, round-trips, tags, stats |
| `frontend/src/components/TradeLabeling.tsx` | ~400 | Label Trades tab — chart + round-trip forms |
| `frontend/src/components/StatsModal.tsx` | ~350 | Stats dashboard — filterable metrics |

### Modified Files (4)

| File | Changes |
|------|---------|
| `backend/app/main.py` | +2 lines: import and register `labels.router` |
| `scripts/setup-dynamodb-tables.py` | +30 lines: TradeLabels table definition |
| `frontend/src/services/api.ts` | +140 lines: 7 types + 5 API methods |
| `frontend/src/components/TradeAnalysis.tsx` | +30 lines: tabs, Stats button, imports |

---

## 6. Data Flow

```
Label Trades flow:
  User expands GroupCard → clicks "Label Trades" tab
    → GET /api/analysis/round-trips?session_id=X     (compute FIFO round-trips)
    → GET /api/analysis/labels?session_id=X           (existing labels)
    → GET /api/pattern/strategies                     (pattern dropdown options)
    → GET /api/pattern/categories
    → GET /api/analysis/entry-tags                    (tag autocomplete)
    → GET /api/analysis/exit-tags
  User fills in labels, clicks Save
    → POST /api/analysis/labels  {labels: [...]}      (batch upsert)
    → TradeLabels table updated + PnL denormalized
    → Tags re-fetched for updated autocomplete

Stats flow:
  User clicks "📊 Stats" in Analysis
    → GET /api/analysis/stats?symbol=&start_date=&...
    → Queries TradeLabels GSI by user_id + date range
    → Computes all aggregates server-side
    → Returns AnalysisStats JSON
```

---

## 7. Edge Cases & Defaults

| Scenario | Behavior |
|----------|----------|
| Session has no trades | Round-trips returns `[]`, no labels to fill |
| Session has open position only | Returns `[]` (unclosed round-trips ignored) |
| User doesn't fill Actual Pattern | Defaults to Expected Pattern |
| User doesn't fill Entry/Exit Tag | Defaults to `"AS_PER_PATTERN"` |
| Multi-session group | Round-trips computed per-session, shown with headers |
| No labeled trades for stats | All metrics = 0, empty tables |
| New tag typed that doesn't exist | Accepted on save, appears in listings on next fetch |
