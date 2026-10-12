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
| 1 | Swing market window, backend price lifecycle, restart recovery and position P&L | Open/close/holiday/restart/detach checks pass | In progress |
| 2 | Provider daily/minute history, caches, pagination and renderer daily support | Exact history loads without fake bars or Replay cache changes | Pending |
| 3 | Portfolio rail, independent 1–4 charts, drawings/indicators, persistence and live panes | Both clients compare instruments/dates and restore workspace | Pending |
| 4 | Ticket/picker, order/position overlays and management drawer | Exact, explicit, idempotent submission retains existing protections | Pending |
| 5 | Review, regression/browser/native checks and preprod acceptance | Automated evidence recorded; live/native acceptance separate | Pending |

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
