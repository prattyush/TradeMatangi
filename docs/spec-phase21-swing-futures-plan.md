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
| 3 | Futures contracts, data, previews and risk settings | Implemented and automatically validated |
| 4 | Paper Futures ledger, MTM, offline and expiry lifecycle | Implemented and automatically validated |
| 5 | Kite/Kotak Real Futures and reconciliation | Implemented; independent Real gates await broker acceptance |
| 6 | Futures Stats, Analysis and markers | Implemented and automatically validated |
| 7 | Review, regression and installed/broker acceptance | Code review and automated regression complete; installed/broker acceptance remains manual |

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
metadata and archive identity evidence. Expired token reuse is unsafe: use captured
exact-contract cache or an exact-expiry historical provider. Actual contract quotes/history,
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

### Earlier checkpoint — Sprints 0–2 and initial Sprint 3 work

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

That checkpoint has been superseded by the completed implementation below.

### 2026-10-13 — Sprints 3–7 implementation and review

All planned application work is implemented on `feat/phase21-swing-futures` for
`preprod`. Automated validation is complete. Installed Windows handoff and actual
broker acceptance require deployment and user testing; they are not claimed done.
Paper Futures defaults on for new settings. Kite Real and Kotak Real default off,
with separate Admin switches for the agreed broker-specific acceptance rollout.
Existing saved switch values remain authoritative.

#### Contracts, data, sizing and settings

- Exact Futures identity survives chart/history/live feed, persistence/restart,
  order routing, execution history, Stats and Analysis on website and desktop.
  Futures are Swing only. Actual lot, tick, venue and expiry come from the masters.
- `GET /contracts/futures` now returns `paper_enabled`, `real_enabled` and their
  combined `execution_enabled`. Placement checks the portfolio's actual mode gate;
  discovery does not reserve cash, claim slots or submit orders.
- Margin previews use Kite basket initial requirement with `consider_positions=false`
  and Neo `ordMrgn`; zero `reqdMrgn` is not interpreted as free margin. Missing,
  zero, nonfinite and error responses cannot authorize an entry. Preview evidence
  records source/time; Admin estimates additionally record their observation date.
- Admin Futures settings include separate enable switches, dated observations,
  broker fee profiles and off-hours refresh. Existing Dynamo tables and version
  checks are reused. Refresh/cache failure retains old observations and does not
  invalidate fresh broker evidence. No new database or infrastructure is required.
- Capital % floors whole lots against margin plus fees. Confirmation carries explicit
  quantity, budget, fee hash and capital revision. Submission recalculates; trigger
  execution also checks fresh price/margin, funds, capital revision and guardrails.
  No silent resizing or extra orders to use leftover budget.
- Paper broker profile is immutable per portfolio, defaults to Kite for old books,
  and never takes a Real broker slot. Equity/options cost behavior is unchanged.

#### Paper ledger and recovery

- Cash, pending reservations, held margin, official settled MTM, unsettled movement,
  execution fees and economic P&L have separate evidence. A margin lock is collateral,
  not an expense; Futures notional is exposure, not a NAV asset.
- Fills atomically write cash receipt, Order, Trade and versioned Futures ledger.
  Original economic entry price and latest settlement basis stay separate. Partial
  long/short closes release proportional margin and post only remaining unsettled
  movement. Exit fees are accounted for once; BUY covers a short without BUY notional.
- Official NSE UDiFF ZIP and BSE UDiFF CSV use exact symbol/actual expiry and
  `SttlmPric`, never OHLC close. Files cache atomically; unavailable publication retries
  with a cooldown. Contract/date settlements are idempotent across restart.
- Offline intentions reserve a dated estimate and the next eligible trading session;
  actual fills wait for live exact-contract price and usable broker margin. An
  increased cost may use funds only within the approved budget. Over-budget or
  insufficient funds needs review/cancel-and-replace; no fake fills or size changes.
- Entries have DAY validity. Paper expiry/portfolio close uses a subsequent actual
  quote; expiry close attempts from 15:15. No quote means a pending position, not a
  fabricated exit. Missing settlement/margin or repair blocks new entries while
  held positions/exits remain manageable. Startup restores the durable ledger/book
  before market-hour subscriptions resume, using the Admin data-provider policy.

#### Real execution and protection

- Kite/Neo Futures use exact listed ticker, correct FO venue, NRML and DAY. Day MIS,
  equity CNC and existing options NRML routing remain separate. Shared NRML report
  cache stays complete; exact contract filtering happens after cache retrieval.
- Confirmed individual executions preserve FIFO for interleaved partial fills.
  Fees are allocated once per broker order. Ledger rebuild uses the durable journal,
  official settlement events and held-margin adjustments. Broker balances remain
  authoritative; legitimate MTM/margin changes update the existing funding model.
- Unknown/submitting acknowledgments remain reconciliation barriers and are never
  blindly retried. Known rejected triggered orders are cancelled. Fill callbacks
  request confirmed journal refresh instead of using legacy synthetic spot fills.
- Futures entry amendments require cancel-and-replace with a fresh preview. Owned
  exits retain safe conversion paths; quantity cannot cross flat. Protective DAY
  renewal keeps exact expiry and short BUY/long SELL direction, deterministic identity
  and fresh quote checks; prior cancel/conversion/split state is cleared on renewal.
- Expiry rollover is manual. Stock delivery review needs an owned acknowledgment and
  verified current derivative flatness before closing. Historical delivery/cash/P&L
  warnings remain; no shares or executions are fabricated to make the book appear flat.

#### Stats, Analysis and charts

- Futures filter and exact-expiry execution charts are supported in global Analysis,
  portfolio History and both chart renderers. Swing labels/outcome metrics remain.
- Futures Stats distinguish captured return on margin, held margin/utilization,
  notional exposure, settled MTM, unsettled P&L, long/short and index/stock cycles.
  Missing margin/basis is unknown rather than an invented zero return.
- Daily portfolio NAV uses economic FIFO P&L and actual contract marks; it does not
  debit/add notional or count settled MTM twice. Its cash component is an economic
  valuation model, not a historical broker-available-margin statement.
- Open/All markers use the selected chart date and exact contract. Futures execution
  prices stay off underlying charts without captured underlying evidence. Existing
  drawing sharing, independent panels, toolbar collapse and Day/Swing windows remain.

#### Review findings fixed

The review fixed short-cover notional reservation, generic entry-edit bypasses,
missing persisted expiry, Futures initial-pane restoration, mixed NRML cache scope,
Breeze cash/Futures route collision, stale post-margin quotes, renewed cancellation
state, capital-change trigger handling and Futures prices appearing on underlying
charts. It also moved non-Real malformed option validation ahead of broker data
fetches. Exit management is not blocked by a changed entry fee hash or enable gate.

#### Actual validation

- Full backend regression: **2,307 passed**. Additional Real ledger/renewal coverage
  was added afterward; the full Futures evidence file passed **22 tests**.
  Final affected backend regression passed **121 tests**; a subsequently added
  emergency short-cover regression passed with all **8 Paper Futures tests**.
- Both client TypeScript checks and production builds passed. **213 desktop tests**
  and **14 notification tests** passed. Built desktop Kotak login regression passed
  for popup, cancellation, validation, retry, busy submissions and Kite isolation.
- Shared workspace browser checks passed on both actual renderers, including exact
  Futures selection, short entry, whole quantity, budget/fee confirmation, price
  picking, independent dates, panel/tool collapse and existing percentage orders.
- Linked Analytics browser checks passed on both renderers: labels/Stats and pinned
  shared desktop portfolios. Native Tauri hosting is mocked for these checks.
- New Futures services/tests pass Ruff. Synthetic brokers/exchange files were used;
  no live authentication codes or broker orders were sent.

#### Limits and manual preprod acceptance

1. Deploy backend before clients. Test Paper first, then enable/test Kite and Neo
   Real independently in Admin. Verify real margin responses, partial execution,
   cancellation, unknown acknowledgment, DAY renewal and account cash/MTM against
   broker reports before treating Real Futures as accepted.
2. Installed Windows: verify Day and Swing side by side, pop-out/linked windows,
   panel sizing, drawing synchronization after reopen and account-isolated messages.
3. Expired Kite/Neo token IDs can be reused/purged. Archived metadata preserves
   identity, not safe provider access. Captured exact-contract cache can be read;
   uncached expired history needs an allowed exact-expiry provider such as Breeze.
   Missing data is disclosed, never substituted with spot/continuous history.
4. No Day Futures, commodity/currency futures, synthetic Nifty 100 index contract,
   automatic rollover, automated physical delivery or external Futures opening-
   inventory adoption. Reconcile external broker positions explicitly. No invented
   settlement, fills or physical-delivery P&L. Ordinary Paper entry fills are full
   confirmed quantity; partial closes and Real partial executions are supported.
5. Positive standalone margin is deliberately conservative. This is not a complete
   account-wide SPAN/hedge/RMS replica. Final fees and delivery obligations follow
   broker contract notes; Admin estimates are editable and captured per order.
6. Existing exchange holiday coverage must be maintained annually. The next-month
   window is the agreed **seven calendar days before actual listed expiry**, replacing
   the original two-day request. Long equity/options behavior stays unchanged.

Primary references: [Kite margins](https://kite.trade/docs/connect/v3/margins/),
[Kite orders](https://kite.trade/docs/connect/v3/orders/),
[Zerodha charges](https://zerodha.com/charges/),
[Neo SDK](https://github.com/Kotak-Neo/Kotak-neo-api-v2), and exact-date official
NSE/BSE bhavcopy URLs captured in each settlement event. Publication formats were
checked read-only against 2026-10-12 exchange files; this does not constitute
live trading acceptance.
