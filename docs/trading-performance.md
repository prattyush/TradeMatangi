# Trading browser performance

## Changes

Trading charts show fills from currently open position cycles by default. Entries,
additions and partial exits remain visible until that contract becomes flat.
Closing a position removes that cycle's markers. Reversals start a new cycle with
the reversal fill. Rights, strikes, expiries and sessions are matched separately.
Legacy fills without expiry are inferred only when the contract has one known expiry.

The **All markers** button immediately left of maximize shows every executed fill
for that pane. Clicking again restores the open-position view. Each pane has its
own toggle; changing the session or contract resets it. Pending order lines,
strategy lines, drawings, Trade History and stored event snapshots are preserved.

Marker series are reconciled by trade ID rather than removed and recreated on
each price render. Order and strategy price lines also retain their chart objects.
Pane trade/order inputs and ratio inputs are memoized. Recent ticks are maintained
incrementally in a fifteen-minute cache, with stale ticks rejected before updating
live chart state.

Auxiliary ROC history loads only after a comparison is selected. Only its required
legs and intervals load, pending requests coalesce, and retries wait at least five
seconds after completion. Session/contract/selection changes fence late results.
Unused pane and indicator caches are released; expired chart history entries are
pruned on subsequent cache access.

Snapshot database operations run in worker threads. Website broker edits,
conversions and cancellations dispatch broker network calls off the event loop;
callbacks and order identities remain on the loop. Edits are serialized per session.
Edit/conversion persistence uses copies and rechecks for fills received during a
write. Existing synchronous desktop/strategy helpers remain compatible.

## Findings and limitations

The previous parent render created new filtered trade arrays on every tick. Each
chart interpreted that as changed trades and rebuilt all marker series. Both
underlying charts mirrored option fills, so repeated work grew with trade count.
An isolated Chrome/library test with forty markers measured 924 ms for 120 updates
with rebuilding, versus 2 ms when retaining markers. This excludes React and normal
canvas painting and is evidence of unnecessary work, not incident latency.

The same library-only test created 96,000 series without sustained post-GC heap
growth. High allocation/CPU churn and permanent memory retention are different
problems. Browser process memory also includes canvas/native resources and shared
pages that are absent from JavaScript heap measurements.

Snapshot payloads include accumulated fills, so payload size grows with trading
activity. They remain event-triggered and are not stored as an unbounded browser
recording. Slow storage previously blocked the async snapshot route directly.

Existing wallet reservation operations and synchronous desktop/strategy execution
paths retain their behavior. The new loop-lag diagnostics can identify remaining
blocking work. No live broker orders were submitted during verification; the
original 30–45 minute production slowdown still needs a real-session capture.

## Diagnostics

In the affected browser, opt in before reloading:

```js
localStorage.setItem('tradingPerformance', '1')
```

After reload, `window.tradingPerformance` exposes aggregate counters and the latest
600 measurements. It records chart renders and tick processing, marker object
creation/removal, price-line creation/updates, long tasks, heap samples, pending
snapshot saves and order-edit request duration. Export with:

```js
JSON.stringify(window.tradingPerformance)
```

To disable, remove the key and reload:

```js
localStorage.removeItem('tradingPerformance')
```

Start the backend with `TRADING_PERFORMANCE_DIAGNOSTICS=1` to log order, snapshot
and historical request durations and maximum event-loop lag every minute. Logs
contain timings and route names, not request payloads or credentials.

Compare heap snapshots after garbage collection at 5, 15, 30, 45 and 60 minutes.
Also record the browser's tab memory footprint. Stable heap with growing private
renderer memory points toward native/canvas resources; aggregate renderer RSS can
double-count shared code pages and includes spare renderer processes.

## Reproduction

From the repository root:

```bash
node --test frontend/src/services/tradingChartState.test.mjs
node scripts/performance-chart-soak.mjs --minutes=60
node scripts/performance-chart-soak.mjs --realtime --minutes=60
```

The harness bundles the production Chart and OrderPanel components and uses the
event snapshot hook. It simulates SENSEX CE/PE plus underlying 3-minute and 1-minute
panes, 100 fills, the marker toggle, and an order edit every five minutes. All
historical, snapshot and order responses are mocked inside the browser. It never
connects to Kite, Kotak or the application's backend.

It uses a temporary browser profile, temporary files and a loopback server, and prints a JSON result. Chrome uses the basic password store for this disposable profile, so the harness does not request the system keyring. Set
`CHROME_BIN` if Chrome is installed at another path. On Linux it reports heap,
renderer RSS, proportional set size and private memory separately. Accelerated
mode advances simulated market time with Chromium virtual time; its timing values
are virtual-clock observations. Use real-time mode for wall-clock latency and a
long-running memory soak.

The initial accelerated 60-minute run completed 100 snapshots and 12 order edits
without chart errors. Post-GC heap grew from about 6.9 MiB at minute 5 to 7.9 MiB
at minute 60. All 190 created marker objects were removed, including those added
by the temporary all-markers view. A separate one-minute wall-clock check measured
about 20 ms for an order edit and 0.5 ms for the 95th percentile chart tick update.
These are component-harness results, not full application or live broker results.


A follow-up accelerated run measured process memory separately: at simulated
minute 60, the largest renderer used about 235 MiB RSS / 111 MiB private memory;
aggregate renderer RSS was about 796 MiB across seven renderer processes, while
aggregate private memory was about 166 MiB. The largest renderer's private memory
was roughly 109–111 MiB from minute 40 through 60. These process totals do not
identify the production tab's memory footprint or establish a native leak.

Verification on the implementation checkout: frontend TypeScript and production
build passed; 19 Node tests passed. The full backend suite reported 1,542 passes
and two failures. Both failures were reproduced against an isolated archive of
the original HEAD: `test_options_session_started_successfully` expects an expiry
that the existing start route corrects, and
`test_active_session_returns_attach_metadata` uses a fixture missing `group_id`.
The focused edit, snapshot, order and broker-snapshot suite passed 140 tests.
The sixty-minute wall-clock soak remains available through the command above;
only the accelerated hour and a one-minute wall-clock smoke test were run here.
