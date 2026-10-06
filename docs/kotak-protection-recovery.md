# Kotak cancelled-exit recovery

This feature runs in active **Kotak real-trading sessions** using MIS orders,
including NIFTY and SENSEX options. Paper/replay sessions and other brokers are
unchanged. It addresses missing exit coverage after a cancellation; it does not
establish that Kotak or a particular SDK caused the cancellation.

## Recovery policy

After an app-managed exit cancellation, the backend coalesces events for 500 ms
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
