# Real-session exit protection

**Work-in-progress checkpoint, 2026-10-05.** The implementation is on
`feature/real-session-exit-protection`. Read the Sprint R3 checkpoint in
[phase19](spec-phase19.md#sprint-r3--broker-confirmed-real-exit-protection) for
completed validation and the concrete remaining work before merge/deployment.
The design below is not a claim of completed live acceptance.

Real protection is event-driven and uses one recovery timer per session and
underlying. There is no permanent polling loop and no timer per strike, right,
entry group or protection order. Paper, simulation and stepwise retain their
existing local watcher.

## Repaired quantity calculation

The former watcher subtracted all contract exits from each entry group. For a
first entry of 20 with an exit of 20, followed by an entry of 40, it placed only
20 more despite a held position of 60. It also generated identities from changing
coverage offsets, which could collide with old terminal protection orders.

The coordinator reconstructs remaining entry lots from chronological broker
executions and carry quantities. It allocates closing coverage once across those
lots, then calculates the uncovered quantity. Each generated order records its
entry IDs and allocated quantities. Confirmed fills, not requested quantities or
minimum lot sizes, establish the obligation.

Scope includes the authenticated broker account, owning real-session context,
date, underlying, exchange, product, right, strike and expiry. A different strike,
expiry or product cannot cover this position. Ambiguous ownership between users
sharing the account/underlying blocks automatic mutation and reports an error.

Broker-active SL and LIMIT orders count by their remaining quantity. Locally
waiting targets do not count until submitted. This is **exit coverage**, not a
guarantee that every position has a dedicated stop-loss or an OCO pair.

## One timer: lifecycle

1. A confirmed application entry fill starts the configured protection delay.
   Further fills update the work without postponing an already earlier deadline.
2. An exit fill, application cancellation/rejection/edit, resume, tracked-session
   broker reconnection or explicit history refresh requests a check.
3. All affected contracts are evaluated in one serialized session pass. Requests
   arriving during a pass mark it dirty instead of starting another task.
4. The pass fetches current broker orders, executions and positions. Concurrent
   sessions for an account reuse a short-lived account snapshot. Automatic passes
   do not fetch funds or download chart history.
5. Missing exits are submitted after lease acquisition and a second verification
   of broker orders and held quantity. This prevents a snapshot taken before
   another worker's mutation from authorizing a duplicate.
6. A newly acknowledged exit gets one confirmation check after 10 seconds. A
   complete broker report with sufficient coverage leaves no scheduled timer.
7. Unresolved work has three retries at 10, 20 and 40 seconds, then stops and
   displays an attention warning. Automatic child rejections/reconnections do
   not reset this budget. Explicit refresh or a new substantive user/fill event
   can request recovery again.

Example: for a requested entry of 60, 20 may fill first and receive protection
for 20. After broker confirmation the timer stops, even if more entry quantity
is still pending. A subsequent confirmed fill wakes the same session timer;
protection is added only for the new gap. Reconnect and explicit refresh recover
missed callbacks. No always-running watchdog attempts to discover them.

Stopping a session or shutting down the backend cancels its recovery task/timer,
without cancelling confirmed broker exits through this coordinator. Resuming
restores persisted intents and requests a fresh check.

## Manual broker activity and history refresh

A new position entered directly in Kotak is enrolled only by explicit order
history refresh for its attached underlying. An unrelated automatic recovery
pass does not enroll it. Changes made directly in the broker while the session
is idle therefore require refresh; no new background discovery task exists.

Manually entered broker exits always contribute to coverage during a check.
They take precedence over generated protection and are never modified by this
coordinator. Excess generated exits are reduced or cancelled following a close,
manual exit addition or reversal. Modifying a partially filled exit sends total
quantity equal to already filled plus desired remaining quantity.

Saved entry SL prices take precedence. Without a saved price, real recovery uses
the approved existing AutoStop fallback: 25% below a long entry or 25% above a
short entry. Real recovery applies this independently of the practice-mode
automatic-SL toggle. Invalid/nontradable quantities or prices are reported; no
quantity is rounded above the held amount and no market exit is fabricated.

Website refresh returns all strikes, CE and PE, and reported expiries for the
underlying, including broker-entered and terminal orders. Exact contract fields
are displayed explicitly. Desktop exposes an explicit `POST
/api/desktop/v1/trading/{session_id}/reconcile` and a Refresh order history button;
ordinary snapshot polling does not enroll manual entries or query the broker.
Account/date ownership and chart selections remain independent of display scope.

## Persistence and uncertain outcomes

New optional Order fields store enrollment, entry allocations, operation identity,
broker client tag, submission state and error. Existing records remain readable.
Protection intents are saved strictly before any HTTP submission. Tags use the
published SDK's `tag` argument and normalized `GuiOrdId` response field.

The existing Orders table also holds account/date/underlying/contract guards in
a separate `protection-lock:` namespace. Conditional leases serialize workers
and are renewed before mutations. Pending submission tags are recorded before
HTTP and survive lease release/expiry. Fresh broker evidence or a definite
rejection resolves them. A timeout is an unknown outcome, not permission to
resubmit. Tag/identity recovery restores an acknowledged order after interrupted
local persistence or restart.

Kotak tags are tracking markers, not a documented broker idempotency guarantee.
Unknown outcomes stop automatic duplicate submission and require fresh broker
verification. If broker evidence never resolves an outcome, the attention state
persists for manual investigation. Direct broker changes cannot participate in
the application's lease; subsequent checks resolve observed coverage changes.

Snapshots/events expose held, covered, missing quantity and protection state.
Website and desktop display attention states. Placement, quantity adjustments
and failures remain logged; covered idle sessions produce no periodic requests.

## Acceptance

- Verify entries of 40/60 with minimum lot 20 and partial/cumulative fills.
- Verify multiple entry groups and SL prices, manual SL additions, and exact
  strike/expiry/product separation.
- Verify partial exits, full closure and reversal remove excess generated exits.
- Verify timeout/ack persistence recovery never blindly creates another exit.
- Verify covered sessions become idle and a later application fill wakes them.
- Open a manual broker position: confirm no automatic discovery, then refresh
  history and check enrollment/coverage across the underlying's strikes.
- Verify website and desktop all-strike history and unchanged chart selections.

Automated tests use mocked broker responses and local SDK transports. Live broker
acceptance must be performed after review; development submits no live orders.
