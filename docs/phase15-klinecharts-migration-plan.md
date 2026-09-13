# Phase 15 KLineCharts Migration Plan

## Summary

This plan covers the full migration from `lightweight-charts` to `klinecharts` across Trade Matangi. The migration should be sprint-wise, not a single replacement PR, because chart behavior is central to live trading, simulations, pattern labeling, fine structures, trade analysis, event snapshots, drawings, markers, price selection, right-click orders, and custom indicators.

The recommendation is to prove KLineCharts in the Pattern Library first, then migrate lower-risk analytical chart surfaces, and migrate the live trading chart last.

## Why Consider KLineCharts

KLineCharts appears useful because it provides a more complete trading-chart feature set out of the box:

- Built-in technical indicators such as MA, EMA, BOLL, MACD, RSI, KDJ, and ROC.
- Built-in overlay/drawing concepts that may reduce the amount of custom chart code.
- Multi-pane indicator layout is closer to TradingView-style workflows.
- Indicator creation and pane management may become easier for future custom indicators.

Staying on Lightweight Charts has benefits too:

- Current code is already integrated and battle-tested in this app.
- It is smaller and focused, with fewer surprises in live trading flows.
- Existing custom marker, price line, price-pick, right-click, drawing, and live-update behavior already works.
- Migration risk is avoided, but future indicators remain mostly custom-built.

The key tradeoff is this: KLineCharts may reduce future indicator UI work, but replacing the existing chart surface has meaningful regression risk.

## Current Chart Surface Area

The current frontend uses `lightweight-charts` in these surfaces:

- Main trading chart: `frontend/src/components/Chart.tsx`
- Pattern Library: `frontend/src/pages/PatternLibrary.tsx`
- Fine Structures: `frontend/src/pages/FineStructures.tsx`
- Broad Chart Structures: `frontend/src/pages/ChartStructures.tsx`
- Trade Analysis: `frontend/src/components/TradeAnalysis.tsx`
- Pattern vs Trading comparison: `frontend/src/components/PatternVsTradeComparison.tsx`
- Event Snapshot Viewer: `frontend/src/components/EventSnapshotViewer.tsx`
- Shared pattern marker helper: `frontend/src/services/patternMarkers.ts`

The migration must preserve the project timestamp invariant: data is tz-naive IST encoded as UTC timestamps so charts display Indian market times directly. Do not change backend timestamp semantics during this migration.

## Sprint 0: Library Validation And POC

### Goal

Confirm that `klinecharts` can support the app's required chart behaviors before any shared migration begins.

### Scope

- Install `klinecharts` in a temporary branch or feature branch.
- Build a local proof-of-concept component with static OHLC data.
- Verify English UI/docs/API names are sufficient for project use.
- Confirm the package works with React 18, Vite, and the current TypeScript setup.

### Required Checks

- Render candlesticks with Trade Matangi dark theme.
- Render built-in EMA 9/21.
- Render at least one separate indicator pane.
- Add custom line data for the options relative-ratio indicator.
- Add and remove a horizontal line or equivalent overlay.
- Convert mouse click coordinates to time and price.
- Resize safely with `ResizeObserver`.

### Risks

- KLineCharts API may not map cleanly to exact-price trade markers.
- Built-in overlays may not match current custom drawing behavior.
- Indicator panes may not support the exact custom ratio chart needed.

### Acceptance Criteria

- A POC proves candlesticks, EMA, one custom indicator, click price/time, and resize.
- No production chart surface is switched yet.

## Sprint 1: Chart Adapter Foundation

### Goal

Introduce a chart abstraction so KLineCharts can be adopted surface-by-surface without rewriting all charts at once.

### Scope

- Add a chart data adapter layer for candle conversion.
- Define common frontend chart types:
  - `ChartCandle`: `{ time, open, high, low, close }`
  - `ChartMarker`
  - `ChartPriceLine`
  - `ChartIndicatorSeries`
- Add KLine conversion helpers:
  - timestamp seconds to KLine timestamp format
  - KLine timestamp back to project timestamp seconds
  - OHLC field mapping
- Keep Lightweight Charts code untouched except where the POC adapter is consumed.

### Required Checks

- Time labels still show market wall-clock times correctly.
- 1m, 2m, 3m, 5m, 15m, and 30m candles convert cleanly.
- No backend API change is required.

### Risks

- Timestamp conversion can silently shift market hours.
- Adapter may over-abstract too early; keep it narrow and driven by actual needs.

### Acceptance Criteria

- Adapter can feed KLineCharts and preserve existing OHLC data semantics.
- TypeScript passes.

## Sprint 2: Pattern Library KLine Renderer

### Goal

Migrate Pattern Library charts first because this is a lower-risk analysis workflow and already contains the new options indicator work.

### Scope

- Add a Pattern Library renderer toggle:
  - `Lightweight` default initially.
  - `KLine` experimental option.
- Migrate underlying, CE, and PE panes to KLine behind the toggle.
- Preserve existing Pattern Library behaviors:
  - load equity chart
  - load options underlying + CE + PE charts
  - add/remove option panes
  - switch interval
  - maximize panes
  - view mode and create mode

### Required Checks

- Existing pattern annotations still render at the correct bars.
- Entry/exit marker colors and labels remain readable.
- Saved charts load with the saved interval.
- Shared/read-only charts remain read-only.

### Risks

- Pattern marker rendering may need a custom overlay implementation.
- KLine pane sizing may differ from the current flex layout.

### Acceptance Criteria

- Pattern Library can run both chart renderers.
- KLine renderer matches the main Pattern Library workflows.
- Existing Lightweight renderer remains available as rollback.

## Sprint 3: EMA And Options Indicator Migration

### Goal

Move EMA and the options relative-ratio indicator onto the KLine renderer in Pattern Library.

### Scope

- Use KLine built-in EMA for standard EMA 9/21 where possible.
- Preserve existing EMA colors:
  - EMA 9: orange `#f0883e`
  - EMA 21: blue `#79c0ff`
- Keep custom options ratio math in `frontend/src/indicators`.
- Render these options indicators in KLine indicator panes:
  - `CE / UL`
  - `PE / UL`
  - `CE / PE`
  - `(CE/UL)/(PE/UL)`
- Preserve raw/normalized toggle for testing.
- Preserve compact/medium/large sizing and maximize behavior.

### Required Checks

- EMA values visually match the current Lightweight implementation.
- Options indicators remain one-line indicators.
- Raw mode uses unnormalized percent-change ratio.
- Normalized mode scales each leg before taking the ratio.
- No 1.0 guide line is shown unless explicitly reintroduced later.

### Risks

- KLine built-in EMA warmup behavior may differ from current custom EMA.
- Custom indicator pane APIs may require data shape changes.

### Acceptance Criteria

- Pattern Library KLine mode supports EMA and all four options indicators.
- Lightweight mode still works during the transition.

## Sprint 4: Fine Structures And Broad Structures Migration

### Goal

Migrate the structure-labeling chart surfaces after Pattern Library proves stable.

### Scope

- Migrate Fine Structures builder charts.
- Migrate Fine Structures search/result charts.
- Migrate Broad Chart Structures chart modal.
- Preserve flow-step transition markers.
- Preserve drawing tools:
  - horizontal line
  - trend line
  - fib retracement
  - parallel channel
  - risk:reward

### Required Checks

- Builder chart clicks still assign transition bars to the selected flow step.
- CE/PE option builder behavior remains separated by selected right.
- Search result markers align with saved transition times.
- Shared fine structures remain view-only for shared users.

### Risks

- Current Fine Structures has multiple embedded chart variants, so duplication may make migration noisy.
- Transition bar click behavior is more important than visual parity.

### Acceptance Criteria

- Fine and Broad Structure workflows work with KLine.
- Existing saved flows and definitions need no migration.

## Sprint 5: Analysis And Snapshot Charts

### Goal

Migrate read-heavy analysis chart surfaces after annotation workflows are stable.

### Scope

- Migrate Trade Analysis charts.
- Migrate Pattern vs Trading comparison charts.
- Migrate Event Snapshot Viewer charts.
- Preserve trade markers:
  - exact option trade price on option charts
  - underlying-price marker mapping for options trades on underlying charts
  - directional marker colors
- Preserve event snapshot open-order and position overlays.

### Required Checks

- Trade markers align with exact prices where expected.
- Analysis charts still merge historical + full session pre-session candles.
- Snapshot viewer still renders current bar, open orders, positions, and filled trades.
- Pattern comparison still supports CE/PE tabs and pattern filters.

### Risks

- Marker behavior is one of the highest-risk areas because current exact-price markers use hidden line series.
- Snapshot overlays combine several custom visual concepts.

### Acceptance Criteria

- All analysis surfaces render correctly with KLine.
- No change to analysis backend endpoints.

## Sprint 6: Main Trading Chart Migration

### Goal

Migrate the live trading/simulation chart only after all lower-risk chart surfaces are proven.

### Scope

- Migrate `frontend/src/components/Chart.tsx` to KLine or replace it with the adapter-backed KLine chart.
- Preserve all live chart behavior:
  - simulation
  - stepwise
  - paper trading
  - real trading
  - equity and options panes
  - live tick update
  - completed bar update
  - interval switching
  - right-click context menu
  - price-pick mode
  - open-order price lines
  - stoploss P&L labels
  - trade markers
  - pane maximize/swap/remove

### Required Checks

- Live ticks update the current candle without duplicate or out-of-order candle errors.
- Stepwise completed bars render exactly once.
- Options historical refresh still respects current simulation time cutoff.
- Right-click price maps to the correct chart price.
- Price-pick writes the selected chart price into the intended order/strategy input.
- Open-order lines update and clear as orders fill/cancel.
- Trade markers filter by right and strike correctly.

### Risks

- This is the most dangerous migration because it affects order placement and active-session decision-making.
- Any timestamp or update-order bug can make charts misleading during trading.

### Acceptance Criteria

- Main trading chart behaves correctly in sim, stepwise, paper, and real modes.
- Existing manual trading workflows pass a full smoke test before Lightweight fallback is removed.

## Sprint 7: Remove Lightweight Charts

### Goal

Remove Lightweight Charts only after KLine has replaced every chart surface and the fallback is no longer needed.

### Scope

- Remove `lightweight-charts` from `frontend/package.json`.
- Delete or simplify duplicated EMA helpers.
- Delete unused Lightweight marker/drawing code.
- Consolidate chart utilities around KLine adapter/helpers.
- Update frontend technical constraints docs.

### Required Checks

- `rg "lightweight-charts" frontend/src` returns no active imports.
- TypeScript passes.
- Production build passes.
- Manual smoke tests pass across Pattern Library, Structures, Analysis, Snapshot Viewer, and Trading charts.

### Risks

- Removing fallback too early would make regressions harder to recover from.
- Some docs may still mention old Lightweight-specific constraints; update them after code removal.

### Acceptance Criteria

- KLineCharts is the only frontend chart library.
- Existing feature behavior is preserved or intentionally documented as changed.

## Rollback Strategy

- Keep renderer toggles during migration sprints.
- Pattern Library migrates first with a visible fallback.
- Do not remove Lightweight imports until Sprint 7.
- If a KLine migration breaks a surface, disable KLine for that surface and keep the old renderer active.
- Live trading migration must be reversible until it has passed sim, stepwise, paper, and real smoke checks.

## Final Verification Matrix

Before declaring the full migration complete:

- Pattern Library:
  - create/view mode
  - equity/options
  - annotations
  - option pane add/remove
  - indicators
- Fine Structures:
  - definitions unaffected
  - builder transition markers
  - search result chart
  - options support
- Broad Structures:
  - chart modal
  - EMA
- Analysis:
  - trade markers
  - options marker mapping
  - pattern comparison
- Snapshot Viewer:
  - current bar
  - open orders
  - positions
  - filled trades
- Main Trading:
  - sim
  - stepwise
  - paper
  - real
  - right-click actions
  - price pick
  - interval switching
  - markers and price lines

## Recommendation

Proceed only with Sprint 0 and Sprint 1 first. A full migration is beneficial only if KLineCharts clearly reduces indicator and drawing complexity without weakening exact marker placement, live updates, or trading interactions.
