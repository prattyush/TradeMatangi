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

## A genuine timeout froze the backend and left an order stuck forever — 2026-10-27

Two live incidents in one real NIFTY options session, root-caused directly
from production logs (`backend.log`, `desktoplog.json`) rather than from a
reported symptom alone, surfaced the first *reachable* violation of "broker
is the only source of truth" since the 2026-10-23/24 scope-discipline and
barrier-wait work above: a genuine Kotak SDK timeout, not a code bug on its
own, combined with two real gaps to produce a 30-second total freeze
followed by over 90 minutes of a contract being untradeable and its own
stuck order being uncancellable.

**Incident 1 (~09:30–09:31 IST)**: an AutoStop-triggered BUY TARGET order's
forward-to-broker call timed out after 30 seconds. During that entire
window, the backend log shows *zero* lines of any kind — every session's
ticks, every HTTP endpoint, completely frozen. The cause: the live
tick-processing loop (`simulation.py`'s `_emit_tick_and_check_orders_real`)
called `broker_order_service.submit_once()` — a synchronous Kotak
SDK/httpx call — directly on the shared event loop. This is a *different*
call site from the one already flagged and deliberately deferred in the
2026-10-23 entry above (`sync_order_edit()`'s synchronous twin, reached only
via `strategy_service.py`'s automated amendments); this one sits in the
tick loop's own triggered-order forwarding path and had never been migrated
to the `asyncio.to_thread` pattern already established in
`broker_order_service.py` (`submit_immediate_async`).

**The stuck-forever half**: the timeout left the order's `recovery_state`
ambiguous (`'unknown'`, correctly — a timeout genuinely doesn't confirm or
deny broker acceptance). But nothing in `real_broker_state.build_orders()`
ever resolved that ambiguity unless a *matching* row showed up in a later
broker report. The function's own comment ("Broker-backed locals absent
from a complete report are not live orders") stated the intended opposite
case — a complete report that simply never contains the tag is just as
authoritative a signal as a match — but no code acted on it. Kotak's report
API was independently flaky for over an hour in this incident
(`httpcore.ReadTimeout`/502s, an external connectivity issue, logged as
`kotak_reports_failed`), so the order never got a lucky match either. Net
effect: new orders on that exact contract were instantly rejected every
time (confirmed at 10:33:08, 10:33:15, 10:34:02 IST and again later), and
cancelling the stuck order itself was rejected on 20+ attempts over more
than an hour — including immediately after a session stop/restart
(~09:44–09:45 IST), since orders persist per trading-day in the database,
not per in-memory session, so the restart simply reloaded the same stuck
row.

**Incident 2 (~10:52–10:56 IST), the cancel gap**: a system-auto-placed
protective exit order hit the identical ambiguous state on its own first
placement attempt. Every modify, convert, and cancel the user tried against
it failed with the same `_require_confirmed_recovery` 409. For edit/convert,
that guard is correct — amending an order whose broker acknowledgement is
unknown risks inventing a duplicate submission. For *cancel*, it is not: the
user's intent (get rid of this order) is unambiguous regardless of whether
it ever reached the broker, and this is exactly the class of manual,
broker-bound action the 2026-10-24 entry above says must never be
permanently blocked. `_require_confirmed_recovery` had never been split
along that line — cancel got the same hard block as edit/convert/split.

**Fix, three parts**:
- `simulation.py`'s `_emit_tick_and_check_orders_real` is now `async def`;
  its broker-forwarding calls (`require_entry_allowed`, `submit_once`, the
  order-persistence writes) run via `asyncio.to_thread`. The one other
  direct caller (`swing_portfolio_service.py`) now awaits it.
- `real_broker_state.py` gained `_resolve_tag()` (pure: matched / absent /
  too-soon-to-tell, guarded by a minimum age since submission to avoid
  racing a report that predates the broker's own acknowledgement) and
  `resolve_pending_tag()` (a bounded, single-order, on-demand fetch —
  deliberately lighter than the full `refresh()`, for the moment a user is
  actively trying to act on one specific order). `build_orders()` now uses
  `_resolve_tag` to resolve a genuinely-absent order to `recovery_state=
  'failed'` **and** `status=CANCELLED` together (required together: a
  `PENDING` order with `recovery_state='failed'` would otherwise be
  miscounted as live protective cover by `protection_recovery.coverage()`).
  `refresh()` releases that order's wallet reservation immediately after
  the resolution is committed, mirroring what a local cancel already does.
- `orders.py`'s cancel path now skips the recovery-state check entirely
  once an order's `broker_order_id` is known (identity is well-defined
  regardless of what else is ambiguous about it), and otherwise calls
  `resolve_pending_tag` for a bounded 3-second on-demand reconciliation
  attempt before falling back to either an actionable 409 or, with
  `force=true`, proceeding anyway and raising a persistent `needs_attention`
  notice so the uncertainty is surfaced rather than silently dropped.
  Edit/convert/split are untouched — they keep hard-blocking on an order's
  own ambiguous state, since inventing a duplicate submission there is a
  real risk cancel doesn't share.

**Deliberately not fixed, flagged as a known follow-up**: the tick loop's
*other* synchronous broker call, `_register_kotak_sl_for_order` (reached via
the same loop's automated strategy evaluation for BreakEven/TargetProfit/
trailing-stop amendments), has the identical event-loop-blocking shape and
was intentionally left alone — same reasoning as the 2026-10-23 deferral of
`sync_order_edit()`'s twin: it has roughly a dozen call sites across several
files and needs its own dedicated async-ification pass, not a fold-in here.
The Kotak report-API connectivity flakiness itself is an external/vendor
issue; these fixes are about how the app behaves *given* that flakiness; not
about preventing it.

## A Kotak-side cancellation's auto-replacement was starved by an unrelated stuck order — 2026-10-27 (continued)

A fourth incident on the same trading day, same session, surfaced a deeper
version of the same defect family above — this time in the *background*
auto-repair path rather than a user-facing endpoint. Three 65-lot entries on
NIFTY CE 22900 each needed independent protective coverage. Kotak itself
cancelled one of the three already-confirmed SLs on its own (`cancelled:
--`, coincident with an unrelated fill on a different one of the three, no
app-initiated cancel anywhere in the logs — a genuine broker-side/RMS
event, not something this app controls or can prevent). This project's own
documented policy says an unknown-origin cancellation with a correlated
exit fill is eligible for automatic replacement. It never replaced it.

**Root cause, traced directly in code**: `kotak_protection.py`'s `audit()`
processes every entry needing protection in two loops (reconciling existing
jobs, then detecting/repairing new gaps) with **no per-entry exception
isolation** — a bare call into `protection_recovery.reconcile_children`/
`_attempt`, no try/except, for each entry in turn. `reconcile_children`
itself (checking whether a submitted child's tag appears in a fresh broker
report) had **no give-up path at all**: if the tag never matches, it raises
`Deferred` on every single call, forever — there was no equivalent of
`build_orders()`'s absent-tag resolution from the entry above. In this
incident, an *unrelated*, already-known-stuck order from an earlier timeout
(the same kind of order described above) was sitting in exactly that
state. Because `audit()` had no per-entry isolation, that one stuck order's
endless `Deferred` aborted the *entire* audit pass — every single retry
cycle — before the function ever reached the gap-detection/repair logic
for the newly-cancelled SL's entry. The stuck order didn't just stay
stuck; it silently prevented the audit from ever getting to anyone else's
problem, for as long as it persisted.

**A second, compounding gap**: `protection_recovery.py`'s own automatic
submission path (`_attempt`) never wrote its tracking tag into
`analytics['broker_tag']` on the orders it creates — only the manual/direct
`submit_once` path (used by the earlier entry's fixes) did. Grep confirmed
exactly one writer of `broker_tag` in the whole codebase before this fix.
This meant every automatically-submitted protective order — the majority of
protective-SL traffic, and precisely the kind most likely to hit a timeout
under stress — was invisible to this PR's own absent-tag resolution and
cancel-bypass machinery. Even the force-cancel UI added alongside this fix
would not have been able to resolve this specific order type without this
tag also being present.

Separately, the user's manual retry (`fill-missing-stoploss`) was initially
and correctly rejected as "already fully covered" — `_stoploss_available_quantity`
counts any locally `PENDING` exit order as covering collateral regardless
of broker confirmation, which is why the website briefly showed two
~65-lot SL records (the stuck phantom plus a second, genuinely-confirmed
replacement created once the user retried) while the broker never had more
than one real resting order. That counting behavior is intentional (the
alternative — not counting an unconfirmed order as covering anything —
risks double-submitting cover for a quantity that might already be in
flight) and was left as-is.

**Fix**:
- `protection_recovery.py`'s `_attempt`: writes `analytics['broker_tag']`
  onto every order it submits, applied *after* `execution_analytics.
  created()` builds the full snapshot (not via the `Order(...)` constructor
  — verified that pre-populating `analytics` there would make `created()`
  skip building the snapshot at all, silently losing capital/margin_rate/
  entry_method and other fields entry-protection children need).
- `protection_recovery.py`'s `reconcile_children`: gives up (resolves to
  `recovery_state='failed'` + `status=CANCELLED`, via the existing
  `abandon_prepared` helper) when a never-acknowledged child's tag is
  genuinely absent from a complete report and old enough to trust that —
  reusing `real_broker_state._resolve_tag` for the same age guard used
  elsewhere in this PR. An already-acknowledged child (known broker order
  ID) disappearing from a report is treated as more alarming and keeps
  deferring; only the never-acknowledged case gives up.
- `kotak_protection.py`'s `audit()`: both per-entry loops now catch
  `Deferred` per entry and continue to the next one, collecting what's
  still stuck rather than aborting. One contract's permanently-ambiguous
  order no longer prevents every other entry's legitimate repair in the
  same session from running.

## Force cancel, for when even the bounded reconciliation above can't resolve it

Added alongside the above: a `force=true` UI affordance on both the
website (a second `⊗` icon beside the existing cancel button in
`OrderPanel.tsx`, behind the existing `ConfirmModal`) and the desktop app
(`ChartTile.tsx`'s chart line-actions popup and `App.tsx`'s
`DesktopOpenOrders` list, both behind `window.confirm`), wired to the
`force=true` cancel override already implemented for the first incident in
this file. `desktop_trading.py`'s cancel endpoint now forwards `force` the
same way the website's own endpoint already did. The ambiguous-cancel 409
is now a structured `{code, message}` rather than a plain string so both
frontends can detect it reliably.
