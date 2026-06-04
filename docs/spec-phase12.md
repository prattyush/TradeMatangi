#### Trade Practice Tools

##### Trade Stepwise Replayer.
This feature requires to have a replayer similar to what trading view has. That is once a symbol is selected and options OTM etc are selected and time and other details. When user presses start only 1 bar is moved, only one new bar is added. Then user has to keep pressing on next button to get new bars. The trading panel and all other panels remains the same. AIHelper will be applicable in this mode. But, all other trade types should work. Strategies should work etc. Guardrails may or may not work. The idea is imagine we are pausing simulation and starting it after each bar. The UI can play it like a fast speed of streaming like in simulation, as fast as is allowed provided that all trades types should function, i.e target/limit and stoploss orders. The overall idea is waiting for 3 mins for a bar takes lot of time, for mental practice. This would be a quick mental practice for users to try their strategies on data with exact all order types as in papertrading or real trading.

You can ask questions if required.


##### Trade Pattern Logger
This feature would a separate window, in which user can select older date, option or equity, OTM value, symbol and then select display. Upon display the entire chart would be displayed till days end for equity and options. For Options the OTM strike price chart would be displayed. The user can delete any options chart and re-display it with different OTM similar to what is present in simulation, real or paper trading. What this window will help is user to define entry and exit points in the chart and provide a name for this strategy. This strategy is saved, a drop-down can be provided for strategies which are already defined. Keep saving strategy names as we go. And then the user can click on save. These stragies with entry and exit points, can also be viewed with some other window or in the same window with the charts. 
The idea is user can save on charts possible entry and exit points for a strategy that he defines, and during trading user would want to see all possible charts for the strategies he labelled. As every day is different, every chart is different, even same strategy needs of have variations to be successful in real environments. one strategy could be marked on more than 15 charts. So plan on how to display them. For options, better to view both underlying and ce/pe charts. Not sure how should the display handle it. But, user can say this is entry for CE in underlying and exit for CE. Be creative.

You can ask questions if required.

---

## Implementation Status

### Sprint 1 — Trade Stepwise Replayer ✅ COMPLETE

**Backend changes:**
- `SimulationSession`: added `stepwise`, `step_event`, `current_bar_index`, `total_bars` fields
- `_count_total_bars()`: counts distinct bar slots in the day's equity data
- `create_session()`: accepts `stepwise=True`, computes total_bars, stores step_event
- `_run_session()`: bar-boundary detection across all 3 loops (dual-stream, single-right options, equity); `step_event.wait()` parks loop after each bar; ticks stream at max speed (no sleep) in stepwise mode
- `stop_session()`: sets `step_event` on stop so parked loop unblocks cleanly
- New endpoint: `POST /api/simulation/{session_id}/next-bar`
- `session_type="stepwise"` stored as "sim" internally; `stepwise=True` flag distinguishes it
- `SimulationStartRequest`: added `stepwise: bool = False`
- `SimulationStartResponse`: added `stepwise: bool`, `total_bars: Optional[int]`

**Frontend changes:**
- `api.ts`: `SimulationStartRequest` allows `session_type='stepwise'`; `SimulationStartResponse` has `stepwise`, `total_bars`; added `nextBar(sessionId)` function
- `useSimulation.ts`: added `stepwise`, `barPaused`, `barIndex`, `totalBars` to state; added `handleBarPaused()` and `nextBar()` callbacks
- `SessionControls.tsx`: added Stepwise toggle button; "Start Stepwise" label; "▶ Next Bar (N of M)" button replaces Pause when in stepwise mode and bar is paused
- `App.tsx`: handles `bar_paused` SSE event; passes stepwise props to SessionControls

**Tests:** 16 new tests in `tests/test_stepwise_replayer.py` — all pass.

---

### Sprint 2 — Pattern Library: Backend ✅ COMPLETE

**New files:**
- `backend/app/services/pattern_logger_service.py`: DynamoDB CRUD for `PatternAnnotations` table
- `backend/app/routers/pattern_logger.py`: REST endpoints (prefix `/api/pattern`)
- `backend/tests/test_pattern_logger.py`: 21 tests — all pass

**DynamoDB table: `PatternAnnotations`**
- One record per (user, symbol, date, instrument_type[, right])
- Annotations carry per-annotation `strategy_name` — multiple strategies co-exist on one chart
- PK: `chart_id` (UUID)

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/pattern/strategies` | List unique strategy names for user |
| GET | `/api/pattern/charts[?strategy=X]` | List chart metadata (optionally filtered) |
| GET | `/api/pattern/chart/by-date` | Find existing chart by date/symbol/instrument |
| GET | `/api/pattern/chart/{id}` | Full chart with all annotations |
| POST | `/api/pattern/chart` | Create chart |
| PUT | `/api/pattern/chart/{id}` | Update annotations/notes |
| DELETE | `/api/pattern/chart/{id}` | Delete chart |
| GET | `/api/pattern/ohlc/equity` | Full-day equity OHLC candles |
| GET | `/api/pattern/ohlc/options` | Full-day options OHLC candles |

**Reuses:** `data_loader.resample_to_candles()`, `data_loader.candles_to_records()`, `options_service.load_options_dataframe()`

---

### Sprints 3+4 — Pattern Library: Frontend ✅ COMPLETE

**New file:** `frontend/src/pages/PatternLibrary.tsx`

**Access:** "📚 Patterns" button in main app header → full-screen Pattern Library page with "← Back to Trading" nav.

**Features:**
- Load form: symbol, date, equity/options toggle, OTM offset → Load Chart
- Auto-loads existing annotations when navigating to a previously-annotated date
- Annotation toolbar: active strategy selector (dropdown + new strategy name field) + 6 tool buttons (Entry/Exit × Underlying/CE/PE)
- Click-to-annotate: click a candle to place the selected marker; click same spot again to remove
- Multi-strategy per chart: each annotation carries its own `strategy_name`; active strategy's markers are full opacity, others dimmed
- Options mode: stacked underlying pane (top) + options CE/PE pane (bottom); each pane only shows annotations for its instrument type
- Save/update: saves to backend, refreshes strategy list
- Gallery: scrollable grid of saved charts filtered by strategy dropdown; 6 per page with pagination; cards show date, symbol, instrument badge, entry/exit counts, all strategy names on chart
- Load from gallery: loads full chart + annotations, pre-selects strategy
- Delete from gallery: with one-click confirmation

**api.ts additions:** `patternListStrategies()`, `patternListCharts()`, `patternGetChartByDate()`, `patternGetChart()`, `patternCreateChart()`, `patternUpdateChart()`, `patternDeleteChart()`, `patternOhlcEquity()`, `patternOhlcOptions()` + `PatternAnnotation`, `PatternChartMeta`, `PatternChart`, `PatternOHLCResponse` types

---

## Test Counts

| Phase | Backend Tests | Notes |
|-------|--------------|-------|
| Before Phase XII | 534 | |
| After Sprint 1 | 550 | +16 stepwise tests |
| After Sprint 2 | 571 | +21 pattern logger tests |

## PR Log

| Sprint | Branch | Status |
|--------|--------|--------|
| Sprint 1 — Stepwise Replayer | feature/phase12-stepwise | Ready for PR |
| Sprints 2-4 — Pattern Library | feature/phase12-pattern-library | Ready for PR |

---

### Pattern Library Enhancements — PR #167 (feature/phase12-bugfixes)

All changes are on `feature/phase12-bugfixes`, open PR targeting `dev`.

**Bug fixes:**
- Options mode previously only loaded one side (CE or PE based on OTM offset sign); now always loads **both CE and PE** as a symmetric OTM pair (CE = ATM + offset×interval, PE = ATM − offset×interval)
- Newly-added option pane was invisible when another pane was present — root cause: flex `min-width: auto` on pane wrappers prevented the existing pane from shrinking, leaving 0px for the new pane. Fixed with `minWidth: 0` on option pane wrapper divs
- `addPaneError` was rendered inside a `flexWrap` row and could be clipped by outer `overflow: hidden`, making failures invisible. Moved to a dedicated full-width div below the controls

**New features:**

*Data:*
- Backend `/api/pattern/ohlc/equity` and `/api/pattern/ohlc/options` now accept `days_back` param (default 2, max 5); prepends prior trading days so EMA warmup candles and prior-day context are visible
- `api.ts`: `patternOhlcEquity` and `patternOhlcOptions` accept `daysBack?` param

*Chart panes:*
- **EMA 9/21** overlay on every pane (orange EMA9, blue EMA21) with per-pane toggle button
- **Drawing tools** on every pane: horizontal line, trend line, Fibonacci retracement, parallel channel — same implementation as live trading charts (`Chart.tsx`); per-pane Draw dropdown + Clear button + step instructions
- **Maximize/restore** (⤢/⤡) button on every pane (underlying + all option panes); non-maximized panes hidden via `display: none` keeping chart state intact
- **Remove** (✕) button on each option pane to delete it individually; underlying cannot be removed

*Dynamic panes:*
- Option panes stored as a dynamic `OptionPane[]` array instead of fixed CE/PE states; each pane has a unique numeric ID
- **"Add Pane" strip** below chart area (create mode, options only): CE/PE toggle, strike input, ATM hint, snap-to-interval preview; loads that contract's OHLC and adds a new pane alongside existing ones — supports e.g. UL + CE 23500 + CE 23400 + PE 23500 simultaneously
- **Success feedback**: green "✓ CE 23500 pane added" toast for 2.5 s after successful add

*Create vs View modes:*
- Mode toggle button in header (✏ Create / 👁 View)
- **Create mode**: load controls + annotation toolbar + charts + "Add Pane" strip + compact gallery strip
- **View mode**: 2-column gallery grid (click card to expand read-only chart above gallery; all panes shown with `readonly=true`; annotation toolbar and drawing tools hidden); "✕ Close" returns to full gallery

*Gallery:*
- Reorganised to CSS `grid, gridTemplateColumns: repeat(2, 1fr)` in both modes
