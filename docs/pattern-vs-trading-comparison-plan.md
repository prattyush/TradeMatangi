# Pattern V/S Trading Comparison — Implementation Plan

## Requirements Summary

- Per-group "Compare" button on analysis group cards (like Snapshots)
- Side-by-side modal: trades chart (left) + patterns chart (right)
- Trades side: markers show expected pattern label text (or B/S if unlabeled)
- Patterns side: ALL pattern charts for that day/symbol, filtered by category/strategy dropdowns
- For options: both sides have underlying + CE/PE tabs (all strikes)
- For equity: both sides show only underlying, no tabs
- Button hidden if no pattern chart exists for that date
- Use expected_category/expected_strategy from TradeLabels for trade marker text

## Files to Create

### 1. `frontend/src/services/patternMarkers.ts` — Extract shared marker utilities

Move from `PatternLibrary.tsx` to new shared module:
- `buildMarkers()` function
- `MARKER_COLORS` object
- `markerKey()` helper
- `patternIdentity()` helper
- `rankingForIdentity()` helper
- `TOP_RANK_STYLE` object
- `cleanTopPatterns()` helper

Update `PatternLibrary.tsx` to import from `patternMarkers.ts`.

### 2. `frontend/src/components/PatternVsTradeComparison.tsx` — New modal component

**Props:**
```ts
interface Props {
  symbol: string
  date: string
  instrumentType: 'equity' | 'options'
  sessionIds: string[]
  allTrades: AnalysisTrade[]
  historicalDays: number
  onClose: () => void
}
```

**Data loading (parallel on mount):**
- `api.getRoundTrips()` + `api.getLabels()` per sessionId → build `labelByTradeId: Map<string, TradeLabel>`
- `api.patternGetChartByDate(symbol, date, instrumentType)` → pattern annotations for underlying
- `api.patternOhlcEquity(symbol, date, 3, historicalDays)` → equity candles
- `api.patternListCategories()` + `api.patternListStrategies()` → dropdown options
- For options: `api.getExpiry()` + `api.getPriceAt()` or derive strikes from `allTrades`

**Layout:**
```
┌──────────────────────────────────────────────────────────┐
│  📊 Pattern vs Trade: NIFTY · 2025-07-15          [✕]  │
│  Category: [▼ All]    Strategy: [▼ All]                  │
├──────────────────────┬───────────────────────────────────┤
│  TRADES              │  PATTERNS                         │
│  [Underlying][CE][PE]│  [Underlying][CE][PE]             │
│  ┌─────────────────┐ │  ┌───────────────────────────────┐│
│  │ AnalysisChart   │ │  │ ReadOnlyPatternChart          ││
│  │ (with labels)   │ │  │ (with buildMarkers)           ││
│  └─────────────────┘ │  └───────────────────────────────┘│
└──────────────────────┴───────────────────────────────────┘
```

**Left pane (Trades):**
- Reuses `AnalysisChart` from `TradeAnalysis.tsx`
- Passes `getMarkerText` callback: looks up each trade in `labelByTradeId`, returns `{category}/{strategy}` for labeled trades, `B`/`S` for unlabeled
- For options: CE/PE tabs derived from unique `(right, strike, expiry)` in `allTrades`; switching tabs reuses `OptionsChart` with filtered trades

**Right pane (Patterns):**
- New `PatternChartView` — simple read-only Lightweight Charts component
- Loads OHLC candles (equity for underlying, options OHLC for CE/PE)
- Uses `buildMarkers()` from `patternMarkers.ts` with `activeCategory`/`activeStrategy` filters
- Same chart style as `AnalysisChart` (background, colors, EMA 9/21, crosshair disabled)
- When switching CE/PE tabs: loads options OHLC via `api.patternOhlcOptions()`, filters annotations to matching instrument

**CE/PE tab sync:** Both sides have independent tab selectors. Default to "Underlying".

## Files to Modify

### 3. `frontend/src/components/TradeAnalysis.tsx`

**AnalysisChart** — add optional prop:
```ts
getMarkerText?: (trade: AnalysisTrade) => string
```
In marker text assignment, use `getMarkerText?.(t) ?? defaultText`.

**GroupCard** — add compare button + state:
- State: `const [showComparison, setShowComparison] = useState(false)`
- State: `const [hasPattern, setHasPattern] = useState(false)` — check on expand
- When expanded, call `api.patternGetChartByDate(symbol, date, instrumentType).then(r => setHasPattern(!!r))`
- If `hasPattern`, render "📊 Compare" button next to "📸 Snapshots"
- If `showComparison`, render `<PatternVsTradeComparison>` modal

### 4. `frontend/src/pages/PatternLibrary.tsx`

- Remove `buildMarkers`, `MARKER_COLORS`, `markerKey`, `patternIdentity`, `rankingForIdentity`, `TOP_RANK_STYLE`, `cleanTopPatterns` — now imported from `patternMarkers.ts`
- No behavioral changes

### 5. `docs/spec-phase13.md`

- Update feature status and PR log

## Data Flow

```
GroupCard.onExpand
  → api.patternGetChartByDate(symbol, date, instrumentType)
  → setHasPattern(true/false)
  → renders "Compare" button (or not)

User clicks "Compare"
  → setShowComparison(true)
  → PatternVsTradeComparison mounts
    → Parallel fetch: round-trips + labels + pattern chart + OHLC + dropdowns
    → Build labelByTradeId map
    → Render left pane: AnalysisChart with getMarkerText callback
    → Render right pane: PatternChartView with buildMarkers
    → Category/strategy dropdowns control dimming on right pane
```

## Edge Cases

| Case | Handling |
|------|----------|
| No pattern chart for date | Button hidden (`hasPattern === false`) |
| No labels at all | All trade markers show B/S |
| Some trades labeled, some not | Labeled show pattern text, unlabeled show B/S |
| Multi-session group | Aggregate all round-trips + labels across all sessionIds |
| Equity instrumentType | No CE/PE tabs on either side |
| Options with multiple strikes | CE/PE tabs derived from `allTrades` unique (right, strike, expiry) triples |
| Modal close | Standard cleanup: cancel fetches, remove charts |
| Empty pattern annotations | Right pane shows chart without markers |
| Loading state | "Loading pattern data…" placeholder on right pane |

## Verification

1. **Equity group with patterns**: Compare shows side-by-side charts, trade markers show label text, pattern markers show on right
2. **Equity group without patterns**: Compare button hidden
3. **Options group with CE/PE trades**: Both sides have underlying + CE/PE tabs, switching works independently
4. **Unlabeled trades**: Markers show B/S correctly
5. **Category/strategy filter**: Right pane dims non-matching markers
6. **TypeScript check**: Passes
