# Phase 21 — Swing improvements and Futures implementation plan

Work branch: `feat/phase21-swing-futures`, based on `preprod`. Every PR targets
`preprod`; main/dev promotion remains manual after acceptance. Preserve the user's
Phase 21 requirements. Planned validation is distinct from actual results below.

## Sprint status

| Sprint | Deliverable | Status |
| --- | --- | --- |
| 0 | Full design, decisions and scope | Complete |
| 1 | Desktop workspace, controls, messages and navigation | Implemented; installed acceptance in Sprint 7 |
| 2 | Selected-date markers and desktop drawing sharing | Implemented; native cross-window acceptance in Sprint 7 |
| 3 | Futures contracts, data, previews and risk settings | In progress: discovery and equity/options percentage sizing implemented |
| 4 | Paper Futures ledger, MTM, offline and expiry lifecycle | Pending |
| 5 | Kite/Kotak Real Futures and reconciliation | Pending |
| 6 | Futures Stats, Analysis and markers | Pending |
| 7 | Review, regression and installed/broker acceptance | Pending |

## Agreed decisions

- Swing Futures on website/desktop, Paper/Real, Kite/Kotak. Long and short
  Futures; equity delivery and options retain their current long-only behavior.
- Listed Nifty/Sensex index futures and eligible existing Nifty 100 constituent
  stocks. No invented Nifty 100 index contract. Actual masters determine lots,
  ticks, expiry and eligibility; no guessed calendar expiry.
- Nearest unexpired monthly contract; next month appears seven calendar days
  before actual expiry, the agreed simplification of the original two-day rule.
  Held contracts remain manageable outside the entry window.
- Percentage sizing uses portfolio capital: purchase cost for equity/options,
  margin plus fees for Futures. Quantity remains default. Whole lots rounded down,
  zero lots rejected, no silent size/capital change.
- Offline confirmed Paper intentions reserve dated estimates but fill only with
  fresh executable quotes, usable margin and current guardrail/allocation checks.
  Keep confirmed quantity; exceeding approved budget requires review.
- Real expiry: warnings/manual exits and rollover. Paper expiry: attempt actual
  quote exit at 15:15; unavailable quotes leave it pending, not fictitious settlement.
- Drawing sharing is desktop-only. Website drawing storage remains separate.
- Markers use selected chart date, not viewport: Open reconstructs positions open
  at cutoff; All includes completed cycles through that date, current portfolio only.
- Independent desktop Day/Swing windows and Swing pop-out; website retains view
  switching. New website multi-session screens are deferred.
- View switching, chart detach and window close never close books or stop backend
  protection. Pause entries and close portfolio remain separate operations.

## Sprint 0 — Documentation and baseline

Link this document from Phase 21. Record complete design, API additions, accounting
examples, assumptions, exclusions and actual validation after each sprint. Establish
the existing test baseline and preserve user-edited requirements.

## Sprint 1 — Workspace, controls and messages

One collapsible desktop Swing drawing/indicator/marker toolbar outside panes,
targeting the active chart without remounting other charts. Keep compact
instrument/date/interval headers. Remove provider/live quote row on desktop;
retain visible failures/retry and compact workspace feed status. Independently
collapse both panels without losing ticket drafts or chart viewport. Persist per
workspace/window; old workspaces default to visible panels. Pick on chart and
Place intention become accessible icons with tooltips and unchanged ordering,
disabled rules, cancellation and form submission behavior.

Reuse website nonmodal message journal on desktop: bounded history, dismissal,
de-duplication and source/book context. Persistent financial/recovery blockers remain
visible after dismissal. No backend RPC on notification paths.

Existing desktop Day screens stay mounted when selecting Swing. Existing Pop out
Swing opens a pinned portfolio then returns to Day only after success. Verify
linked window/restoration/save guards; failed saves/pop-outs preserve current view.
Website retains Swing and return-to-Day navigation; no new session framework.

## Sprint 2 — Historical markers and shared drawings

Filter actual fills by exact symbol/contract and exclusive next midnight after
selected date using repository IST-wall timestamps. Reconstruct FIFO cycles at
cutoff, including partial exits; positions closed later still appear open at earlier
cutoffs. Do not use current `is_open` for historical reconstruction. Portfolio,
account and Paper/Real isolation; derivative underlying markers require captured
underlying execution prices. Imported basis/settlements are not execution markers.
Per-pane Open/All/Off mode updates overlays without recreating charts.

Desktop drawing identity is user + exact instrument, without broker token,
portfolio or interval. Preserve private legacy drawings without silently merging,
promoting or deleting. Exact Futures expiry separate from spot/options. Paginate
existing queries; preserve revision checks, cross-window/focus reload and conflict
feedback rather than overwriting concurrent edits. Website unchanged.

## Sprint 3 — Futures identity, data and previews

First-class `futures` throughout charts, orders, feeds and broker interfaces; no
equity disguise or option right FUT. Canonical exchange/underlying/kind/expiry;
preserve legacy equity/options keys and cycle IDs. One execution child per exact
contract shares root cash and existing broker/style slot. Resolve FUTIDX/FUTSTK
metadata and archive tokens for expired history. Actual contract quotes/history,
no spot/continuous-series execution substitutes. Respect Admin data provider policy.

Owned order preview binds portfolio/contract/side/price/quantity/capital revision;
return budget, required funds/fees, unused budget, source/time and execution
eligibility. Revalidate server-side at submission. Normalize Kite and installed
Kotak SDK margin responses, including returned error dicts. `reqdMrgn=0` does not
mean zero required margin. Missing/unusable live margin blocks fill/submission.

Admin-editable dated offline estimates and fee profiles: seed verified published
contracts and cache successful quotes with source/date/reference price/quantity.
No estimate means Admin override before offline reserve. Off-hours refresh failure
retains dated values. Paper broker profile claims no Real slot; shared cost model
across preview/ledger/Stats with captured effective versions/editable brokerage.
Preserve existing equity/options fees. Paper cannot promise account-wide hedge
offsets or exact RMS replication.

## Sprint 4 — Paper Futures accounting and lifecycle

Separate cash, held margin, pending reserves, settled MTM, unsettled P&L and fees.
Margin lock reduces available funds, not NAV; fees reduce NAV. Never debit
notional/add it as an asset. Keep economic entry and settlement bases separate;
closed economic FIFO P&L uses original fills, exit cash posts only remaining
unsettled movement. Official settlement prices, not ordinary candle close.
Idempotent contract/date events; restart catches missed settlements before new
fills. Missing evidence stays pending.

Partial fills/closes and long/short supported; explicit close before reversal.
Offline captures confirmed size/budget/estimate/next eligible session. Revalidate
quotes/margin/guardrails before fill, never resize silently. New Paper Futures
entries use DAY validity (offline next eligible session), existing equity/options
validity unchanged. Expiry exit at 15:15 with actual quote. Restore all contexts,
reservations and settlement state before execution resumes.

## Sprint 5 — Real execution and reconciliation

NRML Futures, exact account/product/contract/owned-order reconciliation. Reuse
journals, CAS reservations and uncertain-ACK handling; never retry unknown writes.
BUY closes shorts, SELL closes longs; no automatic cross-flat reversal. Renew DAY
protective exits only with confirmed holdings/fresh quotes; never recreate entries.
Broker cash authoritative; legitimate margin/MTM movements must not appear as
outside tampering. Profit/MTM/margin do not reset capital reference or guardrails.

Manual expiry warnings/rollover. Unconfirmed stock Futures delivery obligations
retain reconciliation warning; no fabricated shares/flat/history or premature book
release. Enable Kite and Kotak separately after broker-specific acceptance.

## Sprint 6 — Stats and Analysis

Typed Futures in contracts/orders/trades/quotes/panes, compatible legacy defaults.
Direction, index/stock, expiry, broker/Paper profile, notional exposure, captured
margin/utilization, return on margin separately from notional return. MTM split,
fees and economic result reconcile without double counting; margin transfers are
not profit. Existing outcome/holding-period/final-exit date metrics and labels
retained. Unknown basis/settlement/fees remain unknown. Exact-contract markers.

## Sprint 7 — Review, tests and rollout

Focused checks each sprint, then integrated backend/client/native review. Cover
master aliases/listing outages/holiday actual expiry/seven-day boundary/expired
holdings; lots/fees/stale preview/capital reset/linked concurrency; partial fill,
cancel, modify, rejection, unknown ACK, auth expiry and restart mid-submit; margin
refund/negative MTM/missing and duplicate settlement/no double counting; manual
expiry/RMS/physical obligations; historical markers/partials/scroll/underlying
price gaps; drawing conflicts/panel collapse and concurrent Day/Swing pop-outs.

Regress Day Paper/Real/Replay/Stepwise, Swing equity/options, auth, wallet isolation,
guardrails, labels and Stats. Both client builds/browser checks, backend checks and
installed Windows acceptance. Synthetic broker fixtures until authorized acceptance;
no live orders in automated validation. Report environment failures separately.

Deploy backend before clients. Paper first; Kite/Kotak Real independent gates.
Disabling entries preserves exits/cancel/history/recovery. No main/dev promotion
before preprod acceptance.

## Deferred and limitations

No Day Futures, short options, automatic Real rollover, physical-delivery automation,
complete exchange SPAN engine, website multi-session screens or website drawing
sharing. Accounting/reconciliation is the hardest work; UI is smaller. Actual broker
RMS and contract notes remain authoritative for Real costs and obligations.

## Primary references researched 2026-10-13

- [Kite margin API](https://kite.trade/docs/connect/v3/margins/)
- [Kite instrument master](https://kite.trade/docs/connect/v3/market-quotes/)
- [Kite historical tokens](https://kite.trade/docs/connect/v3/historical/)
- [Kotak SDK](https://github.com/Kotak-Neo/kotak-neo-python), installed 3.0.7
- [Kotak master fields](https://github.com/Kotak-Neo/Kotak-neo-api-v2/blob/main/docs/Scrip_Search.md)
- [Kotak margin response](https://github.com/Kotak-Neo/Kotak-neo-api-v2/blob/main/docs/Margin_Required.md)
- [NSE contracts](https://www.nseindia.com/static/products-services/equity-derivatives-contract-specifications)
- [Published Futures margin](https://zerodha.com/margin-calculator/Futures/)
- [Daily settlement](https://www.nseclearing.in/clearing-settlement/equity-derivatives/settlement-mechanism)
- [Stock delivery policy](https://support.zerodha.com/category/trading-and-markets/trading-faqs/f-otrading/articles/policy-on-physical-settlement)
- [Charges](https://zerodha.com/charges/)
- [Kotak API brokerage](https://www.kotakneo.com/support/what-is-the-brokerage-for-using-neo-trade-api/)

## Actual implementation and validation

### 2026-10-13 — Sprints 0–2 and initial Sprint 3 work

Implemented:

- New branch based on preprod and complete linked design; original requirement edits retained.
- Desktop active-pane toolbar, independent panel collapse, icon price pick/submit,
  removal of the per-pane provider/live quote line, and workspace preference persistence.
- Shared nonmodal notification implementation used by website and desktop, with
  account/server/window-isolated desktop storage. Desktop Day and Swing reporting;
  financial/recovery warnings remain independent of dismissal.
- Existing Day/Swing navigation, pinned linked windows and successful Swing pop-out
  behavior retained. Website retains its existing view switching.
- Swing Open/All/Off markers on both clients, selected-date reconstruction, exact
  contracts, partial exits and imported inventory evidence. `marker_basis` is
  evidence only; no imported execution marker is created. Desktop overlays retain
  identity across quote changes. Changing marker mode does not restart history/feed.
- New desktop drawings share the existing Day instrument namespace. Current-window
  legacy private drawings remain visible and private. Drawing queries paginate;
  moved drawings save; conditional write races become revision conflicts. Native
  events/focus refresh propagate changes without replacing in-progress drawings.
- Capital % BUY sizing on both clients for current equity/options. Server previews
  include current cost model/fees and whole-lot minimum. Capital epoch and size are
  rechecked at placement, with unchanged-order retry compatibility preserved.
- Read-only Futures discovery for Kite/Kotak, exact underlying/venue/expiry, listed
  lot/tick sizes and next-month entry eligibility. Kotak master retains lot/tick
  metadata; malformed tick data cannot break other master parsing. Numeric expiry
  follows the installed SDK conversion. Futures execution remains disabled.

Public interfaces added/extended:

- `GET /swing/portfolios/capabilities` adds authenticated `user_id` for desktop
  message account isolation; no broker funds/account credentials are returned.
- `POST /swing/portfolios/{id}/order-preview` currently previews capital % BUY
  equity/options entries using the existing fee model, without creating contexts,
  reserving cash or submitting orders. It is not a Futures margin API yet.
- Orders accept optional `capital_pct` (fraction, above zero through one) and
  `capital_revision` (guardrail epoch). Quantity remains explicit and backend-checked.
- Workspace preferences add `rail_open`, `ticket_open`, `tools_collapsed` and
  per-pane `marker_mode`; old records use visible panels/Open markers defaults.
- Snapshots add `marker_basis` for imported opening inventory and capture timestamp.
- `GET /swing/portfolios/contracts/futures?symbol=...&provider=kite|kotak` returns
  exact metadata and `execution_enabled: false`. Existing execution request schemas
  continue to reject Futures until the lifecycle/accounting sprints are implemented.
- These routes also use the existing `/api/desktop/v1` facade. Deploy backend before
  dependent clients, particularly percentage sizing and preference persistence.

Actual verification:

- **299 backend tests passed** across Swing, Futures discovery, desktop persistence,
  Kotak SDK/master migration and live history providers.
- **212 desktop tests passed**; both client TypeScript checks and production builds passed.
- **14 notification journal tests passed**, including account isolation and dismissal.
- Updated workspace browser checks passed on both actual chart renderers: four panes,
  independent dates, price pick, collapse, active toolbar, saved preferences,
  percentage submission, stale preview blocking, failed preview and quantity exits.
- Linked analytics browser checks passed on both renderers: labels/Stats, desktop
  shared-book windows, retained private drawing lookups and shared namespace lookup.
- Built desktop Kotak login regression passed (synthetic authentication only).
- New Python modules/tests pass Ruff. Incremental lint review identified no new
  outstanding findings; existing files have pre-existing lint findings. Diff whitespace check passed.
- No live orders or broker authentication codes were sent. Native hosting remains
  mocked in browser checks; installed Windows handoff/event synchronization and
  authorized broker acceptance remain in Sprint 7.

Remaining work — not implemented and not ready for Futures trading:

1. Finish Sprint 3: client contract selection/first-class instrument propagation,
   exact contract feed/history/archive, live broker margin normalization, Admin
   dated estimates/fee settings, Futures margin-budget previews and gates.
2. Sprint 4: Paper Futures ledger, long/short lifecycle, official settlement/MTM,
   offline reservations, expiry exit and restart recovery.
3. Sprint 5: Kite/Kotak NRML Futures routing, authoritative cash/MTM reconciliation,
   protective exits, unknown acknowledgments and expiry/delivery reconciliation.
4. Sprint 6: Futures Stats/Analysis and exact-contract marker integration.
5. Sprint 7: final integrated review/regression and installed/broker acceptance.

No PR is claimed ready for the complete Futures scope at this stage.
