# Kotak cancelled-exit recovery

This feature runs in active **Kotak real-trading sessions** using MIS orders,
including NIFTY and SENSEX options. Paper/replay sessions and other brokers are
unchanged. It addresses missing exit coverage after a cancellation; it does not
establish that Kotak or a particular SDK caused the cancellation.

## Recovery policy

### Live settings switch

Website and desktop Trading settings share **Automatic Kotak SL placement and
cancelled-exit recovery**, saved to backend UserSettings as
`kotak_automated_protection_enabled` (default True). Uncheck it during trading
to stop new automatic entry SLs, manager audits and cancellation replacements.
Changes apply after the backend confirms the save; no session restart is needed.
Trade History Refresh reads the persisted flag and does not restart disabled
automation. It can still reconcile an already-sent uncertain order without
placing a replacement. Manual orders/SLs, existing broker orders and explicit
strategies continue; paper/replay protection is unchanged. Already-dispatched SDK
requests may finish. Re-enable and/or refresh to resume checks.

### Entries placed with an attached stop-loss

Kotak real-options entries with an attached SL or AutoStop protection now use
an event-driven account coordinator. It reconciles confirmed executions, orders
and positions, allocates remaining exits once to FIFO entry groups, and repairs
only missing coverage belonging to protected entries. A 40-unit entry and a
20-unit entry cannot subtract each other's SL quantities. Partial fills require
protection only for confirmed remaining quantities. Independent allocated
target/limit exits and manually added SLs count as coverage.

Fill events use the configured entry delay (default three seconds). Cancellations
use 750 ms and qualify regardless of origin when protected entry intent is known.
Refresh, reattachment and broker reconnection also trigger an audit. Explicit
TradeMatangi cancellations/reductions and intentional conversions are respected;
exclusions and allocation links are durable across splits and refreshes. FIFO
closure consumes exclusions instead of disabling unrelated future protection.
Orders lacking recoverable entry intent retain the legacy incident policy below.

There is no periodic polling. Requests share one account report task and queue one
continuation per affected session. Background report bundles start no more often
than every two seconds, with shared 2/5/10-second failure backoff and any longer
broker retry delay. Accounting reads request only executions and positions; a
fresh shared bundle can be completed with just the missing order report. Explicit
refresh clicks join in-flight requests. These are application limits, not Kotak
quota claims. Manual trading takes precedence over queued repair; SDK requests
already in progress cannot be preempted. Background reads run outside the
foreground mutation barrier, and automatic submissions serialize per account.
Independent groups in a fill burst submit from one validated snapshot, reserving
acknowledged quantities until a shared verification pass. A new fill or foreground
edit invalidates the batch before another submission.
Normal audits verify against the confirmed in-memory FIFO ledger without rewriting
the day's trade history. Missing or changed executions trigger the heavier
reconciliation using the same reports. Slow background staging leaves manual
actions available and is discarded if trading changes before publication.
Repeated disagreements use the coalesced account queue with 2/5/10-second spacing.
Trade History Refresh remains the explicit heavier reconciliation action; neither
idle watching nor quote ticks cause periodic audits.

Repair reuses the durable claims/tags, uncertainty reconciliation and bounded
submission policy. The entry coordinator verifies accepted orders in its next
shared report pass, outside the manual-edit lock. Saved timeout-fallback positions
can reopen charts but cannot authorize repair orders. Kite execution, paper,
replay and desktop live browsing do not use this coordinator.

### Legacy cancellation incidents

After an app-managed exit cancellation, the backend coalesces events for 750 ms
and audits broker orders and positions. An unknown-origin cancellation, including
reason `--`, is eligible when an exit fill for that session's underlying occurred
within 30 seconds before or after it. An explicit broker/RMS/exchange/system
`cancelInitiator` field also qualifies. A matching TradeMatangi user cancellation
request suppresses replacement. Intentional conversion/flattening is respected;
quantity resizing is checked against the resulting coverage. Each request has its
own durable record, and user intent is tracked separately so a late system
acknowledgement cannot overwrite it.

A manual cancellation made directly in Kotak during the correlation window can
be recreated: those events cannot reliably be distinguished from unsolicited
broker cancellations. That is the selected pilot policy. The logs record the
evidence instead of declaring every unmatched cancellation to be broker-origin.

For the uncovered quantity lost through that cancellation:

- Restore the last broker-confirmed SL trigger if it remains below fresh LTP for
  a long position, or above it for a short position.
- Otherwise use **current contract LTP** and `default_sl_pct` (default `0.20`). A
  long option at ₹50 gets a ₹40 trigger; a short position gets ₹60. This fallback
  can widen the old stop and does not submit an immediate market exit.
- Generate the SL limit using `stoploss_limit_gap_pct` (default `0.015`), separately
  from the 20% trigger distance. A ₹40 sell trigger gives a ₹39.40 limit.
- Respect tick size, whole lots and freeze sizing. Do not round quantity upward.

Coverage is calculated from **unfilled** exit quantities, with exact account,
exchange, product, underlying, strike, expiry and right matching. External broker
exits contribute to coverage, but externally created orders are not taken over.
Existing independent target/limit exits count as exit coverage; this is not a
new full-position SL plus target/OCO implementation.

Repair is capped to the quantity lost through this cancellation, including
broker-side quantity edits and partial fills. Repeated audits do not silently
restore unrelated gaps left by previous manual cancellations. Those gaps produce
`needs_attention` instead. Closed or reversed original position cycles are not
re-protected.

## Concurrency and failure handling

The coordinator serializes with manual order placement/edit/conversion/cancel,
entry protection, strategies and allocated-exit resizing. It checks fresh state
immediately before submission and verifies the resulting broker-book coverage.
The fill callback now updates the broker position cache before exit reconciliation;
the resizer also uses remaining rather than original order quantities.

Submission intents and acknowledged IDs are durable. Freeze-sized chunks have
conditional claims and deterministic IDs/tags. Up to three submission rounds are
allowed per incident, including cancellations/rejections of replacement orders.
A confirmed negative broker response permits a bounded retry; a timeout, server
5xx response or malformed acknowledgement requires reconciliation by tag or broker
ID first. The v3 SDK can return an exception object in an `Error` dictionary; that
is treated as transport uncertainty, not an exchange rejection.
The v3 tag aliases include `GuiOrdId`. A missing/changed tracking tag without a
known broker ID can leave acknowledgement unresolved; no blind duplicate is sent.

Unconfirmed recovery orders reserve their quantity, are excluded from local tick
execution, and cannot be edited/converted/cancelled until reconciled. Broker
snapshots received during submission are handled without duplicate runtime orders
or losing callback identity. Cancellations arriving during an active recovery are
queued for a continuation using the latest cancelled order's price.

Quotes must be no older than five seconds and come from the live market-data
layer. A temporary subscription can obtain a quote for an older strike. Historical
candles cannot supply recovery prices. Invalid quotes, report inconsistencies,
unsupported products, closed markets, expired sessions and uncertain submissions
produce a visible warning. Automatic verification runs for at most 30 seconds per
continuation; unresolved durable jobs can resume after refresh or reattachment.

If an uncertain replacement has already filled but its executions have not been
applied locally, recovery requests a broker refresh rather than inventing fills.
An unverified quantity or missing broker side also blocks submission.

## Logs and UI

`LOG_DIR/kotak-cancellations.ndjson` captures every cancellation/cancel-pending
frame at the SDK `on_raw` hook before typed-model conversion and terminal-event
deduplication. Parsed cancellation rows are also recorded with `stage=parsed`, and cancelled
order-report rows with `stage=report`.
Daily rotation retains 30 days. Authentication frames are excluded; credential
fields are redacted, including nested legacy JSON. Broker fields and unknown
extras are retained, so the original reason and any aliases can be inspected.

Normal backend logs include:

- `broker_cancel_requested`, `broker_cancel_acknowledged`, `broker_cancel_failed`:
  request ID, broker order ID, user/system actor and purpose.
- `protection_fill_committed`: delta quantity and position before/after the fill.
- `protection_cancel_matched`: cancellation matched to an application request.
- `protection_coverage`, `protection_submit`, `protection_recovery`: coverage,
  pricing source, quantities, operation/tag IDs, decisions and failures.

The frontend shows pending/restored/needs-attention notices separately from other
broker errors. Notices are replaced per contract, removed on confirmed closure,
and cleared when switching sessions. Raw payloads are never streamed to the UI.

The reported `order_status` parsing error is fixed: malformed/duplicate/batched
rows cannot access an unassigned variable or discard subsequent valid rows.
Cancelled and rejected states use separate callbacks; partial fills are handled
before cancellation of the remainder. A placeholder reason does not hide a useful
secondary reason field.

## Deployment and validation

Deploy backend and frontend together. New order metadata is optional and existing
records remain readable. The durable journal uses the **BrokerProtectionRecovery**
DynamoDB table, with string partition key `id`, on-demand billing, and no sort key.
The service creates it lazily if permitted. The backend needs DescribeTable,
GetItem, PutItem and Scan access; CreateTable is needed only for automatic creation.
If the runtime role cannot create tables, provision this table before deployment.
Journal failures block untracked submissions/cancellations and surface errors;
they do not cause a silent duplicate placement.

No live orders were submitted during development. Mocked regression coverage
includes the supplied SENSEX sequence (₹32 restored for 80 remaining units), NIFTY
long/short positions, crossed-stop fallback, partial fills, separate contracts,
manual cancel intent, malformed/early/duplicate frames, raw redaction, timeout
reconciliation, freeze chunks, restart recovery, concurrent snapshots, and
protection-resizer races. This does not prove the original broker cause.

For the pilot, retain the cancellation log and backend log covering the exit fill,
cancel request (if any), raw cancellation, recovery decision and resulting broker
order. A `needs_attention` notice is not confirmation that a replacement exists;
check the broker order book and position before taking further action.


Validation results: 22 frontend Node tests passed, along with TypeScript and the
production build. The full backend run passed 1,601 tests with the same two known
baseline failures (`test_options_session_started_successfully` and
`test_active_session_returns_attach_metadata`). Subsequent cancellation-journal
changes were covered by the focused broker/recovery/API regressions.

## FIFO average entry and P&L repair

Trade History Refresh now reconstructs each contract's remaining lots from individual
confirmed Kotak executions in chronological order, using FIFO. For example, buying
65 at 40 and 65 at 60, then selling 65, leaves 65 with average entry 60. Cancellation
notifications do not consume lots or change the cost basis. Partial executions are
replayed individually, including execution timestamps below one second; duplicate
execution IDs cannot count twice.

The reconstruction must agree with broker net quantities for the same exchange,
product, option right, strike and expiry. If history and positions are still updating,
refresh retries once and then retains the previous verified state with an error.
Broker average entry remains diagnostic evidence; it does not override FIFO entry.
Remaining entry fees are allocated to the remaining lots. Both the chart and right
panel use that same position and estimated exit fees for net unrealized P&L; the
percentage remains relative to session capital. A missing quote for the exact
contract displays an unavailable P&L rather than another strike's price.

Confirmed live fills update the FIFO ledger after refresh, and persisted individual
executions reconstruct it on reattachment. Versioned position snapshots prevent an
older response from overwriting a newer fill. The cached position-snapshot endpoint
reads application state without polling broker reports on each event. An existing
open book without verified executions requires Trade History Refresh before its
FIFO basis can be repaired.

## Broker-confirmed conversion and position evidence

On website Stop/Start for the same underlying and trading day, real-options
sessions reconcile Kotak positions and orders before starting their live feed.
Each CE/PE chart selects the most recently opened position within the saved
session expiry (higher strike breaks timestamp ties). Flat sides keep the new
Start request's selection. Other open contracts remain tracked. This matches
paper resume selection; real Stop preserves broker stop-loss orders. If a report
times out, restart can use the saved snapshot only when it belongs to the same
broker account/day and its confirmed executions agree with its positions. A
visible warning explains that the saved book may have changed while stopped and
asks for Trade History Refresh. This fallback does not submit, modify or cancel
broker orders. Missing/unverified snapshots, account mismatches and other
reconciliation failures return a restart error and preserve durable trading state.

LIMIT ↔ STOPLOSS conversion now retains the broker-confirmed type until a matching
order event confirms type, prices and quantity. This applies to individual orders,
All SL and All Limit. Pending/unknown conversion metadata is durable; coherent
refresh and passive confirmation after restart do not resubmit the operation.
Explicit refusal can invoke confirmed cancel-and-replace. Conversion cancellation
intent suppresses independent protection recovery, and coverage is reconciled
before submitting the replacement. Confirmed cancellation removes the original
from open orders immediately; an unresolved replacement produces a visible notice.

Position-feed messages provide reconciliation evidence rather than trades. Matching
committed execution quantities require no report poll. Mismatches coalesce into a
coherent broker refresh, preserving individual execution deduplication and FIFO.
Raw order/position wire evidence is available in `LOG_DIR/kotak-events.ndjson`
(daily rotation, 30 backups, secrets redacted), alongside decoded DEBUG payloads and
INFO position summaries. See [Phase 19](spec-phase19.md) for requirements and validation.

## Scope discipline: per-order uncertainty must not become a session-wide block — 2026-10-23

A live incident (right-click to add a stoploss froze the website's chart for
several seconds, recurring; separately, an uncertain order on one contract was
blocking "A Real broker operation is unconfirmed; reconcile before submitting
new entries" for every other contract in the session) prompted a holistic
review of every "unconfirmed, retry later" gate in this file and its
neighbors (`order_split.py`, `broker_conversion.py`, `real_broker_state.py`,
`real_close.py`, `real_trading_day.py`).

**The underlying principle stays exactly as documented above**: never trust
an SDK acknowledgement as confirmation, never resubmit an order whose first
attempt is ambiguous. That's earned — it traces directly to the cancelled-
exit and SENSEX dual-entry incidents this document exists to describe, plus
the earlier silent-drop bugs in `docs/bugs.md`'s Real Trading Bugs section.
None of that changed.

**What changed is scope.** Every one of those single-order protections had
been generalized into a session-wide aggregation — `kotak_protection.busy
(session)` scanned every order's split/conversion state, `real_close.
unresolved(session)` did the same for `recovery_state`, and both fed into
blocking brand-new, unrelated entries and deferring the entry-protection
audit for the whole session. No incident on record (including the one real
concurrency bug, a duplicate AI-helper dispatch, fixed with a narrow atomic
claim rather than a session lock) ever required that blast radius.

- `kotak_protection.busy(session, contract=None)`: the session-wide flags
  (closing/manual-edit/split-in-progress/refresh) stay global — those
  genuinely mean the whole book is mid-mutation. The per-order split/
  conversion-ACTIVE scan is now scoped to `contract` (a `key(order)` tuple)
  when the caller is evaluating one specific entry; `audit()`'s per-entry
  loop passes the entry's own contract, so a stuck split on one strike no
  longer defers protection auditing for every other open position. The
  cheap pre-fetch gate (before any entry's contract is known) now checks
  only the global flags.
- `real_close.unresolved(session, contract=None)`: scoped the same way.
  `real_trading_day.require_entry_allowed` passes the new entry's own
  `(right, strike, expiry)`, so an uncertain order elsewhere no longer blocks
  it. Whole-book callers (Done-for-day, where "is the entire book resolved"
  is the actually correct question) omit `contract` and get the original,
  unscoped check.
- `real_broker_state.refresh()`'s barrier (`session.broker_refresh_events`)
  moved to open at the same point for both the manual and background
  protection paths — right before `stage()`/`commit()` — instead of the
  manual path opening it before the broker fetch even starts and holding it
  through the full fetch+build+verify pipeline (empirically "tens of seconds
  to ~2 minutes" per the original diagnostic commit that first streamed
  ticks around this barrier). The only thing this barrier genuinely has to
  protect — a fill/cancel/reject WebSocket callback racing the moment a
  refresh publishes new authoritative state — only matters in that brief
  stage+commit window; everything before it reads current, not-yet-stale
  state, so narrowing to match the already-proven-safe protection-path
  window doesn't weaken the protection, it just stops applying it where
  nothing needed it.
- `simulation.py`'s real-session tick handler streams chart ticks to the
  website unconditionally again; only order-triggering (which does depend
  on the in-flight rebuild) waits for the barrier to clear.

**Deferred, not fixed in this pass**: `broker_order_service.sync_order_edit()`
(used by the tick-driven automated strategy engine for BreakEven/
TargetProfit/trailing-stop) makes unwrapped synchronous Kotak SDK calls
directly on the shared asyncio event loop — a separate, likely larger
contributor to chart freezes during active automated trading, needing its
own async-ification design. `swing_real.refresh()` carries the same barrier-
window asymmetry as the intraday path (and for swing, in both modes); not
yet narrowed, since it wasn't today's active symptom.

## Manual broker-bound actions must wait through the barrier, not hard-fail — 2026-10-24

The scope-narrowed barrier above is still *correct* (it genuinely only
protects a brief commit window) but a follow-up design discussion narrowed
"broker is the only source of truth" to a precise, actionable line: creating
a new stoploss exit order, updating an open SL/LIMIT exit, converting an
exit between SL and LIMIT, cancelling an exit, and market orders for a new
position talk to Kotak immediately and must never be blocked by internal
state — including this barrier itself. LIMIT/TARGET orders for a *new*
position are watched/simulated locally before they ever reach the broker, so
software gating those remains correct.

Six call sites (`orders.py` place/cancel, `broker_order_service.
sync_order_edit_async`, `broker_conversion.start`, `trading.py`'s direct Buy/
Sell, `emergency_exit.exit_all`, `swing_order_actions.act`) still raised an
instant 409/502 the moment the barrier was open, with a "retry shortly"
message that was never actually true — neither the website nor desktop
client retries these calls; a click landing in that sub-second window simply
failed.

**Fix**: `real_broker_state.await_refresh_barrier(session, timeout=3.0)`
polls the local barrier flag (no broker calls, so it cannot interact with
Kotak's own rate limits) and lets the action through once it closes, raising
the original error only if it's still open after 3 seconds — far longer
than the barrier is ever open in practice, and short enough to be invisible
against normal multi-second manual reaction time. The six sites above now
wait via this helper, scoped by `_is_position_exit(session, order)` wherever
the same site also handles new-position orders. `swing_real.refresh()`'s
barrier was also narrowed to open only right before `commit()`, closing the
asymmetry flagged (but left unfixed) in the entry above.

**Deliberately left untouched**: `sync_order_edit()`'s synchronous twin
(`broker_order_service.py`, only reached via `strategy_service.py`'s
automated amendments running directly on the event loop) was not given the
same wait — a blocking wait there would freeze the whole backend for up to
3 seconds on every session, trading one bug for a worse one. Its callers are
background/automatic, not a manual click, so the "must never block" rule
doesn't apply to it the same way.

**Also evaluated, no fix** — the software-automated paths touching the same
order types (`entry_sl_watcher.py` auto-SL-on-fill, `futures_real.py`/
`swing_real.py` quote-driven protection renewal, `simulation.py`'s
tick-driven TARGET/LIMIT trigger detection) were all confirmed self-healing
or already surfaced via `protection_recovery`'s `needs_attention` path,
except one: a transient price crossing that lands on a tick where the
barrier happens to be open can be permanently, silently missed by
`simulation.py`'s level-check trigger logic (only a diagnostics counter, no
alert). Left unfixed on purpose — per the same design discussion, the fix
for an automation blind spot is an always-open manual path, not more
automated handling around it.
## "Broker is the only source of truth" — closing two whole-book failure gaps — 2026-10-24

The scope-discipline work above narrowed *who gets blocked* by an uncertain
order. A separate, deeper question — prompted directly by the user's stated
design principle for real trading ("the broker is the only source of truth;
this software is a book-maintainer at best; if its own internal state ever
stops a manual, broker-bound action from reaching Kotak, that is a critical
failure") — was *whether refresh itself can ever fail to reflect broker
truth at all*, for reasons that have nothing to do with any specific order
the user is trying to act on.

Three independent investigations, verifying the principle against the code
rather than assuming it held, found two concrete, reachable violations:

- **One unresolvable or disagreeing contract aborted the entire refresh.**
  `aggregate()`, `normalize_positions()`, and `build_orders()`
  (`real_broker_state.py`) called `reports.contract()` per row with no
  per-row isolation — one row's `UnknownContractError` (even after the
  PR #708 session-expiry fallback) propagated out of the whole function.
  `fifo_agrees()`/`quantities_agree()` had the identical all-or-nothing
  shape for a quantity disagreement on any single contract. Either way,
  `stage()`/`commit()` never ran — *no* strike's data published, not just
  the problematic one's. This directly contradicted "under any scenario,
  data not being synced is not possible": one broken contract anywhere in
  the book blocked the refresh for the specific order the user actually
  wanted resolved, too.
- **A reachable split-failure window left a permanent phantom order and a
  permanently locked parent.** `order_split.reconcile_projection()` only
  had two resolving branches (both legs confirmed, or the child never
  created at all). A real third window — the child registered in memory
  (`order_split.py:206`) but failing before it ever received a
  `broker_order_id` (a staging-transaction error, a consistency check
  throwing) — matched neither branch. No future refresh could ever clear
  it, since the condition that would resolve it never changes on its own.

Both are now fixed:

- `aggregate()`/`normalize_positions()`/`build_orders()` gained an opt-in
  `strict=False` (default `strict=True` preserves the original raise
  exactly, since `protection_recovery.py`/`real_recovery.py`/
  `kotak_protection.py` already have their own retry-with-master handling
  around these same functions and must not be disrupted) plus an
  `unresolved` collector list. `refresh()`'s own calls use `strict=False`:
  an unresolvable row is logged and skipped, not raised, and every other
  order/trade/position still publishes. The existing "fetch the instrument
  master and retry" shape is preserved, just now triggered by whether
  anything was actually skipped on the cheap pass rather than by a raised
  exception. The `quantities_agree()` closure got the same per-row skip.
- `reconcile_projection()` gained the missing third branch: parent
  confirmed at the broker, child registered locally but never placed →
  resolve to `'failed'` and drop the phantom child, clearing the parent's
  `ACTIVE` lock the same way the two existing branches already do.

**Confirmed already correct, no change needed**: once a refresh succeeds,
it genuinely includes every strike/expiry of the underlying (`in_scope()`/
`in_book()` match on symbol+product only). Every gate in the manual
edit/cancel chain (`_require_confirmed_recovery`, `broker_conversion.busy`,
`kotak_protection.suppress`/`handles`, `real_close.unresolved(session,
contract)`) is correctly order-scoped, and the actual broker calls
(`modify_sl_order`, `modify_sl_to_limit_order`, `cancel_order`) are strictly
keyed to the target order's own `broker_order_id` — a manual action on one
contract is never silently filtered or dropped because of another
contract's state.

**Deliberately out of scope, flagged not dropped**: restructuring
`fifo_agrees()`/`quantities_agree()` for a genuine per-contract
partial-publish (right now they compute one whole-book boolean, just
without raising) needs careful thought about whether wallet/P&L figures
stay coherent when one contract's positions data disagrees — a separate,
dedicated change. `protection_recovery.session_lock(session)` is a single
per-session mutex shared by every foreground mutation *and* the background
protection-audit's own broker-submission step — an edit on one contract can
still queue briefly (one broker round trip, or a whole split's duration)
behind another contract's in-flight broker call. It is never rejected or
dropped, just delayed; narrowing it to per-contract is a nice-to-have, not
urgent.
