# Phase 20 — Trading performance and chart browsing

## Agreed scope and decisions

Capture analytics for website and desktop executions in Paper, Real, Stepwise,
and Replay wherever those modes already exist. Reports remain in website
Analysis → Stats. Kite broker execution, desktop real-trading enablement, a
desktop Analysis tab, and website continuous browsing are deferred.

- Use FIFO quantity splitting: entries 40 + 80, exit 60 consumes 40 + 20.
- A trade cycle is one exact contract from flat to flat. Entry positions and
  matched exit portions retain separate results. Handle shorts and reversals.
- Reuse existing labels/tags and expected/actual patterns; no mandatory rationale.
- Capture original entry intent independently of execution type and confirmed
  exit controller, including Half/Full intent and actual selected quantity.
- Capture Capital %, Risk %, fixed quantity, requested percentages/budgets,
  capital baseline, sizing stop, effective exposure and minimum-lot overruns.
- Statistics include unlabeled executions. Associated cycle results overlap
  across methods and must not be added. Missing evidence stays Unknown/null.
- Add expectancy, profit factor, distributions, fee drag, realized drawdown,
  entry-spacing/scaling/re-entry behavior, MFE/MAE, giveback and initial-risk R.
  Excursions are sampled/approximate when appropriate, never executable promises.
- Groups below 30 closed cycles or 20 distinct market dates are exploratory.
  Larger groups use 1,000 date-clustered bootstrap resamples for mean intervals.
- Desktop underlying pagination retains D−13 through D, including holidays,
  in two-calendar-date buckets. Both clients initially show up to 150 candles.
  Restored ranges and subsequent user navigation take precedence.
- Add Underlying Stoploss Half/Full using existing protected exit allocation.
- Preserve Phase 19 exact-contract identity, IST wall-clock timestamp encoding,
  provider/cache policies, broker confirmation and snapshot recovery.

## Sprints and status

| Sprint | Deliverable | Status |
|---|---|---|
| 0 | Agreed specification and baseline | Validated |
| 1 | Execution provenance and sizing capture | Implemented; automated validation passed |
| 2 | FIFO analytics and accounting corrections | Implemented; automated validation passed |
| 3 | Performance APIs and behavior metrics | Implemented; automated validation passed |
| 4 | Excursions and initial-risk analysis | Implemented; automated validation passed |
| 5 | Website Stats dashboard and drill-down | Implemented; automated validation passed |
| 6 | Desktop pagination and 150-candle viewport | Implemented; automated validation passed |
| 7 | Underlying Stoploss Half/Full and integration | Implemented; automated validation passed |

Each sprint records implementation, tests, and remaining acceptance below.
Development stays on dev; delivery PR branches target dev after review. Main
merging and deployment remain manual. Existing user requirements below are retained.

## Restart reconciliation — 2026-10-06

The laptop restart preserved the working tree on dev. All implementation files
are present; no merge/deployment has occurred. Temporary test logs and browser
screenshots were lost. The sprint table has been reconciled against code rather
than treating the older Pending entries as absent implementation.

Pre-restart validation reported 1,668 backend tests passing with two documented
Phase 19 baseline failures (stale options-expiry assertion and tab-restore fixture
missing group_id), 155 desktop/client tests, 29 website Node tests, both TypeScript
checks/production builds, native Rust tests, and dashboard browser acceptance.
Subsequent accounting/label integration changes passed 92 focused backend tests.
These historical results are checkpoints, not final validation of later changes.

Remaining work: API/database and history-page edge-case acceptance, controller and
price-path provenance review, chart navigation/viewport checks, a durable final
regression record, and PR delivery targeting dev. No live broker orders are needed
for automated checks; native Windows and real-broker acceptance remain manual.

## Sprint implementation notes

### Sprint 1 — Execution provenance and sizing

Orders and trades persist versioned analytics snapshots. Market-style LIMITs keep
Market intent; AS and ASL retain their strategy origin. A logical action groups
partial fills and broker split orders. Confirmed exit-controller history includes
strategy, requested Half/Full and actual allocation. Manual price/type edits take
ownership; quantity-only reconciliation and recovery preserve the controller.
Broker conversion provenance is published only after confirmation.

Capture Capital %, Risk %, fixed quantity, requested budget/percentage, captured
capital, sizing reference/stop/source, lot/margin information and effective filled
allocation/risk. Minimum-lot budget overruns are visible. Entry fills aggregate
actual sizing across partial fills without counting extra decisions. Reuse the
already-resolved sizing stop: analytics does not add settings reads to execution.
Session interval/brokerage, trade metadata and same-clock fill ordering survive
restart. Legacy metadata is Unknown rather than inferred from current presets.

### Sprint 2 — FIFO accounting and labels

A shared ledger handles exact-contract partial matching, shorts and reversals.
Entry and exit fees follow matched quantity; remaining entry fees stay with open
inventory. Session summaries no longer classify open purchases as realized losses.
Real summaries use individual executions from a pinned committed projection,
with order/execution membership, quantity/value and revision consistency checks.
Exchange, product, strike and expiry stay separate; real aliases count once.

Label round trips use the same ledger. New labels store stable cycle identities;
legacy labels are attached only when entry/exit memberships and quantities agree.
DynamoDB pagination and ownership checks cover the analysis/label boundaries.
Metadata Decimals are normalized before arithmetic. No historical records are
bulk-rewritten; provenance reconstruction uses stored evidence only.

### Sprint 3 — Performance and behavior APIs

- `GET /api/analysis/performance`: summaries, comparisons, distributions,
  daily results, realized drawdown, behavior groups, coverage and insights.
- `GET /api/analysis/performance/cycles`: paginated cycle drill-down.
- `GET /api/analysis/performance/cycles/{cycle_id}`: owned detail, with optional
  cached-price enrichment and the owning session ID.

Filter dates, mode, client, symbol, instrument, direction, entry/exit methods,
sizing/percentage, existing tags/strategies and data quality. Method/origin/sizing
filters select containing cycles, retaining their other actions for whole-cycle
context. Associated cycle results overlap and are not additive.

Measure expectancy, win/loss/breakeven, profit factor, mean/median P&L, capital
contribution and initial-risk R where available. Behavioral groups cover counts,
strategy-bar spacing, relative addition size, contemporaneous addition P&L,
rapid re-entry, size after losses, daily trade sequence, weekday, half-hour and
holding duration. Partial fills and order splits are not discretionary decisions.
Use bounded fingerprinted result caching, worker execution and date-clustered
intervals. Read failures produce errors, not successful empty statistics.

### Sprint 4 — Price-path quality

Lazy enrichment reads cached exact-contract Breeze/Kite/Kotak data without
broker polling or automatic downloads. Fresh provider caches preserve observed
versus gap-filled rows. Legacy native-minute caches are sampled candles; old
Breeze caches without observation provenance remain unavailable for excursions.
Exclude ambiguous boundary bars and filled gaps. Report provider, resolution,
coverage and sampled/unavailable status for matched portions and the changing
cycle inventory. Preserve the initial sizing stop rather than rewriting risk
from a later trailing stop. Fees remain the application's existing estimates;
this phase does not reconcile broker contract notes or change charge schedules.

### Sprint 5 — Website Stats

Overview, Entries, Exits, Sizing and Behavior share filters, sortable tables,
linked charts, calendar, entry→exit combinations, distributions and a sizing
scatterplot. Rows show position attribution separately from associated-cycle
outcomes. Half/Full, existing labels, coverage and small-sample badges are visible.
Trade details include sizing, fees, FIFO portions, R, optional execution charts
and sampled price paths. CSV exports the filtered cycles. Insights describe
observed associations and never assert random/revenge intent.

### Sprint 6 — Desktop history and viewport

`GET /api/desktop/v1/historical/underlying-pages` scans at most two calendar dates
before its cursor within D−13..D, including holidays. Failures are explicit and
retryable. Desktop uses the existing authenticated request transport and history
workers, KLineCharts' prepend loader, stale-request fencing and separate older
context. Live refreshes retain that context. The history cache is bounded to
32 entries/100,000 aggregate candles with ten-minute expiry and failed-promise
removal. Live anchoring uses the current IST date; Replay/Browse uses its selected
date. Options/futures do not gain continuous paging.

Both clients initially display at most 150 available bars without reducing fetched
data. Saved website ranges take precedence; subsequent navigation is preserved.
Explicit Fit still shows all loaded data. Desktop native initial history now honors
the configured context-day count rather than always requesting five days.

### Sprint 7 — Underlying Stoploss Half/Full

Persist `underlying_stoploss_size`, default Full. Both clients expose Half/Full
and armed size editing through the existing shared controls. Half uses Phase 19's
protected allocation, rounding and recovery rules; even one lot selects one lot.
Remaining protection, manual reductions and retry fencing stay intact. Analytics
records requested size separately from actual quantity and closed fraction.

## Validation artifacts and reproduction

Logs, JSON fixtures and regenerated screenshots are kept on disk in
`.cache/phase20-validation/` (ignored by Git). The specification records durable
results below. All automated browser/provider checks use synthetic or mocked data.

Backend checks use `~/venvs/tradematangi/bin/python -m pytest backend/tests/ -q`
with `USE_DYNAMODB_LOCAL=true AWS_MAX_ATTEMPTS=1`. Both clients run TypeScript
checks and Vite production builds. Desktop tests use Vitest; website accounting
checks use `node --test src/*.test.mjs src/services/*.test.mjs`. Native checks use
`cargo test --offline --manifest-path windowsapp/src-tauri/Cargo.toml`.

Browser checks are reproducible with `scripts/phase20-browser-check.mjs` and
`scripts/phase20-chart-check.mjs`. Install playwright-core outside the project,
then supply its module through `PLAYWRIGHT_MODULE`, the project venv through
`PYTHON_BIN`, and optionally `CHROME_BIN` and `PHASE20_ARTIFACT_DIR`. No runtime
browser-testing dependency was added. The existing chart soak script also runs
with synthetic prices; a short accelerated run is not a long market-hours soak.

## Final automated validation — 2026-10-06

| Check | Result |
|---|---|
| Full backend suite with DynamoDB Local running | **1,685 passed / 2 baseline failures** |
| Final focused accounting/API/order/strategy/desktop regressions | **351 passed** |
| Desktop/client Vitest | **155 passed**, 25 files |
| Website Node accounting/history checks | **29 passed** |
| Website and desktop TypeScript / production builds | Passed |
| Native Rust tests on Linux | **16 passed** |
| Actual desktop chart browser acceptance | Passed: 375 retained bars / 144 visible initially; 100 prepended; one request; overlay and viewport survive a live append; refresh returns to 144 latest visible bars |
| Website Stats browser acceptance | Passed: five views, detail, unavailable excursions, CSV, narrow viewport and close; no page errors |
| Synthetic four-chart accelerated soak | Passed for one simulated minute; no failures; sampled JS heap about 5.15 → 6.10 MB |
| Diff whitespace check | Passed |

The two remaining failures are the existing stale expiry assertion in
`test_options_api.py` and missing `group_id` in `test_tab_restore.py`. Before
DynamoDB Local was restarted, four additional environment-dependent failures
occurred; all six reproduced against unchanged dev commit `80fb0a5`. Starting
DynamoDB resolved those four, leaving the established two-fixture baseline.
The final focused run covers the final sizing-metadata/latency refinements and
prepared-Half allocation size-edit fence after the full-suite checkpoint. Existing bundle-size/dateutil/pytest-marker
warnings and pandas observation-column downcasting warnings remain visible.

`summary.json`, complete logs and all regenerated screenshots are available in
`.cache/phase20-validation/`. Browser scripts regenerate artifacts there by default.
No live orders, broker credential changes, main merges or deployment were performed.

### Remaining manual acceptance and operating limits

- Native Windows packaging/interaction, pop-out/refresh/reconnect, 14-date browsing
  with real cache/provider availability, and persisted drawings across sessions.
- Authorized existing website real-trading acceptance for confirmed conversion,
  partial fills, FIFO refresh and Underlying Stoploss Half remainder protection.
- Excursions require cached observations; missing, legacy gap-filled or ambiguous
  boundary data stays unavailable. Native minute candles are sampled, not ticks.
- Statistical associations do not establish causality or psychological intent.
  Current estimated fees, capital snapshots and historical lot-size limitations
  retain their existing meanings. An underlying stop is not converted into a
  fictional option-risk amount.
- Website continuous browsing, desktop Analysis UI, Kite broker execution and
  desktop real-trading enablement remain deferred as agreed.

### Delivery

Implementation was completed on dev. Delivery uses a dedicated
`feature/phase20-trading-analytics` branch targeting dev; review precedes merge.
Main merging and deployment remain manual.

Delivery: [PR #599](https://github.com/prattyush/TradeMatangi/pull/599),
`feature/phase20-trading-analytics` → `dev`. Implementation commit `e3c66ed`;
review/merge and the manual acceptance checks above remain pending.

## Baseline and research

Current dev already includes PRs #568, #570, #588, #595 and #597 despite older
Phase 19 delivery paragraphs recording pending merges. FIFO position tests:
10 passed. Existing analysis reports an unclosed purchase as a realized loss;
round-trip grouping also misses the closed half of a reversal. Legacy Stats
reads only saved labels rather than all executions.

Synthetic 5,250 OHLC objects used about 0.7 MB for one Node array and 3.3 MB
for four additional copies, excluding charts/canvas/indicators/React. This is
not a browser memory acceptance test. Website continuous browsing is deferred.

Sources informing the design:
- [TradingView expectancy](https://www.tradingview.com/support/solutions/43000772770-expected-payoff/)
- [TradingView performance measures](https://www.tradingview.com/support/solutions/43000681733-overview-tab/)
- [Fidelity MAE/MFE and drawdown definitions](https://www.fidelity.com/research/backtesting/glossary.html)
- [CME risk management](https://www.cmegroup.com/education/courses/building-a-trade-plan/risk-management-and-your-trade-plan)

## Original requirements

# Upgrades

## Desktop Client Continuous browse
1) In desktop client, when going through charts for any mode (browse, live, replay, stepwise), and only for underlying charts, not for options or futures, if the user goes to the end of the chart on the left side, first candle drawn. The desktop client should automatically fetch the data for previous days, upto 14 Days. This helps in desktop only as, we have more memory compared to website, or if is possible in website as well, please go ahead and do it, but primary requirement is for destkop only, as the lines and drawings are saved which can come in handy. Further, 14 days helps to look into previous weekly high and low which is important. By 14 days I didn't mean 14 trading days, I meant 14 days which can include holidays.

Include this feature for website, if it is simple otherwise leave it. When fetching and drawing on chart, you can fetch in buckets, like fetching 1 day at a time or 2 days at a time, till the user keeps going back and at max 14 days data is fetched. This is because for smaller intervals, user may not go to back 14 days, but for 15 mins, 14 days makes more sense.

2) Separate, requirement, do, handle the case in website, as website draws all the candles on the screen, when refreshed, which may become a lot for 1 min candle, so maybe when refreshed it can only shows x number of candles, 150 candles in the view and rest can be scroolled. This 150 candle apply to desktop as well, if possible, only for first draw or refresh etc. It is max 150 just on view not backend fetch data. Not sure the complication of this requirement.


Don't implement continuous browse for website if it requires significant memory increase. Please discuss it first with some stats.


## Analytics Upgrade

### Order Info For Analytics
For each postion entry and exit we need to store how that particular position was entered or exited. Like for Entry we need to keep the information whether that entry was triggered by Market Order, Limit Order, Target Order, Auto Stop Order (Though Auto Stop results in Target Order, if Auto Stop needs to be stored), Auto Stop Limit Order.

Similarly for Exit Orders, we need to store per order, whether that particular order was Stoploss Order Exit, Limit Order Exit, Aggresive SL Order Exit, Target Profit Strategy Full Order Exit,  Target Profit Strategy Half Order Exit, Underlying Target Strategy Half Order Exit, Underlying Target Full Order Exit and similarly for Underlying SL (full and half exits).


### Analytics On Order Info
Now, a trade is different than a particular position. In one trade I can take 2 positions and exit one in some way and another in other way. While exitting I think, we take FIFO logic, for first exit would be for last entry, I am fine with that if quantities are same, if quuantities don't match, find a position in that trade that matches in quantity, if exit quantity is either low or high and doesn't match then match to last entry with min of (exit, entry) and use it in analytics.

#### Stats On Entries
The stats windows needs to show per position, the breakdown of enter position types (based on previous section (Order Info of Analytics) values) against Profit and Loss % of that position and also the entire trade. What I mean lets say for one trade, we have 2 positions with Auto Stop entry with 100 quantity, the exit was in 2 ways, or total 100 quantity exit was in order, one in profit (40) and one in loss (60), then calculate actual profit and loss combined and calculate % against session capital. Also, in the same example, lets say 2nd entry was market order and the entire trade was in profit, but Auto Stop Order was in Loss Exit, when matched with FIFO logic or quantity match logic. Then, also show stat of Auto Stop entries against its own position profit and loss % and trade level profit and loss %.

You have aggregate across days and may be within a day, so you can show aggregate, sum, mean and median to get an idea of distribution or show histogram etc.

#### Stats On Exits
The stats window also needs to show similar stats for exit trades as well, I mean whether take profit is more profitable or aggresive SL , similar to previous section (Stats On Entries), you can show per position P&L and also trade level P&L.


#### Stats On Entries/Exit Count
Also, need stats on entry and exit counts in one trade and the result of those trades P&L % etc. Can you also give me stats whether I am entering too less gap or entries in same bar, bar interval length is counted from settings, strategy candle interval. If the entries vary in % entries w.r.t to sizes and whether that result in profit or losses, P&L in count of trades and also % in losses or profits.

## Kite Broker For Real Trading
Supporting Kite for Real Trading API's, all the their is feature parity with Kotak Neo. With exactly the same implementation.

## Supporting Real Trading In Desktop Client
Support Real Trading in Desktop Client, with same support as with Website Real Trading, like trade history refresh button and others.



## Always-enabled entry protection follow-up — 2026-10-06

The user observed two website Replay NIFTY option Market entries, submitted through
right-click Use as SL with Risk %, filling without protective stops. Inspection
and reproduction found the non-real website fill watcher consulting
`entry_auto_sl_enabled`, default False; a disabled setting silently skipped the
explicit attached stop. That gate predates Phase 20 (introduced in September;
real-mode exemption in Phase 19), rather than originating in analytics changes.

The final requested scope retires this enable switch from **both website and
desktop settings** and keeps the existing enabled behavior for every user. Entry
SL requests and AutoStop fallback protection are always processed on fills.
Original price selection/AutoStop fallback and configured real-trading delay are
retained. Risk sizing alone still does not become an attached-stop instruction;
this change removes the account opt-out rather than inventing new entry-price rules.

Backend compatibility responses report the legacy field as True. Stored False
values and writes from older clients cannot disable protection; unrelated settings
and the real-trading delay are preserved. No bulk account migration is needed.
The website no longer reads the stale localStorage flag, and the desktop settings
field catalogue no longer includes the enable toggle. Delay remains configurable.

Regression coverage includes the reported September 15 replay path for both CE
and PE: two risk-sized marketable LIMIT fills produce separate same-contract
stoplosses with the exact selected stop prices and quantities; the SSE order events
are present; another strike cannot fill them; a matching price crossing closes the
position. Settings tests cover previously disabled users and older-client writes.
Automated checks use synthetic replay prices and mocked broker/database paths;
no real broker orders are submitted.

Confirmed scope: website left-panel orders may open positions without an SL.
Selecting Use as SL or attaching an explicit SL must always protect that filled
entry. The unchanged AS/ASL fallback is 25% from fill price when those strategies
have no supplied SL; it does not extend to ordinary entries without an SL.

Validation: **1,697 backend tests passed / 2 existing failures** (the stale
options-expiry assertion and missing `group_id` tab-restore fixture). **296 focused
regressions**, **155 desktop/client Vitest checks**, **29 website Node checks**,
both TypeScript checks and both production builds passed. Mocked browser
acceptance verified both Trading settings panels have no enable switch and retain
a saved seven-second real-trading delay, with no browser errors. Logs/screenshots
are retained in `.cache/replay-entry-stoploss-validation/`.

Delivery targets dev through a dedicated `fix/always-enabled-entry-stoploss`
branch. Update the backend and both clients together. Review/merge, main deployment
and authorized native Windows/live-broker acceptance remain separate manual steps.
Delivery: [PR #601](https://github.com/prattyush/TradeMatangi/pull/601),
`fix/always-enabled-entry-stoploss` → `dev`, implementation commit `fc90c87`.
Review/merge and manual main deployment remain pending.

## Website floating messages and error history — 2026-10-07

The user reported distracting chart movement when top-level order/broker/exit
protection/conversion banners appeared and disappeared during real trading.
Website messages now use a fixed floating stack rather than consuming chart layout
space. There is no backdrop, focus steal, sound or slide animation. At most three
flashes appear in the lower-right corner; errors/warnings dismiss after eight
seconds and informational/success messages after five. Users can dismiss them.
Actual guardrail interventions and order confirmation state retain their meaning.

A fixed message-history icon opens a nonmodal panel. Keep the latest 100 messages
per account/backend in this browser for seven days, including actual receipt time
(displayed in IST), severity/source, session/symbol/mode when available, repeated
occurrence counts and unread error/warning badge. Opening history does not stop or
resize charts. Support errors/warnings filtering, mark-read, confirmed clear, and
JSON download. Closing/expiring a flash does not delete its history. Reload restores
history without replaying flashes; logout/account/server changes isolate history.
Storage failures retain in-memory notification functionality.

Website API rejections, trading/local validation errors, recording errors, caught
chart rendering errors and uncaught browser errors/rejections enter the same
journal. Expected missing saved patterns/active-session lookups and aborted requests
are not errors. Duplicate API/panel reporting is suppressed; repeated identical
messages within 30 seconds update history counts without restarting dismissed
flashes. Request errors capture the originating session context and obsolete account
responses cannot populate another account's journal. Storage writes are batched
outside the user-action callback and flushed on page hide/account change.

Recovery needs-attention is a warning; pending/restored states are informational/
success. Broker conversions are informational while awaiting confirmation, warnings
when unknown or replacement is unconfirmed, errors when failed and success when
confirmed. The order row still identifies its pending conversion and keeps the last
broker-confirmed type. The notification change does not assume broker success or
change recovery, order routing or real trading behavior.

Broker recovery/conversion errors already have backend logs, including
`protection_recovery` and `broker_conversion`. Browser-only validation/network/
rendering errors are now retained in browser history; this is not a new server audit
log or cross-device history. No broker credentials or raw event payloads are added.

Validation: 37 website Node tests (including eight new journal tests), website
TypeScript/production build, and 155 existing desktop/client tests passed.
`scripts/website-notification-check.mjs` provides synthetic browser acceptance with
Playwright installed externally through PLAYWRIGHT_MODULE. It verifies three
severities, unchanged real chart geometry and instance on show/dismiss/expiry,
chart interaction, IST/context/history/download, reload without replay, account
isolation, narrow history layout, API error capture, expected 404 suppression and
late-account failure fencing, with no page errors. Artifacts are ignored in
`.cache/website-notification-validation/`. No backend code changes or live orders.
The existing production bundle-size warning remains. Backend/full-suite and live
broker acceptance are not claimed for this UI-only change.

Development on dev; deliver in a dedicated feature branch/PR targeting dev.
Review/merge and manual main deployment remain pending. Desktop Analysis work is
still preserved separately on `wip/phase20-desktop-analysis` and is not included.

Delivery: [PR #603](https://github.com/prattyush/TradeMatangi/pull/603),
`feature/website-floating-error-history` → `dev`, implementation commit `f624e6a`.
Review/merge and manual main deployment remain pending.

## Website emergency exits and manual real-day ban — 2026-10-07

### Agreed behavior

- **Exit all now** closes only the selected session's open contracts/positions,
  including CE/PE, older strikes/expiries, equity and shorts. It is a one-click
  urgent order action, not a fill guarantee. Use LIMIT SELL 3% below a fresh quote
  for longs, LIMIT BUY 3% above for shorts, tick-aligned independently of normal
  Market/Target gap settings. Keep normal quote/provider/contract identity rules.
- **Done for day** appears only in Real mode. After explicit confirmation, block
  new real entries while requesting exits for the user's real sessions for today.
  Cancel entry orders and strategies, preserve existing protection, use the same
  emergency exit path, and mark **done** only after coherent broker confirmation
  of flat positions and no pending orders. Aliases of a broker book exit once.
- The final ban is user-wide for the current IST calendar date. It persists across
  logout/reconnect/session restart/backend restart. There is no UI, settings,
  whitelist/admin action or API endpoint to clear it. A new IST date uses a new
  record. Paper, Replay and Stepwise remain unaffected.
- While closing, risk-reducing exits/protection can finish. After done, no new real
  order execution is allowed, including an old view whose position appears stale.
  The status is monotonic within a day: delayed HTTP responses cannot revert
  closing/done SSE status, and an old-day status cannot replace the new day.

### Implementation and failure behavior

`POST /api/trades/sessions/{session_id}/exit-all` is owned/session-scoped.
`POST /api/trades/sessions/{session_id}/done-for-day` requires an owned real session
and initiates the user-wide day closure. `GET /api/trades/real-day-status` reports
active/closing/done and resumes monitoring an unfinished closure after reattachment.
There is deliberately no unlock route or writeable day-state request parameter.

`emergency_exit` uses existing exact-contract positions and broker-confirmed
conversion workers. Convert/reprice existing closing orders first, retain their
coverage while confirmation is pending, and create only uncovered quantity. Re-read
positions/remaining fills before each additional chunk; respect freeze splitting,
short covers and duplicate-click fencing. Process contracts independently and report
partial failures. Existing uncertain conversions/acknowledgements do not justify
another full-position exit. Do not change realized positions/P&L before actual fills.

Real quotes must be fresh for the exact contract, including older strikes. Missing
quotes, mismatched coverage, unsupported products and broker errors are explicit
needs-attention results. A real submission is persisted before contacting Kotak;
SDK/transport uncertainty reserves its quantity and is excluded from local tick
execution. An explicit rejection is distinct from uncertainty. Tagged submissions
retain evidence for broker investigation; retry cannot blindly duplicate an unknown
exit. Existing MIS placement support is retained. Practice limits fill when their
supported engine next processes a matching price; paused/stepwise charts do not
invent an immediate execution.

The day state is stored separately from resettable session guardrails/settings in
`WalletLedgers`, keyed by user and `real-day-lock:<IST date>`, with conditional
active→closing→done progression. Closing is persisted before exit requests. Existing
entry/forwarding/strategy/start paths enforce the day barrier using server state,
not client booleans. Failures to verify the lock block new entries; protective
closures can continue during storage outage, while known done state rejects orders.
Normal settings edits, session override flags and permission changes do not clear
this record. No per-tick database polling is added for ordinary market data.

Day-completion monitoring does not call an acknowledgement a fill. It uses existing
broker orders/executions/positions reconciliation before committing done. Pending
orders, uncertain submissions, inconsistent reports or failed verification leave
closing/needs-attention, with new entries still blocked. No automatic duplicate
submission is used to force progress. No backend shutdown/revocation of shared
broker credentials is introduced. Broker trading outside this application is not
controlled by this user lock.

Both website actions use floating feedback/history. Labels distinguish requesting
exits, closing for day and done; charts remain in place. The day confirmation is an
explicit user action, and there is no unlock control. The desktop Flatten button and
its existing normal real-market gap behavior are unchanged.

### Validation and delivery

- Full backend: **1,721 passed / 2 documented baseline failures** (stale options
  expiry assertion and tab-restore fixture missing group_id).
- Focused existing execution/conversion/recovery/desktop plus initial new tests:
  **288 passed**. Final day/protection/strategy/emergency regressions: **115 passed**.
- Website accounting/history/journal checks plus four monotonic day-state tests:
  **41 passed**. Website and desktop TypeScript/production builds passed with their
  existing bundle-size warnings.
- Synthetic browser acceptance via `scripts/website-safety-check.mjs`: selected
  session endpoint only, Real-only day action, confirmation before submission,
  closing until completion, disabled done state, Paper/Stepwise unaffected, stable
  chart geometry and floating feedback, with no page errors.
- New backend coverage exercises aggressive long/short prices, partial protection
  plus uncovered remainder, repeated requests, exact old contract enumeration,
  per-contract failure isolation, real timeout versus rejection, ownership, day
  persistence/rollover, mode isolation, no premature completion on report failure,
  user-wide real-only scope, alias deduplication and protection during storage outage.

Artifacts/logs are ignored under `.cache/website-safety-validation/`. All broker
checks use mocks; no live broker orders were placed. Native/live broker acceptance
still requires authorized manual checks of exact-contract/freeze orders, pending
conversion, partial fills, unknown acknowledgements and day closure/restart.
Development is on dev; deliver in a dedicated reviewed PR targeting dev. Main merge
and deployment remain manual. Desktop Analysis WIP remains separate.

Delivery: [PR #605](https://github.com/prattyush/TradeMatangi/pull/605),
`feature/website-emergency-exit-day-ban` → `dev`, implementation commit `dbcfb53`.
Review/merge, authorized live acceptance and manual main deployment remain pending.

### Compact website chart entry ticket follow-up — PR #605

At the user's request, the website right-click Use as SL ticket now shows order
choices on the left and sizing on the right in one window, replacing the type→size
navigation and Back button. Reduce ticket and chart-context-menu text to 10px
(ticket heading 11px, hints 9px). Keep both columns visible while selecting.

Type-first and size-first are supported: submit when the second selection is made,
through the existing Market/Limit/Target/AS/ASL handler. Buy/Sell selection remains
available where configured; sizing choices wait for a direction. Capital/Risk is
local to this ticket, and switching it clears the prior size selection so a changed
preset cannot submit accidentally. Fixed quantity and saved percentage values retain
their existing units. Preserve clicked stop price, exact contract, minimum-lot hint,
Limit/Target price-pick behavior, outside-click/Escape and explicit close. The ticket
is fixed-position, measured/clamped within the viewport, and does not resize charts.

Validation: website TypeScript/build and 41 Node checks passed. Synthetic production
component acceptance in `scripts/website-entry-ticket-check.mjs` exercises left/right
layout/no Back, Market type-first Risk %, ASL size-first Risk %, AS Capital %, clearing
selection on mode switch, Sell fixed-quantity Limit, exact stop/contract preservation,
close and narrow viewport clamping without page errors. Artifacts are ignored under
`.cache/website-safety-validation/`. No broker orders or backend changes in this
follow-up. Included in the existing PR #605, not a separate delivery.

## Real analytics numeric-metadata repair — 2026-10-07

The user supplied a production trace where a successful broker snapshot publication
(193 orders / 148 trades) was followed by round-trip calculation failure in
`execution_analytics.filled`: float arithmetic multiplied a sequence-valued
`margin_rate`. The reproduced path is DynamoDB Decimal analytics loaded into an
Order's untyped analytics dictionary, then serialized with `model_dump(mode="json")`.
Pydantic serializes those Decimals as strings; the old broker snapshot encoder
persisted the strings, while the old metadata normalizer only handled Decimals.

Normalize numeric strings for known arithmetic fields (capital, margin, stop,
budget, percentages, quantities, controller/quote timestamps and related captured
numbers). Preserve numeric-looking IDs, labels, methods and contract text as strings.
Normalize before confirmed-controller history filtering as well as fill calculations,
including decimal-form timestamp strings. Future snapshot encoding restores numeric
analytics fields to DynamoDB numbers rather than persisting JSON numeric strings.
Both paths work with already-stored records, without a historical rewrite/migration.

Blank optional numeric evidence stays null. Invalid/nonfinite numeric strings raise
an explicit field-named data error rather than producing invented zero statistics.
Metadata inputs are copied, not mutated. This repair changes analytics serialization/
reading, not broker order placement, contract matching, fees, wallet quantities or
IST timestamp encoding. The quoted trace identifies the round-trip read failure;
it does not by itself establish a broker execution/protection failure.

Validation: **44 focused analytics/API tests passed**, including a database-backed
real individual-execution projection with stored numeric strings and decimal-form
controller timestamps. That fixture now produces its FIFO round trip, net P&L and
initial-risk R through `compute_round_trips_for_session`, the function in the user's
trace. **172 analytics/broker-snapshot/execution-gap/conversion/recovery regressions
passed**; existing dateutil warnings remain. Full-suite results and delivery follow
below. All broker paths in validation are synthetic/mocked, with ignored logs under
`.cache/analytics-numeric-metadata-validation/`; no live orders or deployment.

Final full backend validation: **1,728 passed / 2 existing baseline failures**
(stale options-expiry assertion and missing group_id in tab-restore fixture).
Development completed on dev; delivery is through a dedicated fix branch targeting
dev. Review/merge and manual backend deployment remain separate steps.
