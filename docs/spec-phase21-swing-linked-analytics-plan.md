# Phase 21 — Linked Swing windows and analytics

Approved 2026-10-12. Work on `feature/swing-linked-analytics` from preprod after
PR #655; all delivery PRs target preprod. Main/dev promotion is manual.

## Decisions

Desktop native pop-outs share one exact Paper/Real portfolio. Independent 1–4
charts and confirmed tickets are available in each window. Main window owns
pause, capital, imports, funding correction and closure. Closing a window only
detaches viewers. Companions never resolve a replacement active portfolio.
Website popups are excluded. Reuse native handoff/auth/geometry and existing
screen/preferences storage; no new trading locks, tables or credentials.

Analysis/Stats support Day/Swing and portfolio filters in both clients. A cycle
is exact-instrument flat→open→flat, including scale-ins and partial exits. Labels
can be assigned while open and retain stable cycle identity through closure,
restart and reconciliation. Completed-trade reports filter by final exit date;
open cycles use entry date. Executions retain actual IST dates. Imported basis is
separate inventory evidence, never a fabricated historical fill.

Stats separates closed-cycle outcomes, portfolio performance and current exposure.
Closed metrics: count, wins/losses/breakeven, win rate, net P&L, mean win/loss,
payoff, profit factor, expectancy, best/worst, streaks, calendar/trading-day holding
periods, duration buckets, instrument/symbol/tag/strategy breakdowns and captured R.
Partial exits contribute period realized P&L but do not count as completed trades.

Portfolio NAV = cash + held marked value. Daily native history values holdings;
actual cash flows are separate from trades/reservations and risk-reference edits.
Use cash-flow-adjusted returns, NAV and drawdown curves, drawdown duration and
monthly returns. Never combine unrelated portfolio percentages or duplicate child
capital. Missing cash-flow/valuation/fee evidence is surfaced. Current exposure
shows cost/value, cash, largest holdings, concentration and age with an as-of time.
Annual return/volatility/Sharpe/Sortino require >=365 calendar days and 252 complete
trading-day returns; risk-free/target is disclosed 0%. No annualized short periods.
Benchmark/TRI, money-weighted returns, corporate actions, automatic settlement,
new strategies and finalized Swing charge accounting are excluded.

## Sprints

| Sprint | Delivery | Status |
| --- | --- | --- |
| 0 | This scope/design/decisions and status links | Complete |
| 1 | Pinned portfolio companions and independent persisted workspaces | Implemented; automated checks complete |
| 2 | Execution history, stable open/closed labels and Swing Analysis | Implemented; automated checks complete |
| 3 | Closed-trade Swing Stats | Implemented; automated checks complete |
| 4 | Portfolio NAV, flows, drawdown and exposure | Implemented; automated checks complete |
| 5 | Review, focused/regression/browser/native checks and delivery record | Automated review complete; preprod broker/Windows acceptance pending |

## Interfaces and acceptance

Extend existing chart-workspace APIs with optional workspace ID (legacy primary
key unchanged). Reuse owned snapshots and order routes. Add owned Swing analytics,
execution/cycle and label interfaces; adapt existing Analysis/Performance APIs
with style/portfolio metadata and filtering. Reuse user-index queries and existing
operation receipts; add audit metadata to missing funding/reference evidence.

Verify multi-window shared fills/cancel races/duplicate submissions, independent
panes and dates, startup timeout/crash/reconnect/logout/closed books; exact options,
scale-ins/partial exits/overnight/month boundaries/imported holdings; label identity,
capital reference vs cash movements, missing prices/fees and hand-calculated return
and drawdown fixtures. Run client builds, desktop/native tests, browser workflows
and backend regressions. Broker/installed-Windows acceptance follows preprod merge
and deployment; mocks never place live orders.

## Implementation checkpoint — 2026-10-12

Sprints 1–4 are implemented on `feature/swing-linked-analytics` from preprod
`86b9931`. Sprint 5 automated review is complete. Deployment and authenticated
broker/installed-Windows acceptance remain post-merge steps.

### Window identity and lifecycle

Persisted desktop screen records use `workspace_kind=swing` and an immutable
`portfolio_id`; each companion has its own workspace ID. Native authentication,
handoff readiness, geometry, focus and close commands are reused. Day screen
updates preserve Swing records, and Swing records never mount a Day controller.
Companions GET their exact saved portfolio rather than resolving `/active`.
Missing identity, ownership/auth failures and closed books cannot create or attach
replacement capital. Failed pinned reads clear cached financial controls.

The main view creates/reopens companions. Every window has independent date,
interval, symbol, active pane, drawings and 1–4 layout. Main keeps portfolio pause,
capital, funding correction, import and closure controls. Companions can submit
confirmed entries/exits and cancel managed orders. Shared snapshots refresh every
two seconds; backend protection and its subscriptions remain portfolio-owned.
Window close uses the existing bounded save helper; closing a viewer does not
close the portfolio. Saved layouts restore on reopening; no automatic reopening
of external windows is introduced. Settings saves during main-view changes/detach
are awaited. Unsaved label edits require explicit Save and are guarded when
switching cycles or closing the history drawer; label drafts are not autosaved.

### History, labels and Analysis

Execution history reads committed trade/order evidence without refreshing broker
trading state. It shows actual IST dates/times, quantities/prices/known fees,
order/execution IDs, recorded status and retained warnings. Explicit broker
reconciliation remains a main-window action. History offers entry/exit date
selection, daily overview and intraday charts with execution markers; imported
basis is never inserted into the trade table. Hourly Swing markers use the same
09:15 anchor as history, without changing Day/Replay marker alignment.

Swing cycles use exact instrument identity and flat/open/flat grouping. Real cycle
IDs use the first opening broker order plus occurrence, so live execution IDs can
be replaced by official IDs without dropping labels. New label storage indexes
use 48 bits of cycle identity (exact in JavaScript); conditional writes reject
conflicting identities rather than overwriting another cycle. Proven legacy label
memberships remain readable. Latest explicit save wins for simultaneous edits to
the same cycle. No new trading lock or label-history infrastructure is added.

Both clients expose Day/Swing and portfolio filters in Analysis and Stats.
Session parents are excluded from child-session analysis; Swing selection uses
actual holding-date overlap. Performance completed cycles use final exit date;
open cycles use entry date. Paper/Real, brokers and portfolios remain separable.
Historical trade percentages use captured references; absent legacy references
stay unknown rather than being recalculated with today's capital. Imported capital
reference is captured on import, but original acquisition date remains unknown.

### Interfaces

| Interface | Addition |
| --- | --- |
| `GET/PUT /swing/portfolios/{pid}/charts/workspace` | Optional `workspace_id`; default primary namespace is unchanged, companions include portfolio/workspace identity |
| `GET /swing/portfolios/{pid}/execution-history` | Owned cycles, actual fills, recorded orders and warning |
| `POST /swing/portfolios/{pid}/labels` | Exact child/cycle identity and existing category/strategy/tag fields; no arbitrary trade editing |
| `GET /swing/portfolios/label-metadata` | Existing user taxonomy and saved tags |
| `GET /swing/portfolios/{pid}/analytics` | Date range, optional `history=false` for fast trade/exposure views |
| `GET /analysis/performance/swing` | Owned portfolio chooser and selected portfolio report, including mode/broker filters |
| Existing Analysis sessions/performance/cycles | `trading_style` and `portfolio_id` filters and cycle/date metadata |
| Existing labels/round trips | Swing open cycles and optional cycle identity on saves; Day compatibility retained |

Existing desktop authenticated facades carry these additions. The native analysis
allowlist adds only GET `performance/swing`; other methods and subpaths stay denied.

### Accounting and metric definitions

- Closed-cycle P&L sums FIFO matched proceeds less purchase basis and known allocated
  entry/exit fees. Win/loss/breakeven and expectancy use completed cycles only.
  Profit factor and payoff are unavailable without the required losing samples;
  captured-risk R and holding-period averages show their known sample counts.
- Period realized P&L includes matched partial exits on their actual execution dates.
  It differs intentionally from whole-cycle outcomes classified by final exit date.
  Return on cost divides completed-cycle net P&L by total purchase value.
- Daily managed-book NAV reconstructs cash plus held native-daily closing values.
  Reservations remain cash until execution. Remaining FIFO basis and entry fees
  determine unrealized value at the report's final valuation. Current exposure is
  separately timestamped and does not pretend to be a historical position snapshot.
- Daily returns use Modified Dietz: `(ending NAV - opening NAV - net capital flows)`
  divided by `(opening NAV + time-weighted flows)`, with weights from the remaining
  09:15–15:30 session. Returns compound across valued trading days. Only completed
  daily valuations enter this series; today can still contribute actual realized
  executions and current exposure before the close.
- Percentage drawdown uses the compounded cash-flow-adjusted growth curve. Rupee
  drawdown uses portfolio value with cumulative capital transfers removed, so cash
  withdrawal is not a loss and deposited capital is not a gain. Valued-period P&L
  is closing NAV minus opening NAV minus classified capital transfers.
- Monthly returns flag partial periods. CAGR uses calendar elapsed time, volatility
  and Sharpe use 252 trading days, and Sortino uses downside deviation over all
  observations. Annual metrics require >=365 days and 252 complete daily returns;
  zero-variance/zero-downside ratios stay unavailable. Risk-free/target remains 0%.

Funding receipts record timestamped allocation deltas and reference changes in
existing atomic/idempotent writes. Paper reference edits record zero cash flow.
Legacy initial-capture and reference-only receipts are known non-flows; legacy
allocation/correction receipts without sufficient evidence suppress historical
cash/NAV and returns. Unclassified cash-shortfall corrections update the recorded
cash but do not claim a known investment return across that date. No classification
is inferred from free-text reasons. A later period with a known opening valuation
can still be measured. Imported holdings without a capture-time market valuation
cannot claim pre-import appreciation as this portfolio's return; later complete
valuations provide a baseline. Missing prices remain gaps, never zero prices or
interpolated performance. Charts break at missing observations.

These are app-managed allocation books, not full brokerage-account reports.
Fees remain known application estimates; unknown imported charges are disclosed.
Dividends, corporate actions, benchmark/TRI, finalized Swing charges and automated
settlement are excluded. Shared-funding reconciliation warnings remain visible.
The implementation follows measurement conventions; it does not claim GIPS
certification or complete broker contract-note accounting.

### Verification and rollout

The delivery PR records final command counts. Full backend checkpoint: **2,226
passed and two existing local ICICI credential failures** (`test_missing_strike_returns_400`
and `test_invalid_right_returns_400`). Final focused backend check: **125 passed**, including rupee-drawdown, legacy
non-flow corrections and cross-surface legacy order retries. Client attribution
is recorded for analysis but excluded from economic order identity, so moving a
retry between website and desktop cannot duplicate or reject an unchanged order. Desktop: **203 passed**. Native
Rust: **20 passed**. Website/desktop TypeScript checks and production builds pass.
New modules/tests pass Ruff and whitespace checks.

`scripts/swing-linked-analytics-browser-check.mjs` exercises both actual chart
renderers with synthetic books: open-trade labels, all Stats views, independent
companion preferences, shared orders/fills, pinned GETs without active-book lookup,
main-only capital/close controls and close-without-portfolio-closure. It mocks
window hosting and broker responses; it is not installed-Windows/broker evidence.
Existing desktop portfolio-management, desktop Analysis and all seven website
Analysis renderer checks also pass.
No live orders were sent.

After preprod merge, deploy backend and install the Windows bundle. Check real
native handoff/focus/geometry, main/companion close, app restart, logout/relogin,
server outages, closed and replaced portfolios, simultaneous confirmed orders,
shared cancellation/fills and unchanged backend protection. Validate Paper first,
then small authorized Kite/Kotak trades and overnight/partial-fill/import evidence.
Compare report dates, funding edits and hand-calculated P&L to actual broker records.
Promote main/dev manually only after acceptance.

References: [GIPS performance calculation conventions](https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/),
[CFA portfolio performance evaluation](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/portfolio-performance-evaluation).
