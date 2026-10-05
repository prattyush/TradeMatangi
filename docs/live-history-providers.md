# Paper/real history providers

This follow-up starts from dev `7c3a071`, which includes PR #586. The user deployed those original fixes to main/EC2 and confirmed that Kite throttling, Breeze refreshes and shared Kite streaming were resolved. The follow-up was implemented separately in [PR #588](https://github.com/prattyush/TradeMatangi/pull/588) and merged to `dev` as `911a6f0`. It preserves those repairs. The full requirement and current mode/provider setup are recorded in [Phase 19](spec-phase19.md#paperreal-history-providers--2026-10-05).

## Routing

Replay, stepwise and paper trading use the same mode-specific provider rules on
**desktop and website**, including cache reuse, downloads, refreshes, fallback,
required-data errors and native cadence.

| Consumer | Today | Previous dates |
|---|---|---|
| Paper (website and desktop), website real, and desktop live charts | Configured provider, with separate provider caches | Complete Breeze cache first; otherwise configured provider/cache |
| Replay and stepwise (website and desktop) | Breeze only | Breeze only |
| Historical Browse and analysis | Breeze | Breeze |

The configured source is independent of the live streaming source. The existing `historical_data_policy` setting accepts `breeze`, `kite` and now `kotak`; the default remains Breeze with fallback disabled. Both settings UIs call this **Paper/real historical data**. Existing saved values remain valid; no database migration is needed.

Today never substitutes a different provider's cache just because it exists. Existing refresh/coalescing rules remain in effect. For previous dates, reuse of Breeze data checks the exact contract/day filename, the existing row-count threshold, native second cadence and coverage through market close. Empty, corrupt, partial and minute-only files do not satisfy this preference. Legacy complete equity pickles retain their migration path.

Uncached previous dates can now use Kite/Kotak minute history. Each request covers one instrument/day, including all available candles, rather than Breeze's repeated 15-minute second-data chunks. Initial token/master lookup can require additional calls. Previous minute files written before that date's market close are refreshed once instead of becoming permanent partial-day caches. If the selected minute provider cannot refresh a usable file, its cached bars remain available as stale history.

With fallback enabled, the chains are Breeze → Kite, Kite → Breeze, and Kotak → Kite → Breeze. With fallback disabled, missing/expired contract history does not trigger an unrequested Breeze download. Optional unavailable context dates are skipped by existing chart handling. Replay never uses these fallback chains.

## Modes and compatibility

History operation scopes carry `live` or `replay` mode and preserve it across desktop history workers and `asyncio.to_thread`. Background engines keep their mode after startup while discarding the HTTP operation/result cache. Backend result/coalescing keys include mode and provider cache locations. Policy is frozen per operation, including parallel loads of different dates/contracts.

The website data API accepts an optional `history_mode=live|replay` query parameter, defaulting to `replay`. Paper/real charts, indicator context, price-at preflight and strike selection pass `live`; analysis retains the default. Frontend chart/indicator cache keys include mode. Session startup and strike changes derive mode from the session type rather than trusting an inherited request context. Desktop live chart loading uses live mode explicitly; ordinary Browse remains replay mode.

Breeze, Kite and Kotak files remain separate. Kotak uses the same identity format as Kite with a `-kotak1m.parquet` suffix. Native minute candles are neither expanded to seconds nor exported into desktop raw-second caches. Replay/stepwise tick iterators reject minute frames. History is presentation data; live quote/order-execution routes remain independent.

## Kotak SDK

The pinned `kotakneoapi==3.0.7` exposes `historical_data(neosymbol, interval, from_date, to_date)`. History uses a separate read-only client initialized with the configured Kotak consumer key. It does not run TOTP login or touch trading sockets. Instrument lookup shares the existing master cache; a read-only master refresh can use this client without authenticating the trading service. Read-only errors cannot log out an existing trading connection.

Requests use `interval="1min"`, equal from/to dates and `{exchange_segment}|{instrument_token}`. The parser accepts both `success` and the live endpoint's `SUCCESS` status, validates positional OHLCV rows, treats OI as optional, converts explicit timestamp offsets into naive IST, removes duplicates and filters to the requested day's market hours. Zero-only placeholder candles and future rows are discarded; unavailable volume is normalized to zero without creating prices. Cache writes are atomic. Historical calls share a 50 ms minimum start interval per consumer key. HTTP 429 starts a shared cooldown using returned `rateLimit.Retry-After` when available; it does not retry repeatedly during that cooldown.

Official references:

- [Kotak SDK history API](https://github.com/Kotak-Neo/kotak-neo-python/blob/main/docs/functions/market_data/historical_data.md)
- [Kotak historical endpoint and active-contract restrictions](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/market-data-apis/historical-data.md)
- [Kite historical candles](https://kite.trade/docs/connect/v3/historical/)

Kite/Kotak minute downloads require resolvable active instrument tokens. Expired options may be unavailable unless cached or supplied by enabled Breeze fallback. Kotak documents a 30-day maximum range for minute requests; the one-day requests here stay within that bound.

## Verification

Final implementation validation: **60 new tests passed**; full backend suite **1,537 passed / 2 known baseline failures** (stale options-expiry assertion and missing `group_id` fixture). Website and desktop TypeScript checks passed.

Tests cover the routing matrix for equity/options, valid and invalid caches, provider isolation, concurrent live/replay requests, session startup mode, API defaults/validation, as-of minute price lookup, fallback order, read-only Kotak authentication/master errors, native timestamps, malformed responses, throttling, stale cache preservation and one-call-per-day cache behavior. A test also exercises the actual Kotak SDK with a mock HTTP transport to check its wire parameters and Authorization header.

After deployment, test Kite and Kotak as historical sources with either provider selected for live streaming. Start/resume website paper/real and desktop paper sessions, change strikes, and refresh charts. Confirm one history request per uncached instrument/day and no history request for complete previous Breeze caches. Test with Kotak trading logged out to confirm that history depends only on the consumer key. Finally, select replay/stepwise while a minute source is configured and confirm only Breeze caches/downloads are used. Retest the original PR #586 streaming/pacing repairs during market hours.

A live read-only stock-history request from this workspace returned and successfully parsed 360 native minute candles in one call, without TOTP. The NIFTY `nse_cm|26000` same-day check returned `SUCCESS` with 375 zero-only placeholders. Those rows are rejected as unavailable data; operators can enable the configured Kite fallback or select Kite for index history. This is an observed provider response, not a claim that every index is unsupported. The new route has not been deployed/validated on EC2 yet.
