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
| 1 | Pinned portfolio companions and independent persisted workspaces | In progress |
| 2 | Execution history, stable open/closed labels and Swing Analysis | Pending |
| 3 | Closed-trade Swing Stats | Pending |
| 4 | Portfolio NAV, flows, drawdown and exposure | Pending |
| 5 | Review, focused/regression/browser/native checks and delivery record | Pending |

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
