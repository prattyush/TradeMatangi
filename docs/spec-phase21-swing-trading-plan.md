# Phase 21 — Nifty 100 and Swing Trading

Approved design, 2026-10-10. Work branches originate from preprod and all PRs
are reviewed into preprod. Deployment/runtime acceptance follows preprod merge;
main/dev promotion remains manual. This document is Sprint 0 and precedes code.

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
a shared user/broker/account funding record, not duplicate alarms in each session.
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
| 3 | Shared Real funding, imports and manual correction | Funding rules/store tested; broker integration pending |
| 4 | Kite/Kotak delivery execution, renewal and recovery parity | Pending |
| 5 | Portfolio UI, linked views and funding notifications | Basic Paper controls in both clients; linked views pending |
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

1. Finish Paper order ownership and durable DAY-attempt windows, available-history
   recovery restricted to broker-like exits, online-only renewals, missing-history
   reconciliation status and expired-contract recovery. Test sparse/non-observed
   history, stop-limit gaps, crash boundaries and strategy ownership. Validate
   delivery-specific Paper charges and original/last-known mark presentation.
2. Connect account funding cohorts/participants to intraday and Swing lifecycle,
   coherent live broker reports, commitments/settlement and both entry barriers.
   Add correction preview/audit and one shared warning with sibling notices.
3. Implement explicit opening inventory imports and delivery/overnight execution
   for Kite and Kotak. Existing MIS adapters are not suitable for Swing and are
   not exposed through this new Paper API. Add carry/T1/holding reconciliation,
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
