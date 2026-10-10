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
| 1 | Catalogue, mappings, search and read-only provider probes | Pending |
| 2 | Persistent Paper portfolio, contexts, accounting and controls | Pending |
| 3 | Shared Real funding, imports and manual correction | Pending |
| 4 | Kite/Kotak delivery execution, renewal and recovery parity | Pending |
| 5 | Portfolio UI, linked views and funding notifications | Pending |
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
