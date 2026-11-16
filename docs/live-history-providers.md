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

## Minute flow for Browse

Browse (phone and Windows app) only draws candles of one minute or more, and Breeze second-level data is slow (calls are paced 1.5 s apart, about 25 per option day). With `granularity=minute` the data routes use `app/services/minute_history.py` instead: a complete second-level cache if one already exists, otherwise Kite minute candles, otherwise Breeze `1minute`, cached under `OHLCDATA_DIR/minute/`. **Kite cannot supply expired option contracts** (its instrument list only holds live contracts), so expired options go straight to Breeze `1minute` (about three years of data). The fixed order does not follow the admin source policy, which defaults to Breeze without fallback. Replay and stepwise are not affected: they never use this module and reject minute frames.

## Minute flow for Patterns and Structures

Pattern Library, Chart Structures and Fine Structures only draw candles of one minute or more, so they read minute data too (`app/services/minute_ohlc.py`, which calls `minute_history.load`; the same sources, order and cache as Browse). The routes are `GET /api/pattern/ohlc/equity|options`, `GET /api/chart-structures/ohlc/{symbol}/{date}` and `GET /api/fine-structures/ohlc/…` and `ohlc-options/…`; the Windows app and phone reach the pattern routes through the Analysis proxy, and the pattern side of the pattern-vs-trade comparison follows them. They keep the prior-day loop (`days_back`, a day with no data or a failed provider is skipped), then resample (`resample_to_candles`, `candles_to_records`, the same IST-labelled-UTC timestamps); a token problem is a 503 and a missing selected day a 404 with the old messages. The index itself has no volume in the response (as before); its option contracts keep theirs. Differences from the second-level path, by design: no gap fill (a minute with no trade is absent, so an illiquid option can lack early candles instead of showing a flat back-filled one), provider minute OHLC and volume, today's minute cache lives 60 s.

Two read-only helpers also take `granularity=minute`: `GET /api/data/price-at` (the **open of the minute bar starting at the time**, the price at that instant with no look-ahead, else the last finished bar's close) and `GET /api/data/options/find-strike-by-price` (the strict Browse resolver `desktop_preparation.find_max_price_strike`: last observed prices before the reference time, 30 strikes from ATM, **no ATM fallback**, a miss is a 404 saying what was missing). Without the parameter both behave exactly as before, which session start, replay and paper still rely on. Everything that needs seconds is unchanged: replay, stepwise, paper and real history, Trade Analysis / Walkthrough / What If / Label trades / Snapshot charts, the AI helper `ohlc-context`, snapshot candles and excursions.

## Browse history, a year back (`browse/history`)

`GET /api/browse/history` (website) and `GET /api/desktop/v1/browse/history` (desktop, phone) page candles of an index or equity back from a day: `symbol`, `interval` (1, 3, 5, 15, 30, 60 minutes or 1440 for daily), `date` (the anchor day), `before` (the open time of the oldest candle the client holds), `days`. A page is whole trading days; the response has `candles`, `more`, `before`, `oldest_date`, `provider`, `partial`. The first page is today's view (the day and two before at fine intervals, more at coarse ones, 250 bars for daily); later pages carry more days (1m 5, 3m 15, 5m 20, 15m 60, 30m and 60m 120). The horizon back from the pane's date is 90 days at 1 minute, 365 at 3 and 5 minutes, 550 from 15 minutes up, which bounds memory and the chart's indicator cost; moving the pane's date reaches anywhere. Source order is fixed: Kite, then Breeze, then Kotak (equities only; it returns placeholders for indices), not the admin policy. Missing days are fetched **one provider call per window** (Kite 60 days, halved if refused, down to a week; Breeze 2 days for its ~1000-record cap; Kotak 30 days) and split into the per-day minute files `OHLCDATA_DIR/minute/<provider>/<id>/<date>.parquet` shared with `minute_history` (final once written after the close; today 60 s); daily bars live in one rolling `daily.parquet` per instrument refreshed with a single call. Bars sit on clock boundaries (09:00 and 10:00 for 60 minutes), the same as the other Browse routes. A token problem is a 503 naming the broker, and that broker is not asked again for a minute. Options are unchanged (about 3 days, no scroll-back).

**A page never skips a day it could not load.** `_fill_days` reports which wanted days are missing because a source failed or was resting (an expired Kite or Breeze token, a timeout) and no other source supplied them, as opposed to days every source answered for without rows (a real gap, passed over). `page()` returns only the run of days next to the seam, newest first, up to the first failed day (`more` stays true, `oldest_date` is that run's oldest day), and raises `BrowseUnavailable` (503, with the reason in words) when the day next to the seam itself failed. Before this, a page returned whatever days happened to be cached when the providers failed, so the chart jumped from 11 Nov to 22 July with no message; the client asks again from the oldest candle it holds, so a skipped day was hidden for good. Retrying is cheap: days already cached are not fetched again, so each retry gets further.

## Kotak SDK

The pinned `kotakneoapi==3.0.7` exposes `historical_data(neosymbol, interval, from_date, to_date)`. History uses a separate read-only client initialized with the configured Kotak consumer key. It does not run TOTP login or touch trading sockets. Instrument lookup shares the existing master cache; a read-only master refresh can use this client without authenticating the trading service. Read-only errors cannot log out an existing trading connection.

Requests use `interval="1min"`, equal from/to dates and `{exchange_segment}|{instrument_token}`. The parser accepts both `success` and the live endpoint's `SUCCESS` status, validates positional OHLCV rows, treats OI as optional, converts explicit timestamp offsets into naive IST, removes duplicates and filters to the requested day's market hours. Zero-only placeholder candles and future rows are discarded; unavailable volume is normalized to zero without creating prices. Cache writes are atomic. Historical calls share a 50 ms minimum start interval per consumer key. HTTP 429 starts a shared cooldown using returned `rateLimit.Retry-After` when available; it does not retry repeatedly during that cooldown.

Official references:

- [Kotak SDK history API](https://github.com/Kotak-Neo/kotak-neo-python/blob/main/docs/functions/market_data/historical_data.md)
- [Kotak historical endpoint and active-contract restrictions](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/market-data-apis/historical-data.md)
- [Kite historical candles](https://kite.trade/docs/connect/v3/historical/)

Kite/Kotak minute downloads require resolvable active instrument tokens. Expired options may be unavailable unless cached or supplied by enabled Breeze fallback. Kotak documents a 30-day maximum range for minute requests; the one-day requests here stay within that bound.

## Pre-fetching Patterns data (`scripts/fetch-patterns-data.py`)

A script that warms the minute cache for the Patterns screens over a range of days, so Patterns opens instantly instead of fetching on first use. For each trading day it calls the same functions the Patterns routes call (`minute_ohlc.candle_records`, `desktop_preparation.find_max_price_strike_minute`, `price_at`, `get_expiry_date`), so the files it fills are exactly the ones the screen asks for: the underlying and the CE and PE contracts of the day, each with the context days before it (`--context-days`, default 2, the "historical days" setting).

- **Strike pick, from data at 09:30:** `--mode max-price --max-price 30|50|75|100` (CE and PE; `--max-price-pe` for a different PE cap; NIFTY and BSESEN only) takes the first strike from ATM outwards whose premium at 09:30 is at or below the cap; `--mode otm --otm-offset N` takes ATM from the 09:30 price and CE = ATM + N steps, PE = ATM - N steps. **The Patterns screen takes ATM at 09:15 in OTM mode**; the script defaults to 09:30 as requested, `--atm-time 09:15` matches the screen. `--pick-time` changes the Max Price time.
- **Range:** `--start` and `--end`, or `--months N` back from `--end` (default 3; end defaults to yesterday). Holidays and weekends are skipped.
- **Source and cost:** minute data only, in the order of `minute_history.load` (a complete second-level cache, the minute cache, Kite, Breeze 1-minute; expired options are Breeze only, one request per contract-day, and a Max Price pick tries strikes outwards from ATM, each a cached file for later). No second-level download is made. Files of finished days are final, so the script can be stopped (Ctrl-C) and run again: everything fetched is reused.
- **Run it with the backend stopped** (Breeze allows one session per login). It refuses to start while something listens on port 8700 unless `--allow-running` is given. An expired Breeze session stops the run with a message; eight failing days in a row (`--max-failures`, default 8) also stop it. `--dry-run` lists the days without requesting anything; `--report file.json` writes every day's result.
- Tests: `backend/tests/test_fetch_patterns_script.py` (19, with fake providers).

## Games data (cache-only, Phase 25 G1)

The Games routes `GET /api/desktop/v1/games/availability` and `/window` are the one consumer that must **never** cause a provider call: they read the second-level parquet files that Breeze (or an earlier session) already wrote to `OHLCDATA_DIR`, and a miss is a 404. They do not go through `load_history`, the admin provider policy, `minute_history` or any provider module, and the minute files of this document (`-kite1m`, `-kotak1m`, `minute/<provider>/...`) are not listed as Games days. `scripts/build-games-index.py` only lists the directory; run it by hand after the cache is refreshed. Details and payload sizes: `architecture-backend.md`, "Games market data (Phase 25, G1)".

## Verification

Final implementation validation: **60 new tests passed**; full backend suite **1,537 passed / 2 known baseline failures** (stale options-expiry assertion and missing `group_id` fixture). Website and desktop TypeScript checks passed.

Tests cover the routing matrix for equity/options, valid and invalid caches, provider isolation, concurrent live/replay requests, session startup mode, API defaults/validation, as-of minute price lookup, fallback order, read-only Kotak authentication/master errors, native timestamps, malformed responses, throttling, stale cache preservation and one-call-per-day cache behavior. A test also exercises the actual Kotak SDK with a mock HTTP transport to check its wire parameters and Authorization header.

After deployment, test Kite and Kotak as historical sources with either provider selected for live streaming. Start/resume website paper/real and desktop paper sessions, change strikes, and refresh charts. Confirm one history request per uncached instrument/day and no history request for complete previous Breeze caches. Test with Kotak trading logged out to confirm that history depends only on the consumer key. Finally, select replay/stepwise while a minute source is configured and confirm only Breeze caches/downloads are used. Retest the original PR #586 streaming/pacing repairs during market hours.

A live read-only stock-history request from this workspace returned and successfully parsed 360 native minute candles in one call, without TOTP. The NIFTY `nse_cm|26000` same-day check returned `SUCCESS` with 375 zero-only placeholders. Those rows are rejected as unavailable data; operators can enable the configured Kite fallback or select Kite for index history. This is an observed provider response, not a claim that every index is unsupported. The new route has not been deployed/validated on EC2 yet.
