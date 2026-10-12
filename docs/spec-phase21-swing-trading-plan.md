# Phase 21 — Nifty 100 and Swing Trading

Approved design, 2026-10-10. Work branches originate from preprod and all PRs
are reviewed into preprod. Deployment/runtime acceptance follows preprod merge;
main/dev promotion remains manual. The original Sprint 0 design and subsequent
implementation/review checkpoints are retained here.

## Integration update — 2026-10-12

The Swing delivery is merged to preprod through PR #652 and is being tested.
The [main → preprod integration](spec-phase21.md#main--preprod-integration--2026-10-12)
preserves these ownership, funding and recovery decisions while importing the
later main/dev improvements. Finalized Real charges apply to **Day analytics
only**; Swing remains estimated until explicit per-execution-date support is
implemented. The combined backend suite passed 2,189 tests (two known local
ICICI failures); desktop 194, native Rust 19 and both client builds passed.
Mocked browser checks do not establish authenticated runtime acceptance. This correction UI is separate from shared cash reconciliation and
cannot resize capital, change live P&L guardrails or move funding. No broad Swing
charge-history scan, new fill reconstruction or live broker validation is implied.

## Current review status — 2026-10-11

Authoritative status for this revision is this section and the review checkpoint
below. Earlier checkpoints are historical snapshots, not competing completion
claims. Work remains on `feature/phase21-swing-trading`, based on preprod; every
PR targets **preprod**. No main/dev merge or authenticated live acceptance is
implied by automated checks.

The self-review reproduced eight gaps missed by the earlier suite: child ownership
adoption, engine readiness during context restoration, incomplete startup recipes,
allocation-versus-reconciliation retries, partial-fill reservations, pending
funding entry reservations, unknown submission dating and empty-portfolio cash
correction. Fixes and permanent regressions are now implemented. The former
2,094-pass result describes the pre-review code; final results for this revision
are recorded in the review checkpoint below.

The approved ownership model remains four broker/style slots, with one Day and
one Swing owner per broker across users, and one funding pool per actual broker
account. Paper/Replay limits are unchanged. The broader linked Swing views,
multi-day Replay, remaining Paper edges and live/native preprod acceptance remain
outstanding.

## Decisions and scope

- Persistent multi-symbol portfolios in website and desktop, prioritising Paper
  and Real (Kite and Kotak), then multi-day Replay. Equity long and CE/PE long;
  no short Swing positions, futures, MTF or automatic stock-option settlement.
- Intraday and Swing can coexist for one user at one broker/account. Preserve
  one intraday session and one Swing portfolio; child contexts are portfolio-owned.
  Broker credentials remain centrally configured. Distinct application users do
  not represent distinct broker accounts. Separate desktop login profiles deferred.
- Closing a screen detaches. Pause blocks new entries while keeping existing
  positions, protection and exit strategies managed. Close portfolio cancels
  entries and verifies exits before release. No normal end-of-day Swing flatten.
- Expand the shared catalogue to a pinned official Nifty 100 constituent snapshot,
  retaining existing canonical aliases/history keys. Search by name/symbol in both
  clients, grouped into existing indices/equities sections. Options only when real
  instrument metadata establishes eligibility; never guess expiry or lot sizes.
- Broker quote/minimal-history probes are read-only, paced, use existing credential
  loading, and report provider mapping/history availability separately. No secrets
  in output, no trading writes, and no fictitious historical coverage.

## Capital and funding

Session capital is a fixed sizing/P&L reference. Actual broker funds remain the
shared authority for affordability. Maintain separate changing mode balances and
a shared broker/account funding record, not duplicate alarms in each session.
Capture initial account reference when the first participating mode starts. The
later mode uses this starting reference instead of depleted free cash. Combined
allocations cannot exceed the account allocation reference. Retain the account
record while either mode remains active, including closed intraday-session effects.

Example: account reference 10L; Swing 80%=8L; loss 3K; open shares cost 2L. Swing
expected free balance is 5.97L. Remaining/intraday 20%=2L. Combined expected free
cash is 7.97L. A later intraday start retains its 2L reference. Investments are not
losses; MIS consumes actual margin, delivery shares/premiums consume full value.

Account for confirmed fills, principal released, losses, fees, active commitments,
unallocated cash and settlement adjustments. Profits remain visible but do not
raise the funding expectation or references automatically. Broker funds determine
usability; do not hardcode T+1 as a cash credit. Do not double-count local reserves
already included in broker margin. Partial/inconsistent reports mean reconciliation
pending, not a proven withdrawal. Unexpected increases do not auto-rebase capital.

A confirmed unexplained shortfall blocks new entries in BOTH modes, never exits,
cancellations or protection. Both screens read one versioned funding status and
receive its event. Wallet popup explains funds, mode balances, commitments, P&L,
difference and timestamps. Compact toolbar: Funds [actual] · Capital [reference].

Correction is explicit and selected-mode only: preview reference and attributed
funding adjustment, persist both atomically, and retain order quantities/history.
A percentage edit alone cannot erase a funding difference. A full correction clears
the shared entry barrier after verification and tells the sibling its reference
is unchanged; partial correction leaves the remaining gap visible/blocked. Preserve
original reference/capture evidence and append correction events rather than rewrite
executions. New cohort captures fresh funds when no participating mode remains.

Swing guardrails use realised plus unrealised portfolio P&L since start/latest
explicit capital reset, relative to the selected reference. No daily reset. Capital
reset starts a new guardrail epoch and clears that mode's entry ban; historical
trades/P&L/events stay intact. It does not independently clear an unresolved funding
shortfall. Existing orders/strategy instructions retain their chosen parameters.

## Books, orders and recovery

Persist portfolio parent and single-symbol/instrument execution children in existing
storage, with style/portfolio identity. Legacy records default to intraday. Share
one portfolio wallet/reference across children and one Replay clock across views.
Separate current market date from portfolio start date; per-execution dates persist.
Day boundaries must not overwrite prior fills or reset references/FIFO positions.

Reuse current execution ownership: ordinary entry Limit/Target intentions stay
application-managed; resting exit SL/Limit orders are broker-backed; strategies
run in the application and use existing confirmed conversions. No OCO. Maintain
existing exit allocation, partial-fill and uncertainty protections.

Uncancelled entry AND exit intentions carry across days. Broker DAY attempts expire
and are reconciled/renewed when the backend is online. Preserve intent and attempt
history; respect deliberate cancellations. Never blindly resend unknown submissions.
Real reconnect imports actual broker evidence before current-quote evaluation of
local intentions. Paper replays available prices for broker-like orders ONLY during
valid windows, applying existing trigger/fill logic including stop-limit gaps.
Application-owned intentions/strategies resume from current price. No renewal while
offline and no invented fills if historical evidence is unavailable. Replay uses
virtual market time and skips non-trading periods, not elapsed offline wall time.

Explicit imports adopt selected delivery holdings/long overnight positions at broker
average cost, as opening inventory. Never import MIS, fabricate original trades,
debit broker cash again or adopt the same quantity twice. Unrelated holdings remain
outside the book; reconcile delivery holdings/T1/current-day orders without duplication.
Paper/Replay attempt option exits 15 minutes before actual expiry-day market close,
regardless of P&L; use executable available data and expose unresolved closure.
Real option expiry exit is MANUAL. Broker settlement obligations still exist and
are not implemented or represented as a fictitious application exit.

## Interfaces and rollout

Add portfolio/style identity, account allocation/funding status, capital-reset and
guardrail epochs, explicit imports and portfolio pause/resume/confirmed-close actions.
Both clients use the same backend calculations/events. Existing session APIs keep
intraday defaults. Account/product checks fence updates to the appropriate book;
intraday funds refresh must not overwrite frozen Swing references. No personal
broker credential infrastructure, OCO, auto account-reduction or auto quantity scaling.

| Sprint | Delivery | Status |
|---|---|---|
| 0 | Scope, design, decisions, exclusions and verification record | Written |
| 1 | Catalogue, mappings, search and read-only provider probes | Implemented; authenticated provider probes pending |
| 2 | Persistent Paper portfolio, contexts, accounting and controls | In progress; basic runtime and controls implemented |
| 3 | Shared Real funding, imports and manual correction | Runtime wiring, explicit imports and negative cash correction implemented; live acceptance pending |
| 4 | Kite/Kotak delivery execution, renewal and recovery parity | Real multi-day journal/runtime and evidenced expiry renewal implemented; authenticated broker acceptance pending |
| 5 | Portfolio UI, linked views and funding notifications | Paper/Real controls, reconciliation, imports and correction previews in both clients; linked Swing charts pending |
| 6 | Multi-day Replay and expiry exits | Pending |
| 7 | Integration, preprod delivery and runtime/native acceptance | Pending |

Verify persistence across nights/weekends/restarts; mixed equity/options; correct
lot/product/expiry; partial fills; cancellations; conversions; auth outages;
DAY renewal; gaps; missing data; duplicate import/fill/exit; closing and detach.
Verify 10L/8L/2L accounting, settled/unsettled profits, losses, reservations,
withdrawals, partial/full corrections, sibling notices, unchanged quantities,
capital/guardrail reset and preserved intraday history. Synthetic automation places
no live orders. Record commands/results and failures; live-broker and native Windows
acceptance are post-preprod deployment gates, not blockers to code review.

## Implementation checkpoint — 2026-10-11

Historical checkpoint; superseded by the current review status above.

Work remains on `feature/phase21-swing-trading`, based on preprod. This is a
partial implementation checkpoint, not completion or live-trading acceptance.

Implemented:

- Official 100-stock snapshot in `backend/app/resources/nifty100.json`, including
  ISIN and provider aliases. All 100 matched the ICICI public master by ISIN and
  EQ series; 91 have derivatives metadata in that snapshot. Existing cache keys
  remain canonical. Website and desktop now share grouped searchable symbols.
- Fractional strikes survive schemas, history/cache keys, exact broker master
  matching, database storage and the desktop native historical request. Integer
  contracts retain their existing key format.
- Persistent account funding rules and a versioned, idempotent funding store.
  These are not yet connected to live account reconciliation or intraday starts.
- Persistent Paper portfolio parent, owned symbol/instrument children, one active
  portfolio per user/mode, independent multi-day cash and full equity funding.
  Intraday discovery/accounting no longer adopts Swing children.
- Current-quote Paper execution, shared portfolio P&L/loss limits, entry pause,
  capital/guardrail-period reset, explicit order cancellation and confirmed close.
  Closing waits for quotes; detaching the client leaves the backend running.
- Backend startup restores active Paper contexts and pending orders. Recorded
  cash settlements/fills repair missing trade records idempotently after a crash;
  this does not infer unrecorded offline market executions.
- Stop-limit exits wait for an executable price after triggering. Overlapping
  exits cannot create short positions. Paper expiry quotes close the exact option
  context without flattening unrelated shares. Legacy intraday controls are fenced
  from stopping or directly trading a portfolio child.
- Website Swing view and desktop Paper Swing view share basic controls/positions/
  pending orders. Desktop uses its existing authenticated native request transport.
  These views currently reconcile snapshots every two seconds; this is not yet
  the shared streaming chart/linked-screen experience planned in Sprint 5.

Remaining implementation, in dependency order:

1. Complete the remaining Paper integration edges: expired contracts without an
   executable quote, amendment/partial-fill crash boundaries, delivery-charge
   estimates, last-known mark presentation and strategy controls. DAY windows,
   broker-like recovery, online renewal and missing-history status are now
   implemented, with the verification described below.
2. Connect account funding cohorts/participants to intraday and Swing lifecycle,
   coherent live broker reports, commitments/settlement and both entry barriers.
   Add correction preview/audit and one shared warning with sibling notices.
3. Implement explicit opening inventory imports and delivery/overnight execution
   for Kite and Kotak. Product binding is implemented; public Real activation
   waits for account funding and reconciliation wiring. Add carry/T1/holding reconciliation,
   persistent multi-day broker execution journal, DAY renewal and unknown-ACK
   handling. Real expiry remains manual.
4. Complete contract metadata/lot selection, trade/history and wallet details,
   streaming chart attachment, strategies, linked portfolio views and screen
   detach across both clients. The basic form is not the finished trading UI.
5. Add the shared multi-day Replay clock/calendar, recovery/expiry parity and
   linked-screen validation, then review the complete change and raise PRs to
   preprod. Backend deployment and native/live acceptance follow preprod merge.

Verification so far:

- Full backend checkpoint: **2,016 passed, four failed**. The four match the
  recorded local ICICI/configuration failures: two options-start validation tests
  return 503 instead of 400, and two pattern-logger OHLC tests return 500 instead
  of 200/404. New execution-scope compatibility regressions were corrected;
  the focused execution/API rerun passed **59 tests**. Subsequent control fences
  passed **45 focused tests**; full-suite counts precede those final fences.
- Desktop unit suite: **184 passed**. Website and desktop TypeScript checks and
  production builds passed; builds retain the existing large-chunk warnings.
- Built desktop synthetic Swing browser check passed start, full-value reservation,
  cancellation refund, pause, selected capital reset, detach/reconnect and explicit
  close confirmation, with no browser errors. It submits no live orders.
- Earlier catalogue/fractional checks and native replay acceptance passed, including
  legacy cache identity, provider option identity and linked replay drawing changes.
- Read-only provider probe: public ICICI mappings verified for all 100; local
  Kite/Kotak authenticated probes remain **unverified** because this environment
  lacks the corresponding usable configuration. Mapping success is not evidence
  of second-level historical coverage.

Ignored logs/screenshots are under `.cache/phase21-swing/`. Keep these remaining
items visible when preparing the preprod PR; do not mark the whole plan complete
based on the foundational tests or basic Paper screen.

### Recovery and funding follow-up checkpoint

Historical checkpoint; superseded by the current review status above.

The Paper runtime now persists broker-like exit DAY windows and renewed attempts.
Recovery processes native observed seconds inside those windows; no orders are
renewed during offline days. Limit/SL edits retain the original attempt terms for
historical evaluation. Local entry intentions and application strategies are not
replayed. Missing provenance or coverage produces reconciliation pending, including
an entry barrier and a client notice. History downloads run off the event loop.
Fresh Breeze cache downloads record observation masks and actual source cadence;
expanded minute data cannot masquerade as native seconds.

Swing option selection now uses public master contracts with expiry-specific lots,
including fractional strikes. Existing registered contracts retain their metadata
across recovery. Invalid new contracts fail before a child context is persisted.
The built desktop check also passed listed options, lot steps and fractional order
identity. Zero/nonfinite quotes cannot create a fictitious free position. Recorded
Paper fees are rounded to the same precision as actual Paper-wallet debits.

Funding rules additionally distinguish local reservation ownership from broker
reservations. Promoting the same reservation does not charge it twice; confirming
a fill consumes it once. Opening inventory reallocates the selected mode's existing
budget toward owned assets while leaving account cash unchanged. It never fabricates
an old execution or sends a second cash debit. The explicit import adds recognised
asset principal to the account's acknowledged capital capacity, without changing
any mode's existing capital reference. Profit acknowledgements consume available
surplus so the same gains are not counted twice across modes.

A **capital-reference reset** changes sizing and the guardrail epoch while preserving
cash, commitments and funding differences. A **funding-allocation edit** redistributes
attributed budget and previews that change. A **funding correction** acknowledges a
cash difference for the selected mode. These are separate operations; reducing a
reference after a recorded loss must not subtract that loss from cash again.

Closed intraday participation retains its running effects and reference while Swing
remains active. When both modes close, the funding period is archived and the next
period captures a fresh starting reference. Archive evidence also permits recovery
if the process stops between period closure and account-owner release.

Superseded policy: Real ownership is per broker/account/style, not per account
operator. One Day book and one Swing book may have different application owners.
A user may occupy all four Kite/Kotak Day/Swing combinations. Each account still
has one shared funding pool with at most two mode allocations.

Kite/Kotak adapters now accept explicit CNC/NRML products while preserving MIS
placement defaults. Delivery/overnight views bind products without mutating the
shared connection. Report caches separate these product scopes and invalidate
sibling scopes for the same account. Swing submission intentions are durable for
both broker types and preserve unknown acknowledgements instead of resending.
These adapters are **not yet activated by a public Real Swing endpoint**.

Provider interpretation notes for Real integration:

- [Kite order products](https://kite.trade/docs/connect/v3/orders/) and the
  [Kotak SDK](https://github.com/Kotak-Neo/kotak-neo-api-v2) establish CNC for
  delivery shares and NRML for overnight options. Product binding belongs to each
  execution book rather than mutable broker-wide settings.
- [Kite holdings/positions](https://kite.trade/docs/connect/v3/portfolio/) and
  [the provider's worked quantity example](https://kite.trade/forum/discussion/comment/52974/)
  show that sold holding quantities are already reduced. Do not subtract
  `used_quantity` or a negative CNC day position from those holdings again.
  T1 and same-day buying/selling require explicit deduplication, not blindly adding
  every holdings and positions quantity.
- Delivery sale depository authorisation, settlement/charges and corporate-action
  discrepancies need broker evidence and a clear unresolved/manual-intervention
  state. Missing evidence must not create synthetic fills or portfolio closure.
  [NSE levies](https://www.nseindia.com/static/invest/first-time-investor-sebi-turnover-fees-stt-other-levies)
  and [broker tariffs](https://zerodha.com/charges) are reference sources for charge
  validation; estimates alone cannot prove an outside funding withdrawal.

Additional verification: **166** recovery/provenance/history-loader tests, **115**
provider/history regression tests, **132** broker product and existing execution
checks, and the funding/ownership focused tests passed. Full backend after the
Paper recovery/provenance work: **2,027 passed, four known configuration failures**.
That full run precedes the final exact-contract and funding-helper additions; those
have focused checks and still require the next integration run. Logs remain under
`.cache/phase21-swing/`. All previous remaining Real, linked-UI and Replay work stays
open; this follow-up does not mark the phase complete.

Latest integrated checkpoint: **2,046 backend tests passed; the same four local
configuration failures remain**. The account-owner/funding lifecycle focused run
also passed **20 tests**, and the updated built-client Swing browser check passed
fractional listed contracts and expiry-specific lot steps. Real activation remains
pending; these results validate the helpers and existing behavior, not live trading.


## Real ownership and outage recovery revision — 2026-10-11 (Sprint 0)

### Decisions and scope

Real only: one occupied slot per authenticated broker account and style (intraday
or Swing), across all application users. Day and Swing may have different owners.
One user may run all four Kite Day/Kite Swing/Kotak Day/Kotak Swing combinations;
there is no two-session user cap. Screens attach to a book and consume no slot.
Paper/Replay keep existing lifecycle and ownership rules.

Broker settings select the default for new sessions. Running books retain their
broker/account. Flexible capital shares sum to at most the acknowledged account
reference: 30/70 is allowed; 100/0 blocks funding a second style until an explicit
allocation reduction. No automatic sibling resize or duplicate per-user pool.
Separate personal broker credentials and extra brokers remain excluded.

### Sprint 1: durable slots and recovery

Use WalletLedgers conditional writes/transactions and existing short engine leases,
without a new lock manager. Persist book identity before broker writes. Slot rows
carry broker/account/style, owner, identity, lifecycle and engine operation token;
active discovery reads the four canonical broker/style rows, without a separate user counter. Expired leases permit only the same book's
recovery, not another user or session's takeover.

Pause, screen detach, logout, server restart and absent runtime objects retain
logical ownership. Startup adopts legacy active books and restores outstanding
slots. Conflicts/missing records/account changes remain recovery-required. Retry
transient authentication/report/storage failures without discarding obligations.
Reconcile actual orders/fills/positions/funding before permitting new entries;
never resend lost-ACK orders blindly or manufacture historical fills. Previously
running books resume after successful reconciliation; saved pauses remain paused.
Previous-day Day books must reconcile/close before replacement. Swing persists.

Persist closing intent before mutations. Restart continues the already requested
close. Confirm only the selected book's exposure is resolved, commitments released
and unknown submissions reconciled, then atomically persist final session/funding
participant state and free the slot. No age-based cleanup or blind force unlock.
Stale engines are fenced from broker actions and authoritative session writes.

### Sprint 2: account pool and Real execution

Move funding keys to broker/account scope, with owner and identity per mode.
Capture reference once; retain closed Day effects while Swing remains active.
Validate allocations and commitments atomically; selected-owner corrections keep
sibling references/history unchanged. Confirmed account shortfall blocks entries
in both modes, never exit/protection/cancellation. Incomplete reports are pending.
Integrate Real Swing adapters/runtime/recovery and route MIS versus CNC/NRML by
account/product/app-owned order identity, including same-symbol contexts.

### Sprint 3: client flows and acceptance

Return active Real session lists, selected account style availability and recovery
status. Accept optional explicit broker on starts; preserve default fallback.
Website/desktop show broker/style book selection, occupancy, shared funds versus
selected capital, and reconnect/reconcile/closing/recovery-required status. Users
can attach/retry/confirm close; private sibling trading history stays owner-only.
During backend downtime app-managed actions cannot execute; broker-held orders
may continue. Linked screens do not create extra ownership or funding allocations.

Test all allowed pairs/all four combinations, forbidden duplicate slots across
users, racing starts/allocations, retries/attaches, pause/detach and lease takeover.
Inject failure before/after durable creation, broker submission/ACK/fill, closing
intent and final release. Verify stale engines, overnight/weekend recovery,
previous-day exposure, external closes, missing reports and credential changes.
Verify shared 30/70 and 100/0 funding, losses/fees/reservations/corrections, independent
broker pools, legacy adoption, authorization and unchanged practice modes.

Changes remain on feature/phase21-swing-trading, based on preprod. All PRs target
preprod; backend deployment/native/live acceptance follow merging there, with
manual main/dev promotion afterward. Implementation results and remaining work
must be recorded below; storage helpers alone do not make Real Swing test-ready.

Slot storage uses four canonical broker/style keys, with immutable account identity
while occupied. A conditional sibling check prevents credential changes from
starting the other style on a different account. Separate personal broker accounts
remain deferred. Account funding/history keys retain the actual account identity.


### Recovery decision: verified closure and older history

Allow a previous-day Real book to close once successful, scoped broker reports
confirm zero current exposure and no pending orders, even when local older
operations remain unresolved. Persist a history warning before releasing ownership;
preserve archived trades and omit a newly calculated closure P&L. Missing reports
or any current exposure/pending order still prevent closure. This is a closure
exception only: it does not authorize entry, recovery resend, or fabricated fills.

Kite per-order `order_history(order_id)` / `order_trades(order_id)` fallbacks are
deferred by user agreement to keep this implementation simple. These endpoints
must not be assumed to recover older outages.


## Implementation checkpoint — ownership/recovery revision, 2026-10-11

Historical checkpoint; superseded by the current review status above.

This checkpoint supersedes earlier notes saying shared funding and Real Swing
runtime were unwired. Work remains on `feature/phase21-swing-trading`, based on
preprod. No main/dev merge or live order was performed.

### Implemented scope

- Four canonical broker/style ownership rows, shared across users. Each actual
  broker account is pinned while either style is occupied. Users can own all four
  allowed broker/style combinations; practice modes keep their previous rules.
- Durable preparation, conditional claims, renewable existing engine leases and
  session/funding/slot completion transactions. Outages retain ownership. Missing
  account identity and conflicting legacy books stay explicitly recoverable.
- Shared account funding, separate owner/mode references and reservations,
  explicit allocation edits and account-wide shortfall/pending entry barriers.
  Pure exits remain available. Real equity Day reservations use the configured
  MIS margin rate; Swing equity and long options use full purchase value.
- Real Swing start/attach, CNC/NRML execution, parent engine recovery, durable
  multi-day execution revisions and FIFO cost basis. Current reports cannot
  replace older confirmed fills. Delivery holdings/T1 and daily CNC changes are
  checked against the reconstructed quantity; NRML quantities remain separate
  from Day MIS. Account funds refresh preserves allocated session capital.
- Whole-context opening inventory preview/import at the broker's reported basis,
  before executions have started in that context and with no pending broker
  orders. Imports create opening lots, not invented trades or a second broker cash
  debit. Import/funding/metadata changes commit together and retries are checked.
- Explicit online renewal of remaining long protection only after a terminal
  broker report identifies the previous DAY attempt as expired. No offline
  renewal, quantity scaling, unknown-ACK resend or inference from a missing order
  report. Ambiguous older attempts keep entries blocked for user reconciliation.
- Website and desktop share Paper/Real portfolio controls, broker selection,
  allocation editing, entry pause/resume, detach, capital/guardrail reset,
  import confirmation, cash correction preview and verified closure controls.
  Changing views/closing the client does not close the backend portfolio.
- Reconciliation reads authoritative broker reports. Unknown statuses and missing
  quantities prevent flat verification. Older unavailable history can remain
  warned while verified-flat closure releases ownership. Current unknown
  submissions continue to block Swing closure. Archived warnings remain visible.

### Funding and reconciliation decisions

The first cash capture remains immutable audit evidence. Allocation percentages
use the currently acknowledged account reference; that reference can include
explicitly imported opening assets. Import adds only the importing mode's asset
allocation/basis; the sibling's amount is unchanged. References do not grow from
profits automatically. A sizing-capital reset changes the selected loss-limit
period without changing funding allocations or erasing a cash discrepancy.

The current cash correction UI acknowledges a confirmed **negative** cash
shortfall with a reason, a preview and an explicit confirmation. It can cover part
or all of the gap against free owned Swing funding. The selected allocation and
reference fall by that acknowledged amount, and its loss-limit reference resets.
The sibling's allocation and historical trades remain intact; any remaining gap
blocks new entries in both styles. Missing historical P&L cannot be repaired by
entering a cash correction. Positive external deposits/extra account-reference
increases need a separate explicit acknowledgement flow and remain left out.

For older missing executions, users can reconcile current exposure, close it at
the broker if necessary, verify flat, and close the managed book with its history
warning intact. A new book may then explicitly import current opening inventory.
There is no arbitrary historical fill editor. Kite per-order history/trade fallback
remains deferred by user agreement.

### Verification and items still left out

Focused automated checks cover multi-day buy/holdings/restart, duplicate and
partial execution reports, history gaps retaining the previous revision, parent
lease rotation, stale session/funding writers, atomic imports, no fake import
trades/cash debit, reservation budgets, partial cash correction, evidenced DAY
protection renewal and verified-flat closure with a retained history warning.

Website and desktop TypeScript/production builds passed. Desktop unit tests:
184 passed. Browser checks with mocked broker responses passed for Real mode,
import preview/confirmation and broker reconciliation/verified-close confirmation,
with no browser errors. This verifies controls, not authenticated broker execution.
Final backend verification: **2,094 passed, four pre-existing local ICICI
configuration failures** (missing `[icicidirect]` in local `data/accesskeys.ini`):
two options-start validation tests and two pattern-logger OHLC tests. No new
backend failures. Final website/desktop TypeScript and production builds passed;
desktop unit tests passed again (184). New service modules passed Ruff and
`git diff --check` passed. Mock browser checks are described above; no live orders
were sent.

Authenticated Kite/Kotak holdings, partial fills, authorization/refusal, overnight
DAY expiry and native desktop execution still require preprod deployment and
user acceptance. Delivery charges use the existing application estimates, not a
new contract-note accounting engine. Settlement/physical stock-option obligations
and Real expiry exits remain manual, as previously agreed. Corporate actions,
expired holdings with unavailable metadata and ambiguous historical attempts can
require broker intervention; no fictitious exit or P&L is recorded.

Broader original Phase 21 work still includes linked Swing chart/strategy/history
views (Sprint 5), multi-day Replay (Sprint 6), remaining Paper edge coverage and
preprod/live/native acceptance (Sprint 7). This ownership/recovery revision does
not claim completion of those broader sprints.


Additional implementation review: funded entry checks read current broker `Net`
funds once per one-second submission burst, so an outside withdrawal cannot rely
on an indefinitely stale UI snapshot. Known Day ACK/fill effects schedule a
bounded reconciliation using existing reports; Swing uses its persistent engine.
Unknown ACKs retain their pending order and reservation, including resting exits.
Closed books cannot refresh a newer owner's broker book. Empty Swing portfolios
can reconcile funding and edit allocations before attaching their first context.
Mixed holdings/day buy-sell imports verify remaining opening basis from confirmed
execution evidence rather than applying the old holding average to new purchases.

A new Real funding capture currently requires positive available cash. Starting a
new holding-only portfolio from a zero-cash account, positive funding/deposit
acknowledgements and arbitrary historical fill editing remain left out. Existing
books retain their reconciliation/closure controls if cash falls to zero.

### Final recovery review

Closure verification uses thin current order/position reports, read in that
order, without requiring old trade reports or metadata for flat expired
contracts. Missing product identity, malformed quantities and unfamiliar pending
statuses remain unresolved. Current-day Day closure can use this proof after a
history refresh failure only when no current submission is unresolved; its
history warning persists. Kite per-order history remains deferred.

Day and Swing recovery mark shared funding pending before restoring an engine.
Swing lease renewal runs independently of reconciliation, so slow broker reports
do not release a book or authorize another owner. Opening inventory records its
capture boundary so earlier same-day executions are not added twice. Closed
roots are explicitly marked verified closed and cannot be adopted as legacy
active books after restart.

Deployment order: merge the reviewed feature branch into **preprod**, deploy the
backend, then run authenticated website/native acceptance. All further PRs for
this work target preprod; main/dev promotion remains manual after acceptance.


## Code review and fix checkpoint — 2026-10-11

### Findings and final design

| Finding | Fix and expected behavior |
| --- | --- |
| Startup adopts a Swing child as a competing owner | Adopt roots only. Children belong to their recorded parent; missing/mismatched parents remain blocked. Closed roots cannot be revived by their child rows. Genuine root conflicts remain visible. |
| Reconciliation/closure runs before child restoration | Renew the lease during restoration, but keep execution unready until every registered child is restored. Missing children cannot become an empty portfolio or verified closure. Concurrent attach/recovery returns a retryable response. Unrestored P&L stays pending; closed archives do not read newer funding pools. |
| Startup fails between parent creation and allocation save | Parent/slot creation saves allocation instructions and the prepared funding period atomically. Retry completes enrollment for the same identity. Old empty incomplete starts recover their exact saved capital against the current account pool when it fits; ambiguous or conflicting funding remains blocked. Invalid retained-mode allocation changes are rejected before claiming another slot. |
| Reconciliation overwrites a concurrent allocation/correction | Recompute the target and fingerprint from the current participant baseline on each conditional-write retry. |
| A partial-fill report retains the original reservation | Rebuild funded Real reservations from confirmed held quantity and remaining opening units. MIS equity uses the existing 20% estimate; Swing uses full value. Terminal orders release residual reservations. No duplicate investment debit. |
| Pending shared funding accepts new reservations | Risk-increasing local reservations check the shared entry barrier in the same funding mutation. Reductions, releases and recording confirmed broker effects remain possible. Actual submissions/edits use the style-specific entry guard. |
| Old intention dates conceal current unknown attempts | Persist actual broker submission time separately before placement. Current-day uncertainty blocks closure regardless of original intention age or acknowledgement. Day closure retries report reconciliation without resubmitting the order. Recheck uncertainty after broker verification. |
| Empty cash-correction confirmation assumes a child exists | Use the parent funding actor through preview/confirmation and preserve retry receipts. Attached children receive the corrected sizing capital. |

Confirmed fills, refusals, cancellations and verified closure refresh existing
funding/reconciliation machinery. They do not create a new monitor or lock manager.
An incomplete funding write keeps entries pending rather than treating its old
snapshot as authoritative.

### Explicit undated-attempt decision

The user selected **allow acknowledged verified close** for existing undated
unknown attempts. Reconciliation exposes exact undated order identities. Website
and desktop confirmation explicitly acknowledge those identities; the backend
checks they belong to the selected book and persists the acknowledgement. It
then verifies current scope flat with no pending orders before releasing the slot.
History/P&L warnings remain; acknowledgement never creates a fill or authorizes a
retry. Known current-day attempts cannot be acknowledged past this barrier.

Close endpoints accept an optional JSON body:

```json
{ "acknowledge_undated_submission_ids": ["owned-order-id"] }
```

Existing no-body close requests remain compatible. Reconciliation and Real Swing
snapshots additionally return `current_submission_ids`,
`undated_submission_ids`, `older_submission_ids` and `closure_blocked`. Orders
persist optional `broker_submission_at` as actual UTC milliseconds; `created_at`
keeps the existing IST-wall-clock convention. Missing old submission timestamps
remain undated rather than being guessed from intention creation.

### Assumptions, limits and rollout

One centrally configured account per broker remains assumed. Account/product,
portfolio identity and current engine ownership stay pinned. A short engine lease
is execution authority, not permission to abandon money or release a book. Outside
broker mutations can occur between reads; the application verifies its managed
scope and preserves uncertainty instead of claiming an atomic broker snapshot.

The 20% MIS margin and existing charge estimates remain application affordability
estimates; actual broker authorization/funds/rejection are authoritative. No
broker-specific margin calculator, contract-note accounting, new distributed locks,
arbitrary fill editor, corporate-action engine or force-unlock endpoint is added.
Kite per-order history remains deferred. Positive funding acknowledgement,
zero-cash initial capture, linked Swing chart/strategy/history views, multi-day
Replay and remaining Paper acceptance work are still excluded from this fix pass.

Merge the reviewed branch into **preprod**, deploy the backend, then test
actual Kite/Kotak and website/native desktop execution. Native executable and live
broker acceptance cannot be replaced by TypeScript builds or mocked browser tests.
No live orders were sent during this review/fix work.

### Verification of this revision

Permanent regressions cover the eight findings plus genuine/missing-parent
conflicts, closed-parent restart, missing children, legacy incomplete start,
acknowledged versus current submissions, uncertainty arriving during verification,
endpoint body forwarding, empty correction retries, pending reservation decreases
and partial Day reversal margin. The final results below distinguish repository-wide verification from focused regression and mocked browser checks.


Final verification of the reviewed code:

- **Backend: 2,121 passed, four pre-existing local ICICI configuration failures**
  (missing `[icicidirect]` in local `data/accesskeys.ini`): two options-start
  validation tests and two pattern-logger OHLC tests. No new suite failures.
- **27 new regression cases** cover this review and its follow-up boundaries.
  Compatibility checks also passed for splits, legacy strategy edits, Day/Swing
  lifecycle, funding and desktop routes.
- **Desktop: 184 tests passed.** Website and desktop TypeScript checks and
  production builds passed; existing large-chunk build notices remain.
- Mock browser verification passed for both Day and Swing undated-attempt
  acknowledgement: the submitted IDs matched the confirmation, the Day confirm
  required acknowledgement, and no page errors occurred. This tests controls,
  not authenticated broker behavior or a rebuilt native executable.
- Python compilation, Ruff on the reviewed core services/new regression module,
  and `git diff --check` passed. Temporary UI harness files were removed.

Review fixes are implemented; authenticated preprod deployment/native/live
acceptance and the broader outstanding Phase 21 sprints remain pending.

## Swing chart improvements — 2026-10-12

See the separate [improvements sprint plan](spec-phase21-swing-improvements-plan.md).
This delivers chart workspaces and continuous active-book pricing; external
linked Swing windows and multi-day Replay remain deferred. Existing ownership,
funding and execution-history decisions stay authoritative.


### Swing Improvements delivery — 2026-10-12

The separate [Swing Improvements implementation checkpoint](spec-phase21-swing-improvements-plan.md#implementation-checkpoint--2026-10-12)
records the implemented chart workspace, full-session pricing/restart behavior,
review fixes and automated checks. Original funding/ownership/recovery rules remain
in force. Preprod broker/Windows acceptance remains pending deployment.

### Linked windows and analytics extension — 2026-10-12

[The approved implementation plan](spec-phase21-swing-linked-analytics-plan.md)
supersedes earlier linked-chart/history pending entries. Multi-day Replay and
new strategy controls remain deferred.
