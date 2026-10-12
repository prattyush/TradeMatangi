# Phase 21 — Swing Trading Improvements

Approved 2026-10-12. This is a separate improvements sprint track. All branches
start from preprod and all PRs target preprod. Main/dev promotion and deployment
remain manual. Preserve the original requirements in spec-phase21.md.

## Decisions and design

Portfolio setup/recovery comes first. Website and desktop share a portfolio-first
workspace: summary/header, left Positions/Orders/Trades rail, centre chart deck,
and a collapsible confirmed trade ticket. Desktop uses KLineCharts; website uses
its existing chart renderer. Start with one pane; allow 1/2/3/4, active selection
and maximize/restore. Each pane owns an exact instrument, selected date and
interval (1m/3m/5m/15m/30m/1h/1D). Positions/orders select the active pane's exact
instrument, retaining its date/interval. New equity/index panes use 1D; options
use 15m. Restore a saved workspace or start with the first position/HDFCBANK.

Research charts do not create execution contexts or reserve money. Historical
charts never backdate orders or become evidence of fills. Price picking fills a
ticket and always requires explicit submission. Support Buy Limit/Target and held
Sell Limit/SL, long-only quantities and exact option lots. Retain existing retry,
funding, ownership, import, recovery and verified-close semantics. Order dragging,
new strategy editors and attached entry SL automation are left out.

Daily charts load about 250 candles, intraday about 300, with paged older history.
Use native daily APIs and separately tagged provider/resolution caches; do not
turn minute candles into Replay seconds. Respect provider limits, fallback,
calendar/IST conventions, exact fractional strikes and option availability.
Drawings and indicators use existing renderers/persistence. Workspace preferences
are separate from the money book and independent per website/desktop surface.

Active Paper/Real portfolio positions and pending intentions are priced by the
backend using admin-selected live data, even without any UI. Swing's normal
session is 09:15 <= time < 15:30 IST, excluding configured holidays/weekends.
Do not reuse the legacy Day/Replay 15:15 cutoff for Swing. Restore subscriptions
after restart; wait until open, release at close, retry transient provider failures
and stop only on verified closure. Pause entries/detach does not stop protection.
Today-following chart panes subscribe automatically; historical panes do not.
Viewer handles are separate from portfolio handles and never stop held pricing.

Positions show invested value, known-fee-net unrealized P&L and % of position
cost, quote time and freshness. Portfolio % stays relative to session capital.
Unknown history/prices stay pending rather than becoming zero or fabricated P&L.
Real settlement/expiry stays manual; finalized Swing charges remain estimated.

## Sprints and acceptance

| Sprint | Deliverable | Completion criterion | Status |
| --- | --- | --- | --- |
| 0 | Design, decisions, interfaces, scope/exclusions and acceptance record | Linked handoff preserves user requirements | Complete |
| 1 | Swing market window, backend price lifecycle, restart recovery and position P&L | Open/close/holiday/restart/detach checks pass | Complete (code and focused checks) |
| 2 | Provider daily/minute history, caches, pagination and renderer daily support | Exact history loads without fake bars or Replay cache changes | Complete (code and focused checks) |
| 3 | Portfolio rail, independent 1–4 charts, drawings/indicators, persistence and live panes | Both clients compare instruments/dates and restore workspace | Complete (code and focused checks) |
| 4 | Ticket/picker, order/position overlays and management drawer | Exact, explicit, idempotent submission retains existing protections | Complete (code and focused checks) |
| 5 | Review, regression/browser/native checks and preprod acceptance | Automated evidence recorded; live/native acceptance separate | Automated review/checks complete; preprod acceptance pending |

## Interfaces and verification

Add owned chart history and viewer-feed APIs under Swing portfolios and facade
them through existing desktop authentication. History carries range, provider,
partial/stale status and older cursor; chart feeds expose current quotes/status.
Extend snapshots with per-position marks/P&L. Save UI preferences through existing
user/UI persistence without resizing portfolio capital or claiming a new book.

Test boundaries at 09:15, 15:15 and 15:30; holidays; restart/offline/no UI; paused
and closing books; no phantom fills; exact options and duplicate subscriptions;
independent pane dates; pagination and daily bars; stale/delayed responses; picker
instrument changes; quantities/partial fills/unknown ACK; existing Day/Replay
regressions; browser layouts/tooltips/scrollbars and native builds.

External linked Swing windows, five panes, multi-day Replay, corporate actions,
new strategies and finalized Swing charge corrections remain deferred. Mocked
checks place no live orders. Authenticated broker/Windows acceptance follows
preprod merge/deployment and cannot be inferred from builds alone.

## Implementation checkpoint — 2026-10-12

Work is on `feature/swing-chart-workspace`, based on preprod `ef72d46`.
Sprints 0–4 are implemented. Sprint 5 code review and automated checks are
complete; authenticated broker and installed Windows acceptance still require
preprod merge/deployment. Do not promote to main/dev on build results alone.

### Delivered behavior

- Shared portfolio-first workspace in website and desktop: Positions/Orders/Trades,
  independent 1–4 panes, date/timeframe selection, exact instrument selection,
  maximize/restore, historical-order warning, confirmed ticket and management drawer.
  Selecting a held position changes only the active pane's instrument.
- Native daily bars, approximately 250 initially; minute-based intraday charts,
  approximately 300 initially; older paging with request-version fences. Website
  preserves the visible candle anchor when older bars prepend. Empty/invalid history
  is explicit; chart history never creates execution contexts or fills.
- Admin-selected live data prices held positions and pending intentions in active
  Paper/Real books without a screen. Market boundaries use IST wall-clock timestamps:
  09:15 inclusive, 15:30 exclusive, configured holidays/weekends excluded. Paper
  expiry entries stop and exits start at 15:15; Real settlement remains manual.
  Existing Real startup recovery and Paper restoration both reach the same consumer.
- Pause entries and detach retain held-position protection. Viewer subscriptions are
  independent; closing a viewer releases only its handles. Ownership is refreshed
  at most once per 15 seconds, rather than issuing storage reads for every quote.
  Consumers retry transient failures; Paper startup retries failed rows after one
  successful scan instead of repeatedly scanning all history.
- Current-date panes follow live quotes; past dates remain historical. Viewer ranges
  retain highs/lows across the two-second UI polling interval. Old buffered ticks and
  out-of-order quotes cannot become current fills. Stale/unavailable marks are shown
  explicitly. Position P&L includes known remaining entry fees and uses position
  cost as its percentage denominator; portfolio percentage uses session capital.
- Native desktop uses existing KLine indicators and authenticated instrument-scoped
  drawing CRUD, shared with existing desktop chart views. Website uses existing
  drawings/EMA/position-level controls with local storage scoped to portfolio,
  exact instrument and interval. Indicator choices are restored locally. Workspace
  preferences are saved separately per user, surface, Paper/Real mode and broker.

### Interfaces and storage

All routes are under owned `/swing/portfolios/{portfolio_id}/charts` and use the
existing website/desktop authentication facades; no new native bridge is needed.

| Route | Purpose |
| --- | --- |
| `POST /history` | Exact instrument, interval, as-of date, optional older cursor and limit; returns candles/provider/pagination/partial status |
| `POST /watch` | Deduplicate up to four current-date instruments into one owned viewer |
| `GET /watch/{id}` | Quotes, retained interval ranges, actual provider, market state and reconnect notice |
| `DELETE /watch/{id}` | Release viewer handles without stopping portfolio pricing |
| `GET /workspace?surface=...` | Restore the user's surface/mode/broker preference record |
| `PUT /workspace` | Validate 1–4 exact panes and an existing active pane before saving |

Viewers expire after 45 seconds without a heartbeat. The browser polls every two
seconds; backend portfolio consumers check idle/open transitions within 15 seconds.
Caches live under `OHLCDATA_DIR/swing/{provider}/{instrument-hash}/{day|1m}`.
Daily requests use bounded native-day chunks; minute requests use completed-day
chunks and provider pacing. Requests for today refresh after 60 seconds; past
completed chunks persist. Exact end bounds separate partial older pages from
full-day cache entries. Atomic writes use process/thread-specific temporary files.
These files never enter the Replay-second cache. Workspace records reuse
`DesktopChartSettings`; no database/table migration or new dependency is required.

### Review findings fixed

The review corrected native chart height, an expanding toolbar, duplicate inactive
window controls, unrounded picked prices rejected by HTML's price step, missing
option lot labels, history/quote races, paging beyond end of history, viewport
movement on prepend, future-date requests, invalid active-pane preferences,
viewer expiry cleanup, stale mark labels, intra-poll extremes, excessive ownership
reads and the last Paper expiry-entry use of the legacy Day cutoff. Existing money,
ownership, funding, unknown-acknowledgement and verified-close rules are retained.

### Automated verification

- Full backend suite: **2,206 passed; two existing failures** in
  `TestOptionsSimulationStart.test_missing_strike_returns_400` and
  `test_invalid_right_returns_400`. Both reach an unavailable ICICI history request
  because this checkout lacks `[icicidirect]` credentials; they are not Swing tests.
  Additional focused P&L and expiry-cutoff regressions were run after this full pass.
- Focused Swing chart/Paper runtime/Paper recovery/Real runtime checks: **57 passed**;
  includes boundaries, holidays, no-UI subscription,
  startup retry, exact history isolation, viewer cleanup, quote extremes, workspace
  ownership, known-fee P&L and expiry entry/exit cutoff.
- Website and desktop TypeScript checks and production builds passed. Desktop:
  **199 tests passed**. Native Rust: **19 tests passed**. New Python modules/tests
  pass Ruff; patch passes `git diff --check`.
- `scripts/swing-workspace-browser-check.mjs` checks both actual renderers against
  synthetic books: four panes, independent dates, active-pane position selection,
  price picking without automatic submission, exact confirmed symbol, pause and
  maximize/restore. `scripts/phase21-swing-check.mjs` checks the built desktop's
  capital/refund/option-lot/management/detach/verified-close flow. No live orders
  were placed. Both report no browser exceptions.

The full-suite credential failures remain explicit and are not silently waived as
passing tests. Browser screenshots/results are local validation artifacts, not
broker execution evidence.

### Preprod acceptance and remaining exclusions

After merge, deploy the backend and install the built Windows client. Check an
active Paper book first, then an authorized Real book with small quantities:

1. Start/restart backend during market hours with the UI closed. Confirm held
   instruments subscribe through the admin-selected live provider and update marks.
   Pause and detach; verify protection continues. Restart outside hours, then verify
   subscriptions resume at open and release at 15:30 without affecting other views.
2. Check each configured historical/live provider, auth expiry, reconnect/fallback,
   an exact fractional option, an expired contract and an instrument with short
   history. Broker data availability varies; absent bars must remain absent. Cold
   intraday pages can take longer because requests obey the existing provider pacer.
3. Compare website and installed desktop at 1/2/3/4 panes and common display scales.
   Verify date/interval independence, daily history, older paging, drawings and
   indicators across reopening, current/historical labels and confirmed price picks.
4. Reconcile a Real position and partial exit, shared funding, pending/unknown broker
   submissions and verified close. Confirm research panes never create a new money
   context or reserve capital. Test during the 15:15–15:30 interval as well.

External linked Swing windows, five panes, multi-day Replay, corporate actions,
new strategies, order dragging/amendment and attached-entry SL automation remain
excluded. Broker token availability can limit expired-option history. Finalized
Swing charges and exchange settlement/authorization are still outside this track.
The configured trading calendar must cover the dates being tested. No installer
signing or main/dev merge is included in this delivery.

Provider references: [Kite native historical intervals](https://www.kite.trade/docs/connect/v3/historical/)
and [Breeze chart data examples](https://www.icicidirect.com/futures-and-options/api/breeze/article/how-to-create-charts-using-breeze-api-data).
