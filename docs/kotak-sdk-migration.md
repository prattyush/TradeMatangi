# Kotak Python client migration — Phase 19

## Target and boundaries

The migration targets the published **`kotakneoapi==3.0.7`** release, selected
instead of unreleased GitHub main. Python imports remain `neo_api_client`.
The previous startup scripts installed the legacy repository at `v2.0.1`
(its installed distribution metadata reported `neo-api-client 2.0.0`).

This is a compatibility migration of functionality already used by
TradeMatangi. No new broker products, exchange segments, historical provider,
market-depth UI, option chain, holdings, margin calculation, or authentication
flow is introduced. HTTP/SSE payloads, credential names, persistent records,
symbols, sizing, execution gaps and real-account capital formulas are retained.

The audit checked every public broker method in the pinned client against its
service implementation, response examples and application call sites, plus
the WebSocket implementations/models/protocol and package metadata. Source is
authoritative when examples disagree: some examples use the invalid
`mobilenumber` keyword; actual authentication uses `mobile_number`.

Primary references:

- [Pinned SDK client and complete method signatures](https://github.com/Kotak-Neo/kotak-neo-python/blob/v3.0.7/neo_api_client/neo_api.py)
- [Migration guide](https://github.com/Kotak-Neo/kotak-neo-python/blob/v3.0.7/docs/guides/MIGRATION.md)
- [REST service implementations](https://github.com/Kotak-Neo/kotak-neo-python/tree/v3.0.7/neo_api_client/services)
- [Package requirements](https://github.com/Kotak-Neo/kotak-neo-python/blob/v3.0.7/pyproject.toml)

## Installation on local Linux/WSL and EC2

Stop the backend before changing its environment. Both backend startup scripts
now call the same installer after creating/selecting their venv:

```bash
bash scripts/install-backend-dependencies.sh
# Optional existing environment:
bash scripts/install-backend-dependencies.sh --venv /path/to/venv
```

The default is `$HOME/venvs/tradematangi`. The installer requires an existing
Python 3.10+ venv; it does not alter the system interpreter or credentials.
For a new standalone environment, create it outside `/mnt/d/` first:

```bash
python3.12 -m venv "$HOME/venvs/tradematangi"
bash scripts/install-backend-dependencies.sh
```

Before installing requirements, the script detects the legacy distribution.
If present, it uninstalls **both** distribution names, then installs backend
requirements normally. Both packages write the same `neo_api_client/` files:
installing the new package before uninstalling the old one would corrupt the
new package. Removing both also repairs an environment with mixed distributions.
Healthy migrated environments are not uninstalled on subsequent runs.

The helper verifies that the legacy distribution is absent, the new version is
exactly 3.0.7, both async feed classes import, and `pip check` succeeds. Failure
aborts startup. The old Git URL and `--no-deps` workaround are removed from both
startup scripts. Existing standalone plotting dependencies remain installed by
those scripts.

Local migration was performed using this helper. A fresh external venv also
passed installation/import/dependency verification. Repeated-run verification
is recorded below. EC2 uses the same script; actual EC2 execution remains a
deployment acceptance check.

Rollback with the backend stopped: uninstall the new SDK, restore the previous
application revision (including requirements and startup scripts), then restore
the original SDK with its original dependency workaround:

```bash
"$HOME/venvs/tradematangi/bin/python" -m pip uninstall -y kotakneoapi
# Restore the previous application revision before restarting.
"$HOME/venvs/tradematangi/bin/python" -m pip install --no-deps \
  'neo_api_client @ git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.1'
```

Do not run the new startup scripts after reverting only the package: they
intentionally install the new SDK. No database migration is needed.

## Authentication and trading API audit

REST operations are synchronous HTTPX calls. Most failures are returned as
`Error`, `error`, `Error Message`, `errMsg`, or failed status dictionaries;
network authentication failures can also raise `ApiException`. HTTP/2 support
and its dependencies are installed through the SDK's normal requirements.
Application code handles both returned failures and exceptions. Optional
reliability utilities are not enabled, and order submissions are not retried.

| API | Contract and response findings | Existing use / migration decision |
| --- | --- | --- |
| `NeoAPI(...)` | Constructor argument order changed; `consumer_key` comes first and environment defaults to prod. Supports keyword transport, pool, HTTP/2 and timeout configuration. | Existing construction already used keywords and explicit prod. Keep credential `access_token` mapped to **consumer key**, not preauthenticated SDK access token. |
| `totp_login(mobile_number, ucc, totp)` | Returns view-session data (`token`, `sid`, status); blank inputs return lowercase error lists. Sets configuration only when data exists. | Used by website/desktop settings and diagnostic script. Check returned failure/status and actual view-session credentials before proceeding to MPIN. |
| `totp_validate(mpin)` | Returns trade token/session, routing/data-center information and potentially feed URLs. SDK resolves dynamic endpoints. | Validate response and trade credentials before authenticated state. Let SDK factories choose data-center URLs; do not hardcode production socket endpoints. |
| `place_order(...)` | Exact segment/product/order/validity codes; positive price for L/SL and positive integral quantity. Removes `pf`, configurable `market_protection` and bracket/cover-only arguments. SDK sends market protection zero internally. Returns OMS acknowledgement/order ID or error dictionary. | Four existing equity/options LIMIT/SL paths remove only the two unsupported arguments they passed. Retain MIS, DAY, B/S, strings, existing tick rounding and contract-symbol construction. |
| `modify_order(order_id, price, order_type, quantity, validity, ...)` | No exchange/product/symbol/transaction or filled-quantity arguments. Quantity remains mandatory; SL trigger and AMO supported. Returns raw acknowledgement, not confirmed final exchange state. | Existing arguments already fit. Preserve price changes and SL-to-L conversion; require valid acknowledgement before local success. Return replacement order ID where supplied, otherwise existing ID. |
| `cancel_order(order_id, amo='NO', isVerify=False)` | Backend receives cancellation directly. `isVerify` is retained but has no effect. Completed orders return stCode 1021, error text and status_code 400. | Existing regular cancellation retained. Malformed or failed acknowledgements raise `KotakError`; never silently confirm cancellation. |
| `order_report(order_id=None)` | Account-wide order book by default; optional single-order retrieval. Returns top-level status and data list. | Used for reconciliation, external orders and `/api/kotak/order-history`. Continue the account-wide call and existing normalized output. Do not rename this to SDK `order_history`. |
| `order_history(order_id)` | Required order ID; service wraps the decoded backend history in a `data` dictionary, potentially nesting its data list. It is the lifecycle of one order. | Unused. No new calls or normalizer changes for this different interface. |
| `trade_report()` | Account-wide executions; no order filter. Identity/time/price fields remain `nOrdNo`, `flId`, `flDt`, `flTm`, `fldQty`, `flPrc`; conversion factors remain available. | Retain execution normalization, deduplication, matching and real-account recovery. No quantity/lot-size reapplication. |
| `positions()` | Returns raw account-wide data list with carry quantities/amounts, day fills and price conversion fields. 3.0.7 does not enrich it with new P&L/holdings calls; later main differs. | Preserve position validation, carry inventory and reconciliation. Do not infer new behavior from unreleased main. |
| `limits()` | No filter arguments; always requests ALL segments, exchanges and products. `Net` and `MarginUsed` remain top-level fields. | Retain raw available funds, adjusted display wallet and recovered day-start capital. The previously documented aggregate-commitment assumption still requires broker acceptance. |
| `holdings()` | Authenticated portfolio report, data list and backend/error dictionaries. | Unused. Do not fetch holdings or change portfolio/accounting behavior. |
| `margin_required(...)` | Requires exchange, price, order type, product, quantity, instrument token and transaction type. Service wraps backend JSON in `data`; optional legacy calculation arguments remain in its signature. | Unused. Existing application affordability/margin policy is unchanged; no new broker-margin integration. |
| `logout()` | In 3.0.7 the public method clears local tokens and returns a State/message dictionary; it does **not** call the logout REST service or close socket objects. | Unused public feature. Application shutdown explicitly closes its own sockets and REST transport; add no logout endpoint. |
| `whatsmyip()` | Authenticated IP lookup; response includes data list, stCode 1000 and status success. | Unused. Add no IP lookup or deployment/network policy change. |

Error validation recurses into dictionary envelopes. Expired/unauthorized
sessions clear authentication and stop feeds, including string error codes.
Report failures and malformed rows do not become authoritative empty days.
Successful empty data lists remain valid. Missing/nonfinite funds remain errors.
Modify/cancel operations additionally require a recognizable success
acknowledgement; placement requires an order ID. These checks address real v3
returned-error paths rather than introducing broker functionality.

## Market-data API audit

| API | Contract and response findings | Existing use / migration decision |
| --- | --- | --- |
| `scrip_master(exchange_segment=None)` | With a segment, returns a CSV URL **string** despite dictionary type annotations. Without one, returns filesPaths metadata. Consumer key suffices; completed TOTP is not required by the broker. | Used. Retain application login requirement, URL downloads, CSV normalization, 24-hour cache, and nse_cm/nse_fo/bse_cm/bse_fo. Validate returned errors before treating a result as a URL. |
| `search_scrip(exchange_segment='', symbol='', expiry=None, option_type=None, strike_price=None, ignore_50multiple=True)` | Segment required despite empty default. Filters a cached scrip-master CSV; successful implementation returns a pandas DataFrame, not necessarily a dictionary. Errors are dictionaries. | Unused. Keep existing exact-contract cache lookup; add no SDK disk cache/search dependency. |
| `quotes(instrument_tokens, quote_type=None)` | Token/segment dictionaries, consumer-key authentication, backend batch cap of 50. Missing tokens return error dictionary; successful quotes are decoded backend JSON. | Unused. Do not replace existing price or historical sources with quotes. |
| `expiries(exchange, underlying, instrument_type=None)` | Consumer-key endpoint for available dates; returns backend JSON and errors. | Unused. Do not replace existing expiry helpers. |
| `option_chain(exchange, underlying, expiry=None, instrument_type=None, count=None)` | Consumer-key endpoint for options/futures chain; result shape depends on requested instrument type. | Unused. No chain-based contract selection or UI. |
| `historical_data(neosymbol, interval, from_date, to_date)` | Consumer-key endpoint; `exchange|token`, interval and dates required. Backend validates intervals/date windows; candles are positional rows with ISO timestamps. Active-contract availability differs from archived historical sources. | Unused. No Kotak historical provider, timestamp migration or change to existing history/fallback. |

## Market feed and order-event audit

The legacy `subscribe`, `un_subscribe` and `subscribe_to_orderfeed` names still
exist as stubs but always raise `NotImplementedError`. Setting callbacks on
`NeoAPI` no longer starts feeds. The SDK's `help()` utility adds no runtime broker
functionality. Removed cover/bracket cancellation methods are unused and have
no new application replacement. Documentation pages for legacy login/session_2fa/session_init do
not establish usable public methods; TradeMatangi continues TOTP exclusively.

- [SFeed methods and index tokens](https://github.com/Kotak-Neo/kotak-neo-python/blob/v3.0.7/docs/functions/websocket/market_feed.md)
- [Order and position feed](https://github.com/Kotak-Neo/kotak-neo-python/blob/v3.0.7/docs/functions/websocket/order_feed.md)
- [Feed models/protocol](https://github.com/Kotak-Neo/kotak-neo-python/tree/v3.0.7/neo_api_client/websocket/feed)
- [Order models/client](https://github.com/Kotak-Neo/kotak-neo-python/tree/v3.0.7/neo_api_client/websocket/orderfeed)

`create_websocket()` requires trade credentials and returns an async SFeed
client. It authenticates using the SDK's session/UCC defaults and decodes binary
native_batch messages, already scaled by exchange divider. `create_order_feed()`
returns a **separate** async socket with its own session/routing/authentication;
it pushes typed `OrderUpdate`/`PositionUpdate` messages without a subscribe call.
Both factories support explicit endpoints for isolated local-server tests.

| Streaming method/message | Finding and migration action |
| --- | --- |
| `subscribe_scrips` / `unsubscribe_scrips` | Used for existing equity/options touch-line prices. Batch `WsToken(exchange, token)` identities; no depth consumer added. |
| `subscribe_index` / `unsubscribe_index` | Indices subscribe by name: `nse_cm|Nifty 50`, `bse_cm|SENSEX`. Returned indices carry numeric tokens and names. Map them to existing master identities; do not mix scrip/index subscription intents. |
| `subscribe_scrips_lite`, depth, full_depth and matching unsubscribe methods | Investigated; unused. No consumers introduced. |
| `subscribe_exchange` / `unsubscribe_exchange` | No token arguments. Produces exchange status messages, not instrument prices. Unused; no subscription added. |
| `snapshot(tokens, intent)` | Async one-shot request under a selected feed intent. Unused; no replacement of existing history or price handling. |
| `SFeedScrip`, `SFeedIndex` | Consume existing price capability only. Retain token/exchange identity and 1-second OHLC. Prefer positive update time, then trade time, then receipt time; add IST offset exactly once. Never re-scale SDK prices. |
| `SFeedScripLite`, `SFeedCasChange`, `SFeedMarketStatus` | Not chart prices for this integration; ignored. CAS reference values must not become execution ticks. |
| `OrderUpdate` | Uses optional wire aliases nOrdNo/ordSt/avgPrc/fldQty/qty/trnsTp. Extra fields preserve rejection reasons. Accept typed model dumps and raw fallback frames; preserve cumulative quantities and terminal cleanup. |
| `PositionUpdate` | Not consumed. Existing REST position/account reconciliation remains authoritative. |
| Raw/control frames | Malformed/unknown frames cannot fabricate fills. Observe unauthorized connection-control frames before SDK filtering; expire the session instead of retrying its credentials forever. |

The application owns reconnects on one lazily started background asyncio loop
per process, rather than mixing SDK reconnects with application timers. SDK
initial/automatic retry counts are zero. Each supervisor creates a fresh
socket/iterator after transient disconnect and retries every five seconds;
authentication rejection stops the bridge and requires login. Order submission
is never retried by this mechanism. A new subscription waits at most 30 seconds;
failed additions roll back. Existing desired subscriptions restored after login
connect asynchronously and retry transient startup failures.

The authoritative desired set is independent of socket state. Reconnects
restore only currently owned subscriptions; removals during outages take effect
without waiting. Last consumer removal closes the market feed while preserving
the authenticated order feed. Strike replacement commits after subscription
success. Broadcaster state is keyed by exchange **and** token, preserving exact
contracts even when different exchanges reuse a token number.

Old login generations cannot deliver callbacks into replacements. Shutdown
cancels supervisors, closes sockets/REST transport and stops the loop. Fill
callbacks retain cumulative partial-fill behavior, buffer early fills without
regressing quantities, process partial cancellation, and ignore duplicate
terminal replay. Early rejection callbacks are also delivered on registration.
FastAPI login and existing async registration/strike calls marshal synchronous
work to threads rather than block the server loop on feed acknowledgements.
The standalone streaming diagnostic uses the same bridge and installation.

## Validation and remaining acceptance

Automated validation uses dummy credentials, HTTPX MockTransport and simulated
or loopback WebSocket servers. It does not contact production Kotak endpoints,
authenticate a real account, place live orders, or modify production data.

Validation results are recorded in the Phase 19 implementation entry. Coverage
includes exact v3 request signatures/bodies, returned and malformed errors,
empty reports, authentication, early/partial/terminal order events, shared
subscriptions, exchange isolation, strike rollback, reconnects, removed tokens,
re-login restoration, expired-session cleanup, binary scaling, IST timestamps,
and installer failure/idempotence behavior.

Remaining manual acceptance: run the installer on EC2 with its backend stopped;
confirm live TOTP and both streams for NIFTY/SENSEX and existing equity/options
contracts; compare full limits/order/trade/position reports with the account;
verify existing placement/modification/conversion/cancellation and fill/entry
protection only in an explicitly authorized broker acceptance environment.
Native desktop/website live click-through is not established by static checks.
