# Market data repairs

The fixes are based on dev `56a1e9e`. The two latest merges change the desktop strike dropdown and real-session history preservation; neither changes the shared Kite broadcaster. Preserve those features.

## Kite REST

All current REST call sites use API-key scoped pacing: historical 350 ms, general 110 ms, instruments/quotes 1.05 s. HTTP 429 or a rate-limit exception is retried at most three times with 1/2/4-second backoff (or a longer numeric Retry-After when available). Slower spacing remains for 60 seconds. Failed authentication invalidates only the affected client; 429 is never reported as an expired token. Credential changes initialize a new client, so a daily token update takes effect without restart.

One request still retrieves all available minute candles for a contract/day. Concurrent instrument-master refreshes share one atomic replacement. Historical fallback remains governed by the configured policy.

## Breeze daily cache

Today uses its existing 600-second TTL for ordinary reads. Explicit refresh and stale-cache reads download an overlapping tail, starting one 15-minute chunk before the chunk containing the final cached timestamp. Downloads end at current IST time or market close, whichever is earlier. Missing chunks since the cached timestamp are included.

Fresh provider timestamps replace matching cached rows; earlier rows remain. Equity and options retain their existing gap-fill behavior and native cadence. A download failure retains the original parquet and modification time. Cadence changes reject the merge rather than mix minute and second rows; the historical policy can expose stale data or configured fallback. Cold/past-date downloads still start at market open. Overlapping explicit refresh requests share the completed download.

Refresh logs include the reason, window, reused rows, chunk count and response row count. The former equity "empty" log could actually mean an explicit refresh of a populated file.

## Kite streaming

Website and desktop share the same broadcaster. Previously, a fixed one-second sleep ended registration even if the handshake had never completed. The market-data hub then marked both clients connected without any subscriptions or recovery task. This behavior was reproduced locally.

`kite_reactor.call` starts Twisted once and runs connection/subscription/close operations on its reactor thread. Registration waits up to 15 seconds for handshake and successful subscription. Startup errors release registrations and use the existing fallback policy; real Kite sessions remain restricted to Kite. Releasing the last consumer closes the ticker without stopping Twisted, allowing a subsequent session to connect.

Stale callbacks cannot reconnect or publish from a replaced ticker. Error, close, reconnect and exhausted-retry notifications reach consumers. Logs distinguish connection attempt, handshake, subscription, first raw tick and first published candle. A connected NIFTY/SENSEX subscription with no tick for 30 seconds during trading hours emits a diagnostic warning; quiet markets do not force a provider switch.

## Verification and EC2 follow-up

`test_market_data_repairs.py` covers shared pacing, backoff and retry exhaustion, client reuse/rotation, explicit-refresh coalescing, overlap replacement, market boundaries, failed-download cache preservation, cadence isolation, delayed handshake and startup cleanup.

A subprocess harness uses the real Kite SDK against a local WebSocket server. It verifies shared website/desktop delivery, exact CE contract metadata, SDK reconnection after transport loss, and stop/start using the same reactor. No broker credentials or order requests are used.

After the reviewed change is deployed, verify during market hours:

1. Start website and desktop streams using Kite, with NIFTY, BSESEN and a valid option contract.
2. Confirm handshake/subscription logs and `kite_first_tick`, `kite_first_candle`, and `market_data_first_tick` for each subscribed instrument.
3. Confirm charts update on both clients, including a resumed real session whose history remains intact.
4. Stop/restart and switch providers; confirm subscription cleanup and successful reconnection.
5. Refresh with Breeze selected for history. Confirm a bounded tail window and unchanged earlier timestamps; verify no Kite 429 burst during strike scanning.

Production EC2 handshake/tick delivery has not been verified from this workspace. Local SDK validation does not establish production network or credential health.
